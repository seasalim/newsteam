#!/usr/bin/env python3
"""Read-only feed inspection handler — list, check, and status.

Designed for testability: all logic lives in handle() with injectable paths
and clock.  The module-level stdin/stdout glue is minimal.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_FEED_CHECK_SCRIPT = ROOT_DIR / "scripts" / "feed-check.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def relative_time(iso_str: str, now: datetime) -> str:
    """Convert an ISO 8601 timestamp to a human-readable relative string."""
    if not iso_str:
        return "unknown"
    try:
        target = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return "unknown"
    delta = target - now
    total_seconds = delta.total_seconds()
    if total_seconds <= 0:
        return "overdue"
    minutes = int(total_seconds // 60)
    if minutes < 60:
        return f"{minutes} min"
    hours = int(minutes // 60)
    if hours < 24:
        return f"{hours} hr"
    days = int(hours // 24)
    return f"{days} day{'s' if days != 1 else ''}"


def invoke_feed_check(
    payload: Dict[str, Any],
    script_path: Path = DEFAULT_FEED_CHECK_SCRIPT,
) -> Dict[str, Any]:
    """Run feed-check.py as a subprocess and return parsed JSON."""
    try:
        proc = subprocess.run(
            [sys.executable, str(script_path)],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=14,
            check=False,
        )
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", errors="replace").strip()
            return {"error": stderr or f"feed-check.py exited with code {proc.returncode}"}
        return json.loads(proc.stdout.decode("utf-8"))
    except subprocess.TimeoutExpired:
        return {"error": "feed-check.py timed out"}
    except (json.JSONDecodeError, OSError) as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def action_list(feeds_path: Path) -> Dict[str, Any]:
    feeds = load_json(feeds_path, [])
    if not isinstance(feeds, list):
        feeds = []

    items: List[Dict[str, Any]] = []
    for f in feeds:
        if not isinstance(f, dict) or not f.get("id"):
            continue
        entry: Dict[str, Any] = {
            "id": f["id"],
            "name": f.get("name", f["id"]),
            "type": f.get("type", "rss"),
            "interval_min": f.get("check_interval_minutes", 60),
        }
        if f.get("type") == "rss" and f.get("url"):
            entry["url"] = f["url"]
        items.append(entry)

    count = len(items)
    return {
        "ok": True,
        "feeds": items,
        "count": count,
        "message": f"{count} feed{'s' if count != 1 else ''} configured.",
    }


def action_status(
    feeds_path: Path,
    state_path: Path,
    now: Optional[datetime] = None,
    script_path: Path = DEFAULT_FEED_CHECK_SCRIPT,
) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    result = invoke_feed_check({
        "action": "status",
        "feeds_path": str(feeds_path),
        "state_path": str(state_path),
    }, script_path=script_path)

    if "error" in result:
        return {"ok": False, "error": "script_error", "message": result["error"]}

    feeds: List[Dict[str, Any]] = []
    overdue_count = 0
    for f in result.get("feeds", []):
        next_check = relative_time(f.get("next_due_at", ""), now)
        if next_check == "overdue":
            overdue_count += 1
        feeds.append({
            "id": f.get("feed_id", ""),
            "name": f.get("feed_name", ""),
            "next_check": next_check,
            "seen_count": f.get("seen_count", 0),
        })

    n = len(feeds)
    parts = [f"{n} feed{'s' if n != 1 else ''} active."]
    if overdue_count:
        parts.append(f"{overdue_count} overdue.")

    return {
        "ok": True,
        "feeds": feeds,
        "message": " ".join(parts),
    }


def action_check(
    args: Dict[str, Any],
    feeds_path: Path,
    state_path: Path,
    script_path: Path = DEFAULT_FEED_CHECK_SCRIPT,
) -> Dict[str, Any]:
    feed_id = args.get("feed_id")
    if isinstance(feed_id, str):
        feed_id = feed_id.strip().replace("_", "-")
    payload: Dict[str, Any] = {
        "action": "peek",
        "feeds_path": str(feeds_path),
        "state_path": str(state_path),
    }
    if feed_id:
        payload["feed_id"] = feed_id

    result = invoke_feed_check(payload, script_path=script_path)

    if "error" in result:
        return {"ok": False, "error": "check_failed", "message": result["error"]}

    new_items = result.get("new_items", [])
    feeds_checked = result.get("feeds_checked", 0)
    feeds_skipped = result.get("feeds_skipped", 0)

    # Build human-readable message
    if feed_id and not new_items:
        # Resolve feed name for a nicer message
        feeds = load_json(feeds_path, [])
        name = feed_id
        if isinstance(feeds, list):
            for f in feeds:
                if isinstance(f, dict) and f.get("id") == feed_id:
                    name = f.get("name", feed_id)
                    break
        message = f"Nothing new from {name}."
    elif not new_items:
        message = f"Nothing new across {feeds_checked} feed{'s' if feeds_checked != 1 else ''}."
    else:
        n = len(new_items)
        message = (
            f"{n} new item{'s' if n != 1 else ''} across "
            f"{feeds_checked} feed{'s' if feeds_checked != 1 else ''} checked. "
            f"(Read-only — scheduler not affected.)"
        )

    # Flatten output items for Haiku
    flat_items = [
        {
            "feed_name": item.get("feed_name", ""),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("snippet", ""),
        }
        for item in new_items
    ]

    return {
        "ok": True,
        "new_items": flat_items,
        "feeds_checked": feeds_checked,
        "feeds_skipped": feeds_skipped,
        "message": message,
    }


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def handle(
    args: Dict[str, Any],
    feeds_path: Optional[Path] = None,
    state_path: Optional[Path] = None,
    feed_check_script: Path = DEFAULT_FEED_CHECK_SCRIPT,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    action = args.get("action", "")

    if action not in ("list", "check", "status"):
        return {
            "ok": False,
            "error": "unknown_action",
            "message": f"Unknown action: {action}. Use: list, check, status",
        }

    if feeds_path is None:
        persona_dir = os.environ.get("NEWSTEAM_PERSONA_DIR", "").strip()
        if not persona_dir:
            return {
                "ok": False,
                "error": "missing_tool_context",
                "message": "Feed paths were not provided by the NewsTeam runtime.",
            }
        base_path = Path(persona_dir).resolve()
        feeds_path = base_path / "feeds.json"
        state_path = base_path / "feeds_state.json"
    elif state_path is None:
        state_path = feeds_path.with_name("feeds_state.json")

    if action == "list":
        return action_list(feeds_path=feeds_path)
    elif action == "check":
        return action_check(args, feeds_path=feeds_path, state_path=state_path, script_path=feed_check_script)
    elif action == "status":
        return action_status(feeds_path=feeds_path, state_path=state_path, now=now, script_path=feed_check_script)

    raise AssertionError("validated feed action was not dispatched")


def handle_from_runtime(args: Dict[str, Any]) -> Dict[str, Any]:
    return handle(args)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        input_args = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_args = {}
    print(json.dumps(handle_from_runtime(input_args)))
