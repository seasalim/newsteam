#!/usr/bin/env python3
"""Check configured feeds for new items and persist feed state."""

from __future__ import annotations

import html
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


USER_AGENT = "Newsteam/1.0 (+https://github.com/seasalim/newsteam)"
ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_FEEDS_PATH = ROOT_DIR / "persona" / "feeds.json"
DEFAULT_STATE_PATH = ROOT_DIR / "persona" / "feeds_state.json"


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.parts.append(html.unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        self.parts.append(html.unescape(f"&#{name};"))

    def get_text(self) -> str:
        return "".join(self.parts)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, IndexError):
        return None


def normalize_timestamp(value: Any) -> str:
    parsed = parse_datetime(value)
    if parsed is None:
        return value.strip() if isinstance(value, str) else ""
    return format_datetime(parsed)


def strip_control_chars(value: str) -> str:
    return "".join(ch for ch in value if ch == "\n" or ord(ch) >= 32)


def html_to_text(value: str) -> str:
    extractor = _HTMLTextExtractor()
    try:
        extractor.feed(value)
        extractor.close()
        text = extractor.get_text()
    except Exception:
        text = value
    return text


def sanitize_snippet(value: Any, max_length: int = 600) -> str:
    if value is None:
        return ""
    text = str(value)
    text = html.unescape(text)
    text = html_to_text(text)
    text = strip_control_chars(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_length:
        return text[:max_length]
    return text


def sanitize_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if text.startswith("http://") or text.startswith("https://"):
        return text
    return ""


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def child_text(element: ET.Element, name: str) -> str:
    for child in element:
        if local_name(child.tag) == name:
            return "".join(child.itertext()).strip()
    return ""


def find_atom_link(entry: ET.Element) -> str:
    alternate = ""
    for child in entry:
        if local_name(child.tag) != "link":
            continue
        href = sanitize_url(child.attrib.get("href", ""))
        if not href:
            continue
        rel = child.attrib.get("rel", "alternate")
        if rel == "alternate":
            return href
        if not alternate:
            alternate = href
    return alternate


def parse_rss_items(root: ET.Element) -> List[Dict[str, str]]:
    channel = None
    if local_name(root.tag) == "rss":
        for child in root:
            if local_name(child.tag) == "channel":
                channel = child
                break
    elif local_name(root.tag) == "channel":
        channel = root
    if channel is None:
        raise ValueError("RSS channel not found")

    items: List[Dict[str, str]] = []
    for item in channel:
        if local_name(item.tag) != "item":
            continue
        guid = child_text(item, "guid")
        link = sanitize_url(child_text(item, "link"))
        item_id = guid or link
        if not item_id:
            continue
        items.append(
            {
                "id": item_id,
                "title": child_text(item, "title"),
                "url": link,
                "published": normalize_timestamp(child_text(item, "pubDate")),
                "snippet": sanitize_snippet(child_text(item, "description")),
            }
        )
    return items


def parse_atom_items(root: ET.Element) -> List[Dict[str, str]]:
    entries = [child for child in root if local_name(child.tag) == "entry"]
    if not entries and local_name(root.tag) != "feed":
        raise ValueError("Atom feed root not found")

    items: List[Dict[str, str]] = []
    for entry in entries:
        entry_id = child_text(entry, "id")
        link = find_atom_link(entry)
        item_id = entry_id or link
        if not item_id:
            continue
        snippet = child_text(entry, "summary") or child_text(entry, "content")
        published = child_text(entry, "published") or child_text(entry, "updated")
        items.append(
            {
                "id": item_id,
                "title": child_text(entry, "title"),
                "url": link,
                "published": normalize_timestamp(published),
                "snippet": sanitize_snippet(snippet),
            }
        )
    return items


def parse_feed_bytes(raw_bytes: bytes) -> List[Dict[str, str]]:
    try:
        root = ET.fromstring(raw_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"parse failed: {exc}") from exc

    root_name = local_name(root.tag).lower()
    if root_name == "feed":
        return parse_atom_items(root)
    if root_name in {"rss", "channel"}:
        return parse_rss_items(root)
    raise ValueError(f"unsupported feed root: {root.tag}")


def load_json_file(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def load_feed_registry(path: Path) -> List[Dict[str, Any]]:
    data = load_json_file(path, [])
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict) and item.get("id")]
    return []


def load_feed_state(path: Path) -> Dict[str, Dict[str, Any]]:
    data = load_json_file(path, {})
    if not isinstance(data, dict):
        return {}
    normalized: Dict[str, Dict[str, Any]] = {}
    for feed_id, entry in data.items():
        if isinstance(feed_id, str) and isinstance(entry, dict):
            normalized[feed_id] = dict(entry)
    return normalized


