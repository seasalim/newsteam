import importlib.util
import json
import os
import tempfile
import unittest

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "feed-check.py"
SPEC = importlib.util.spec_from_file_location("feed_check", MODULE_PATH)
feed_check = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(feed_check)


class FeedCheckTest(unittest.TestCase):
    def test_parse_rss_uses_guid_when_present(self):
        raw = b"""<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>item-123</guid>
      <link>https://example.com/link</link>
      <title>Hello</title>
      <description><![CDATA[<p>Body</p>]]></description>
      <pubDate>Wed, 11 Mar 2026 14:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""

        items = feed_check.parse_feed_bytes(raw)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "item-123")
        self.assertEqual(items[0]["url"], "https://example.com/link")
        self.assertEqual(items[0]["snippet"], "Body")
        self.assertEqual(items[0]["published"], "2026-03-11T14:00:00Z")

    def test_parse_rss_falls_back_to_link(self):
        raw = b"""<rss version="2.0">
  <channel>
    <item>
      <link>https://example.com/post</link>
      <title>Fallback</title>
    </item>
  </channel>
</rss>
"""

        items = feed_check.parse_feed_bytes(raw)

        self.assertEqual(items[0]["id"], "https://example.com/post")
        self.assertEqual(items[0]["url"], "https://example.com/post")

    def test_parse_feed_bytes_rejects_malformed_xml(self):
        with self.assertRaisesRegex(ValueError, "parse failed"):
            feed_check.parse_feed_bytes(b"<rss><channel><item></rss>")

    def test_parse_atom_uses_id_and_namespace_handling(self):
        raw = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Feed</title>
  <entry>
    <id>tag:example.com,2026:1</id>
    <title>Atom Entry</title>
    <link rel="alternate" href="https://example.com/atom-1" />
    <summary><![CDATA[<b>Summary</b>]]></summary>
    <published>2026-03-10T08:15:00Z</published>
  </entry>
</feed>
"""

        items = feed_check.parse_feed_bytes(raw)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "tag:example.com,2026:1")
        self.assertEqual(items[0]["url"], "https://example.com/atom-1")
        self.assertEqual(items[0]["snippet"], "Summary")
        self.assertEqual(items[0]["published"], "2026-03-10T08:15:00Z")

    def test_parse_atom_falls_back_to_link(self):
        raw = b"""<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>No ID</title>
    <link href="https://example.com/fallback" />
    <updated>2026-03-09T10:00:00Z</updated>
  </entry>
</feed>
"""

        items = feed_check.parse_feed_bytes(raw)

        self.assertEqual(items[0]["id"], "https://example.com/fallback")
        self.assertEqual(items[0]["url"], "https://example.com/fallback")

    def test_sanitize_snippet_strips_html_control_chars_and_limits_length(self):
        raw = "<p>Hello <b>world</b>&amp; friends</p>\x00\x1f\n" + ("x" * 650)

        snippet = feed_check.sanitize_snippet(raw)

        self.assertEqual(len(snippet), 600)
        self.assertNotIn("<", snippet)
        self.assertNotIn(">", snippet)
        self.assertNotIn("\x00", snippet)
        self.assertNotIn("\x1f", snippet)
        self.assertTrue(snippet.startswith("Hello world& friends"))

    def test_load_feed_state_tolerates_missing_and_corrupt_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "state.json"
            self.assertEqual(feed_check.load_feed_state(state_path), {})

            state_path.write_text("{not json", encoding="utf-8")
            self.assertEqual(feed_check.load_feed_state(state_path), {})

    def test_atomic_write_json_replaces_destination_atomically(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "feeds_state.json"
            replace_calls = []

            def mkstemp_fn(*, dir, prefix, suffix):
                return tempfile.mkstemp(dir=dir, prefix=prefix, suffix=suffix)

            def replace_fn(src, dst):
                replace_calls.append((src, dst, Path(src).parent))
                os.replace(src, dst)

            feed_check.atomic_write_json(
                state_path,
                {"feed": {"seen_ids": ["one"]}},
                mkstemp_fn=mkstemp_fn,
                replace_fn=replace_fn,
            )

            self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), {"feed": {"seen_ids": ["one"]}})
            self.assertEqual(len(replace_calls), 1)
            src, dst, src_parent = replace_calls[0]
            self.assertEqual(dst, str(state_path))
            self.assertEqual(src_parent, state_path.parent)
            self.assertFalse(Path(src).exists())

    def test_timing_helpers_cover_salt_due_and_advance_behavior(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        state = {}

        entry = feed_check.ensure_feed_state(state, "feed-a", salt_provider=lambda start, end: 123)
        self.assertEqual(entry["salt_offset_seconds"], 123)
        self.assertEqual(entry["seen_ids"], [])

        same_entry = feed_check.ensure_feed_state(state, "feed-a", salt_provider=lambda start, end: 555)
        self.assertEqual(same_entry["salt_offset_seconds"], 123)

        self.assertTrue(feed_check.is_feed_due({}, now))
        self.assertFalse(
            feed_check.is_feed_due(
                {"next_due_at": feed_check.format_datetime(now + timedelta(minutes=5))},
                now,
            )
        )
        self.assertTrue(
            feed_check.is_feed_due(
                {"next_due_at": feed_check.format_datetime(now - timedelta(seconds=1))},
                now,
            )
        )

        feed_check.advance_next_due(entry, 60, now)
        self.assertEqual(entry["next_due_at"], "2026-03-12T16:02:03Z")

        scheduled = {"salt_offset_seconds": 123, "next_due_at": "2026-03-12T17:00:00Z"}
        feed_check.advance_next_due(scheduled, 60, now)
        self.assertEqual(scheduled["next_due_at"], "2026-03-12T18:00:00Z")

        overdue = {"salt_offset_seconds": 123, "next_due_at": "2026-03-12T14:00:00Z"}
        feed_check.advance_next_due(overdue, 60, now)
        self.assertEqual(overdue["next_due_at"], "2026-03-12T16:02:03Z")

    def test_run_action_status_reports_due_state(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [
            {"id": "feed-a", "name": "Feed A", "type": "rss", "url": "https://example.com/a"},
            {"id": "feed-b", "name": "Feed B", "type": "rss", "url": "https://example.com/b"},
        ]
        state = {
            "feed-a": {
                "next_due_at": "2026-03-12T15:59:00Z",
                "salt_offset_seconds": 12,
                "seen_ids": ["1", "2"],
            },
            "feed-b": {
                "next_due_at": "2026-03-12T16:30:00Z",
                "salt_offset_seconds": 34,
                "seen_ids": ["9"],
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text(json.dumps(state), encoding="utf-8")

            result = feed_check.run_action({"action": "status"}, feeds_path=feeds_path, state_path=state_path, now=now)

        self.assertEqual(result["feeds_checked"], 0)
        self.assertEqual(result["feeds_skipped"], 2)
        self.assertEqual([feed["due"] for feed in result["feeds"]], [True, False])
        self.assertEqual(result["feeds"][0]["seen_count"], 2)

    def test_run_action_check_respects_due_and_persists_state(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [
            {
                "id": "due-feed",
                "name": "Due Feed",
                "type": "rss",
                "url": "https://example.com/due",
                "check_interval_minutes": 30,
                "max_items": 1,
            },
            {
                "id": "later-feed",
                "name": "Later Feed",
                "type": "rss",
                "url": "https://example.com/later",
                "check_interval_minutes": 30,
            },
        ]
        state = {
            "due-feed": {
                "next_due_at": "2026-03-12T15:00:00Z",
                "salt_offset_seconds": 10,
                "seen_ids": ["seen-1"],
            },
            "later-feed": {
                "next_due_at": "2026-03-12T16:30:00Z",
                "salt_offset_seconds": 20,
                "seen_ids": [],
            },
        }

        def fake_get_builtin_feed_items(feed):
            if feed["id"] != "due-feed":
                raise AssertionError(f"unexpected feed fetch: {feed['id']}")
            return (
                [
                    {
                        "id": "seen-1",
                        "title": "Seen",
                        "url": "https://example.com/seen",
                        "published": "2026-03-12T15:30:00Z",
                        "snippet": "Seen snippet",
                    },
                    {
                        "id": "new-1",
                        "title": "New one",
                        "url": "https://example.com/new-1",
                        "published": "2026-03-12T15:45:00Z",
                        "snippet": "New snippet",
                    },
                    {
                        "id": "new-2",
                        "title": "New two",
                        "url": "https://example.com/new-2",
                        "published": "2026-03-12T15:50:00Z",
                        "snippet": "Other snippet",
                    },
                ],
                None,
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text(json.dumps(state), encoding="utf-8")

            with mock.patch.object(feed_check, "get_builtin_feed_items", side_effect=fake_get_builtin_feed_items):
                result = feed_check.run_action({"action": "check"}, feeds_path=feeds_path, state_path=state_path, now=now)

            persisted_state = json.loads(state_path.read_text(encoding="utf-8"))

        self.assertEqual(result["feeds_checked"], 1)
        self.assertEqual(result["feeds_skipped"], 1)
        self.assertEqual(len(result["new_items"]), 1)
        self.assertEqual(result["new_items"][0]["feed_id"], "due-feed")
        self.assertEqual(result["new_items"][0]["title"], "New one")
        self.assertEqual(
            persisted_state["due-feed"]["seen_ids"],
            ["seen-1", "new-1", "new-2"],
        )
        self.assertEqual(persisted_state["due-feed"]["next_due_at"], "2026-03-12T16:00:10Z")
        self.assertEqual(persisted_state["later-feed"]["next_due_at"], "2026-03-12T16:30:00Z")

    def test_run_action_check_all_forces_all_feeds(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [
            {
                "id": "feed-a",
                "name": "Feed A",
                "type": "rss",
                "url": "https://example.com/a",
                "check_interval_minutes": 60,
            },
            {
                "id": "feed-b",
                "name": "Feed B",
                "type": "rss",
                "url": "https://example.com/b",
                "check_interval_minutes": 60,
            },
        ]
        state = {
            "feed-a": {
                "next_due_at": "2026-03-12T16:10:00Z",
                "salt_offset_seconds": 7,
                "seen_ids": [],
            },
            "feed-b": {
                "next_due_at": "2026-03-12T16:20:00Z",
                "salt_offset_seconds": 8,
                "seen_ids": [],
            },
        }
        fetched = []

        def fake_get_builtin_feed_items(feed):
            fetched.append(feed["id"])
            return ([{"id": f"{feed['id']}-1", "title": feed["name"], "url": f"https://example.com/{feed['id']}"}], None)

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text(json.dumps(state), encoding="utf-8")

            with mock.patch.object(feed_check, "get_builtin_feed_items", side_effect=fake_get_builtin_feed_items):
                result = feed_check.run_action({"action": "check_all"}, feeds_path=feeds_path, state_path=state_path, now=now)

        self.assertEqual(result["feeds_checked"], 2)
        self.assertEqual(result["feeds_skipped"], 0)
        self.assertEqual(fetched, ["feed-a", "feed-b"])
        self.assertEqual(len(result["new_items"]), 2)

    def test_run_action_peek_does_not_write_state(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [
            {
                "id": "due-feed",
                "name": "Due Feed",
                "type": "rss",
                "url": "https://example.com/due",
                "check_interval_minutes": 30,
                "max_items": 5,
            },
            {
                "id": "later-feed",
                "name": "Later Feed",
                "type": "rss",
                "url": "https://example.com/later",
                "check_interval_minutes": 30,
            },
        ]
        original_state = {
            "due-feed": {
                "next_due_at": "2026-03-12T15:00:00Z",
                "salt_offset_seconds": 10,
                "seen_ids": ["seen-1"],
            },
            "later-feed": {
                "next_due_at": "2026-03-12T16:30:00Z",
                "salt_offset_seconds": 20,
                "seen_ids": [],
            },
        }

        def fake_get_builtin_feed_items(feed):
            if feed["id"] != "due-feed":
                raise AssertionError(f"unexpected feed fetch: {feed['id']}")
            return (
                [
                    {"id": "seen-1", "title": "Seen", "url": "https://example.com/seen", "published": "", "snippet": ""},
                    {"id": "new-1", "title": "New", "url": "https://example.com/new-1", "published": "", "snippet": "New snippet"},
                ],
                None,
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text(json.dumps(original_state), encoding="utf-8")

            with mock.patch.object(feed_check, "get_builtin_feed_items", side_effect=fake_get_builtin_feed_items):
                result = feed_check.run_action({"action": "peek"}, feeds_path=feeds_path, state_path=state_path, now=now)

            persisted_state = json.loads(state_path.read_text(encoding="utf-8"))

        # peek returns new items
        self.assertEqual(result["feeds_checked"], 1)
        self.assertEqual(result["feeds_skipped"], 1)
        self.assertEqual(len(result["new_items"]), 1)
        self.assertEqual(result["new_items"][0]["title"], "New")

        # State file is completely unchanged — no seen_ids update, no next_due_at advance
        self.assertEqual(persisted_state, original_state)

    def test_run_action_peek_with_feed_id_ignores_schedule(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [
            {
                "id": "not-due-feed",
                "name": "Not Due Feed",
                "type": "rss",
                "url": "https://example.com/notdue",
                "check_interval_minutes": 60,
            },
        ]
        original_state = {
            "not-due-feed": {
                "next_due_at": "2026-03-12T17:00:00Z",
                "salt_offset_seconds": 50,
                "seen_ids": [],
            },
        }

        def fake_get_builtin_feed_items(feed):
            return (
                [{"id": "item-1", "title": "Item 1", "url": "https://example.com/item-1", "published": "", "snippet": ""}],
                None,
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text(json.dumps(original_state), encoding="utf-8")

            with mock.patch.object(feed_check, "get_builtin_feed_items", side_effect=fake_get_builtin_feed_items):
                result = feed_check.run_action(
                    {"action": "peek", "feed_id": "not-due-feed"},
                    feeds_path=feeds_path, state_path=state_path, now=now,
                )

            persisted_state = json.loads(state_path.read_text(encoding="utf-8"))

        # Feed was checked even though it's not due
        self.assertEqual(result["feeds_checked"], 1)
        self.assertEqual(result["feeds_skipped"], 0)
        self.assertEqual(len(result["new_items"]), 1)
        self.assertEqual(result["new_items"][0]["title"], "Item 1")

        # State file unchanged
        self.assertEqual(persisted_state, original_state)

    def test_run_action_peek_with_bad_feed_id_returns_error(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)
        feeds = [{"id": "real-feed", "name": "Real Feed", "type": "rss", "url": "https://example.com/real"}]

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            state_path = Path(temp_dir) / "state.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")
            state_path.write_text("{}", encoding="utf-8")

            result = feed_check.run_action(
                {"action": "peek", "feed_id": "nonexistent"},
                feeds_path=feeds_path, state_path=state_path, now=now,
            )

        self.assertIn("error", result)
        self.assertIn("nonexistent", result["error"])

    def test_check_feed_enforces_max_items(self):
        feed = {
            "id": "feed-a",
            "name": "Feed A",
            "type": "rss",
            "url": "https://example.com/a",
            "max_items": 1,
        }
        feed_state = {"seen_ids": ["old"]}

        items = [
            {"id": "old", "title": "Old", "url": "https://example.com/old", "published": "", "snippet": ""},
            {"id": "new-1", "title": "One", "url": "https://example.com/one", "published": "", "snippet": ""},
            {"id": "new-2", "title": "Two", "url": "https://example.com/two", "published": "", "snippet": ""},
        ]

        with mock.patch.object(feed_check, "get_builtin_feed_items", return_value=(items, None)):
            new_items, error = feed_check.check_feed(feed, feed_state)

        self.assertIsNone(error)
        self.assertEqual([item["title"] for item in new_items], ["One"])
        self.assertEqual(feed_state["seen_ids"], ["old", "new-1", "new-2"])


if __name__ == "__main__":
    unittest.main()
