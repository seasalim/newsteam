import importlib.util
import json
import os
import tempfile
import unittest

from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "feed-manage" / "handler.py"
MANIFEST_PATH = MODULE_PATH.with_name("manifest.json")
TEST_FEEDS_PATH = Path("/test/persona/feeds.json")
SPEC = importlib.util.spec_from_file_location("feed_manage", MODULE_PATH)
feed_manage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None

# The handler guards stdin reading behind __name__ == "__main__",
# so exec_module won't try to read stdin.
SPEC.loader.exec_module(feed_manage)


class FeedManageTest(unittest.TestCase):

    def test_manifest_exposes_only_read_only_actions(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        actions = manifest["parameters"]["properties"]["action"]["enum"]

        self.assertEqual(actions, ["list", "check", "status"])

    # -- list ---------------------------------------------------------------

    def test_list_returns_flattened_feeds(self):
        feeds = [
            {"id": "hn", "name": "Hacker News", "type": "rss", "url": "https://hnrss.org/frontpage", "check_interval_minutes": 60, "max_items": 5},
            {"id": "example-api", "name": "Example API", "type": "api-custom", "handler": "scripts/feeds/example-source.py", "check_interval_minutes": 120},
            {"id": "github", "name": "GitHub Trending", "type": "api-custom", "handler": "scripts/feeds/github.py", "check_interval_minutes": 90},
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")

            result = feed_manage.handle({"action": "list"}, feeds_path=feeds_path)

        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 3)
        self.assertEqual(result["message"], "3 feeds configured.")

        # RSS feed includes url
        hn = result["feeds"][0]
        self.assertEqual(hn["id"], "hn")
        self.assertEqual(hn["name"], "Hacker News")
        self.assertEqual(hn["type"], "rss")
        self.assertEqual(hn["interval_min"], 60)
        self.assertEqual(hn["url"], "https://hnrss.org/frontpage")

        # Custom API feed omits url
        example_api = result["feeds"][1]
        self.assertEqual(example_api["id"], "example-api")
        self.assertEqual(example_api["type"], "api-custom")
        self.assertEqual(example_api["interval_min"], 120)
        self.assertNotIn("url", example_api)

        # api-custom feed omits url
        github = result["feeds"][2]
        self.assertEqual(github["type"], "api-custom")
        self.assertNotIn("url", github)

        # No implementation-detail fields leak through
        for f in result["feeds"]:
            self.assertNotIn("max_items", f)
            self.assertNotIn("endpoint", f)
            self.assertNotIn("handler", f)
            self.assertNotIn("check_interval_minutes", f)

    def test_list_empty_registry(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            # File doesn't exist

            result = feed_manage.handle({"action": "list"}, feeds_path=feeds_path)

        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["feeds"], [])
        self.assertEqual(result["message"], "0 feeds configured.")

    def test_runtime_uses_configured_persona_directory(self):
        feeds = [{
            "id": "scoped-feed",
            "name": "Scoped Feed",
            "type": "rss",
            "url": "https://example.com/scoped.xml",
        }]

        with tempfile.TemporaryDirectory() as temp_dir:
            persona_dir = Path(temp_dir)
            (persona_dir / "feeds.json").write_text(json.dumps(feeds), encoding="utf-8")
            with mock.patch.dict(os.environ, {"NEWSTEAM_PERSONA_DIR": temp_dir}):
                result = feed_manage.handle_from_runtime({"action": "list"})

        self.assertTrue(result["ok"])
        self.assertEqual(result["feeds"][0]["id"], "scoped-feed")

    def test_runtime_fails_closed_without_persona_directory(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            result = feed_manage.handle_from_runtime({"action": "list"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "missing_tool_context")

    # -- status -------------------------------------------------------------

    def test_status_converts_times_to_relative(self):
        now = datetime(2026, 3, 12, 16, 0, tzinfo=timezone.utc)

        fake_status_result = {
            "new_items": [],
            "feeds_checked": 0,
            "feeds_skipped": 2,
            "feeds": [
                {
                    "feed_id": "hn",
                    "feed_name": "Hacker News",
                    "type": "rss",
                    "due": False,
                    "next_due_at": "2026-03-12T16:12:00Z",
                    "seen_count": 47,
                },
                {
                    "feed_id": "example-api",
                    "feed_name": "Example API",
                    "type": "api-custom",
                    "due": True,
                    "next_due_at": "2026-03-12T15:30:00Z",
                    "seen_count": 12,
                },
            ],
        }

        with mock.patch.object(feed_manage, "invoke_feed_check", return_value=fake_status_result) as mock_invoke:
            result = feed_manage.handle(
                {"action": "status"}, feeds_path=TEST_FEEDS_PATH, now=now,
            )

        status_payload = mock_invoke.call_args[0][0]
        self.assertEqual(status_payload["action"], "status")
        self.assertEqual(status_payload["feeds_path"], str(TEST_FEEDS_PATH))
        self.assertEqual(
            status_payload["state_path"],
            str(TEST_FEEDS_PATH.with_name("feeds_state.json")),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["feeds"]), 2)

        self.assertEqual(result["feeds"][0]["id"], "hn")
        self.assertEqual(result["feeds"][0]["next_check"], "12 min")
        self.assertEqual(result["feeds"][0]["seen_count"], 47)

        self.assertEqual(result["feeds"][1]["id"], "example-api")
        self.assertEqual(result["feeds"][1]["next_check"], "overdue")

        self.assertIn("1 overdue", result["message"])

    # -- check --------------------------------------------------------------

    def test_check_invokes_peek(self):
        fake_peek_result = {
            "new_items": [
                {"feed_name": "HN", "title": "Cool post", "url": "https://example.com/1", "snippet": "Snippet", "feed_id": "hn"},
            ],
            "feeds_checked": 2,
            "feeds_skipped": 1,
        }

        with mock.patch.object(feed_manage, "invoke_feed_check", return_value=fake_peek_result) as mock_invoke:
            result = feed_manage.handle({"action": "check"}, feeds_path=TEST_FEEDS_PATH)

        # Verify it called feed-check.py with peek action
        mock_invoke.assert_called_once()
        call_payload = mock_invoke.call_args[0][0]
        self.assertEqual(call_payload["action"], "peek")
        self.assertEqual(call_payload["feeds_path"], str(TEST_FEEDS_PATH))
        self.assertEqual(
            call_payload["state_path"],
            str(TEST_FEEDS_PATH.with_name("feeds_state.json")),
        )
        self.assertNotIn("feed_id", call_payload)

        # Verify output shape
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["new_items"]), 1)
        self.assertEqual(result["new_items"][0]["title"], "Cool post")
        self.assertEqual(result["feeds_checked"], 2)
        self.assertIn("1 new item", result["message"])
        self.assertIn("scheduler not affected", result["message"])

        # Implementation-detail fields stripped from items
        self.assertNotIn("feed_id", result["new_items"][0])

    def test_check_with_feed_id_passes_through(self):
        fake_peek_result = {
            "new_items": [
                {"feed_name": "HN", "title": "Post", "url": "https://example.com/1", "snippet": "S"},
            ],
            "feeds_checked": 1,
            "feeds_skipped": 0,
        }

        with mock.patch.object(feed_manage, "invoke_feed_check", return_value=fake_peek_result) as mock_invoke:
            result = feed_manage.handle(
                {"action": "check", "feed_id": "hn-frontpage"},
                feeds_path=TEST_FEEDS_PATH,
            )

        call_payload = mock_invoke.call_args[0][0]
        self.assertEqual(call_payload["action"], "peek")
        self.assertEqual(call_payload["feed_id"], "hn-frontpage")
        self.assertTrue(result["ok"])

    def test_check_nothing_new_message(self):
        fake_peek_result = {
            "new_items": [],
            "feeds_checked": 3,
            "feeds_skipped": 0,
        }

        with mock.patch.object(feed_manage, "invoke_feed_check", return_value=fake_peek_result):
            result = feed_manage.handle({"action": "check"}, feeds_path=TEST_FEEDS_PATH)

        self.assertTrue(result["ok"])
        self.assertEqual(result["new_items"], [])
        self.assertIn("Nothing new", result["message"])
        self.assertIn("3 feeds", result["message"])

    def test_check_single_feed_nothing_new_uses_name(self):
        fake_peek_result = {
            "new_items": [],
            "feeds_checked": 1,
            "feeds_skipped": 0,
        }
        feeds = [{"id": "hn-frontpage", "name": "Hacker News", "type": "rss", "url": "https://hnrss.org/frontpage"}]

        with tempfile.TemporaryDirectory() as temp_dir:
            feeds_path = Path(temp_dir) / "feeds.json"
            feeds_path.write_text(json.dumps(feeds), encoding="utf-8")

            with mock.patch.object(feed_manage, "invoke_feed_check", return_value=fake_peek_result):
                result = feed_manage.handle({"action": "check", "feed_id": "hn-frontpage"}, feeds_path=feeds_path)

        self.assertIn("Nothing new from Hacker News", result["message"])

    # -- unknown action -----------------------------------------------------

    def test_unknown_action_returns_error(self):
        result = feed_manage.handle({"action": "bogus"})

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "unknown_action")
        self.assertIn("bogus", result["message"])

    def test_mutation_actions_are_not_supported(self):
        for action in ("add", "remove"):
            with self.subTest(action=action):
                result = feed_manage.handle({"action": action})
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], "unknown_action")


if __name__ == "__main__":
    unittest.main()