def atomic_write_json(
    path: Path,
    data: Dict[str, Any],
    mkstemp_fn=tempfile.mkstemp,
    replace_fn=os.replace,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = mkstemp_fn(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        payload = json.dumps(data, sort_keys=True, indent=2).encode("utf-8")
        os.write(fd, payload)
        os.close(fd)
        fd = -1
        replace_fn(tmp_path, str(path))
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


def ensure_feed_state(
    state: Dict[str, Dict[str, Any]],
    feed_id: str,
    salt_provider=random.randint,
) -> Dict[str, Any]:
    entry = state.setdefault(feed_id, {})
    seen_ids = entry.get("seen_ids")
    if not isinstance(seen_ids, list):
        entry["seen_ids"] = []
    salt = entry.get("salt_offset_seconds")
    if not isinstance(salt, int) or salt < 0 or salt > 600:
        entry["salt_offset_seconds"] = int(salt_provider(0, 600))
    return entry


def is_feed_due(feed_state: Dict[str, Any], now: datetime) -> bool:
    next_due = parse_datetime(feed_state.get("next_due_at"))
    if next_due is None:
        return True
    return now >= next_due


def advance_next_due(feed_state: Dict[str, Any], interval_minutes: int, now: datetime) -> None:
    salt = int(feed_state.get("salt_offset_seconds", 0))
    previous_due = parse_datetime(feed_state.get("next_due_at"))
    if previous_due is None:
        next_due = now + timedelta(seconds=salt)
    else:
        next_due = previous_due + timedelta(minutes=interval_minutes)
        if next_due <= now:
            next_due = now + timedelta(seconds=salt)
    feed_state["next_due_at"] = format_datetime(next_due)


def append_seen_ids(existing: Iterable[Any], new_ids: Iterable[str]) -> List[str]:
    merged: List[str] = []
    seen = set()
    for value in existing:
        if isinstance(value, str) and value not in seen:
            seen.add(value)
            merged.append(value)
    for value in new_ids:
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            merged.append(value)
    return merged


def fetch_bytes(url: str, timeout: int = 15) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def get_rss_items(feed: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Optional[str]]:
    url = feed.get("url", "")
    if not isinstance(url, str) or not url:
        return [], "missing feed url"
    try:
        raw_bytes = fetch_bytes(url)
        return parse_feed_bytes(raw_bytes), None
    except Exception as exc:
        return [], str(exc)


def get_builtin_feed_items(feed: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Optional[str]]:
    feed_type = feed.get("type")
    if feed_type == "rss":
        return get_rss_items(feed)
    return [], f"unsupported feed type: {feed_type}"


def run_custom_handler(
    feed: Dict[str, Any],
    existing_seen_ids: List[str],
) -> Tuple[List[Dict[str, str]], List[str], Optional[str]]:
    handler = feed.get("handler", "")
    if not isinstance(handler, str) or not handler:
        return [], existing_seen_ids, "missing custom handler path"

    handler_path = Path(handler)
    if not handler_path.is_absolute():
        handler_path = ROOT_DIR / handler_path
    if not handler_path.exists():
        return [], existing_seen_ids, f"handler not found: {handler_path}"

    payload = {
        "action": "check",
        "feed_config": feed,
        "seen_ids": existing_seen_ids,
    }

    try:
        result = subprocess.run(
            [sys.executable, str(handler_path)],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except Exception as exc:
        return [], existing_seen_ids, str(exc)

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        return [], existing_seen_ids, stderr or f"handler exited with code {result.returncode}"

    try:
        parsed = json.loads(result.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        return [], existing_seen_ids, f"invalid handler JSON: {exc}"

    if not isinstance(parsed, dict):
        return [], existing_seen_ids, "handler returned non-object JSON"

    raw_items = parsed.get("new_items", [])
    raw_seen_ids = parsed.get("seen_ids", existing_seen_ids)
    if not isinstance(raw_items, list) or not isinstance(raw_seen_ids, list):
        return [], existing_seen_ids, "handler returned invalid new_items or seen_ids"

    items: List[Dict[str, str]] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        items.append(
            {
                "id": str(raw_item.get("id") or raw_item.get("url") or raw_item.get("title") or ""),
                "title": str(raw_item.get("title", "")),
                "url": sanitize_url(raw_item.get("url", "")),
                "published": normalize_timestamp(raw_item.get("published", "")),
                "snippet": sanitize_snippet(raw_item.get("snippet", "")),
            }
        )

    normalized_seen_ids = [str(item) for item in raw_seen_ids if str(item)]
    return items, normalized_seen_ids, None


def finalize_output_item(feed: Dict[str, Any], item: Dict[str, str]) -> Dict[str, str]:
    return {
        "feed_id": str(feed.get("id", "")),
        "feed_name": str(feed.get("name", feed.get("id", ""))),
        "title": str(item.get("title", "")),
        "url": sanitize_url(item.get("url", "")),
        "published": normalize_timestamp(item.get("published", "")),
        "snippet": sanitize_snippet(item.get("snippet", "")),
    }


def check_feed(feed: Dict[str, Any], feed_state: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Optional[str]]:
    max_items = int(feed.get("max_items", 5) or 5)
    if feed.get("type") == "api-custom":
        items, new_seen_ids, error = run_custom_handler(feed, list(feed_state.get("seen_ids", [])))
        if error:
            return [], error
        feed_state["seen_ids"] = new_seen_ids
        return [finalize_output_item(feed, item) for item in items[:max_items]], None

    items, error = get_builtin_feed_items(feed)
    if error:
        return [], error

    existing_seen = set(item for item in feed_state.get("seen_ids", []) if isinstance(item, str))
    source_ids: List[str] = []
    new_items: List[Dict[str, str]] = []
    for item in items:
        item_id = item.get("id", "")
        if not item_id:
            continue
        source_ids.append(item_id)
        if item_id in existing_seen:
            continue
        if len(new_items) < max_items:
            new_items.append(finalize_output_item(feed, item))
    feed_state["seen_ids"] = append_seen_ids(feed_state.get("seen_ids", []), source_ids)
    return new_items, None


def build_status(feed: Dict[str, Any], feed_state: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    next_due_at = feed_state.get("next_due_at", "")
    return {
        "feed_id": str(feed.get("id", "")),
        "feed_name": str(feed.get("name", feed.get("id", ""))),
        "type": str(feed.get("type", "")),
        "due": is_feed_due(feed_state, now),
        "next_due_at": next_due_at if isinstance(next_due_at, str) else "",
        "salt_offset_seconds": feed_state.get("salt_offset_seconds"),
        "seen_count": len(feed_state.get("seen_ids", [])) if isinstance(feed_state.get("seen_ids", []), list) else 0,
    }


def run_action(
    payload: Dict[str, Any],
    feeds_path: Path = DEFAULT_FEEDS_PATH,
    state_path: Path = DEFAULT_STATE_PATH,
    now: Optional[datetime] = None,
    salt_provider=random.randint,
) -> Dict[str, Any]:
    action = payload.get("action", "check")
    now = now or utc_now()
    feeds = load_feed_registry(feeds_path)
    state = load_feed_state(state_path)

    result: Dict[str, Any] = {
        "new_items": [],
        "feeds_checked": 0,
        "feeds_skipped": 0,
    }
    errors: List[Dict[str, str]] = []

    if action == "status":
        result["feeds"] = [build_status(feed, state.get(str(feed["id"]), {}), now) for feed in feeds]
        result["feeds_skipped"] = len(feeds)
        return result

    if action not in {"check", "check_all", "peek"}:
        return {"error": f"unknown action: {action}"}

    force_all = action == "check_all"
    is_peek = action == "peek"

    # For peek with a specific feed_id, filter to just that feed and
    # check it regardless of schedule.  Without feed_id, peek respects
    # next_due_at like a normal check.
    target_feed_id = payload.get("feed_id") if is_peek else None
    if target_feed_id is not None:
        feeds = [f for f in feeds if str(f.get("id")) == target_feed_id]
        if not feeds:
            return {"error": f"feed not found: {target_feed_id}"}

    state_changed = False

    for feed in feeds:
        feed_id = str(feed["id"])
        feed_state = ensure_feed_state(state, feed_id, salt_provider=salt_provider)
        due = is_feed_due(feed_state, now)

        # peek+feed_id: always check the targeted feed.
        # peek (no feed_id): respect schedule like normal check.
        # check_all: force all.  check: respect schedule.
        if not force_all and not due and not (is_peek and target_feed_id is not None):
            result["feeds_skipped"] += 1
            continue

        items, error = check_feed(feed, feed_state)

        # peek is read-only: don't advance schedule or persist state.
        # check_feed() mutates seen_ids in-memory, but since we never
        # write state to disk those changes are discarded on exit.
        if not is_peek:
            interval_minutes = int(feed.get("check_interval_minutes", 60) or 60)
            advance_next_due(feed_state, interval_minutes, now)
            feed_state["last_check"] = format_datetime(now)
            state_changed = True

        result["feeds_checked"] += 1
        if error:
            errors.append({"feed_id": feed_id, "error": error})
            continue
        result["new_items"].extend(items)

    if state_changed:
        atomic_write_json(state_path, state)

    if errors:
        result["errors"] = errors
    return result


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"invalid input JSON: {exc}"}))
        return 1

    if not isinstance(payload, dict):
        print(json.dumps({"error": "input JSON must be an object"}))
        return 1

    # Allow callers to override feed registry and state paths (for per-agent isolation)
    feeds_path = Path(payload["feeds_path"]) if "feeds_path" in payload else DEFAULT_FEEDS_PATH
    state_path = Path(payload["state_path"]) if "state_path" in payload else DEFAULT_STATE_PATH

    result = run_action(payload, feeds_path=feeds_path, state_path=state_path)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
