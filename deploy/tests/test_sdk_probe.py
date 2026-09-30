"""SDK 验收工具的最终事件 ID 边界；不发 HTTP 请求。"""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

SPEC = importlib.util.spec_from_file_location("memoia_sdk_probe", Path(__file__).parents[1] / "verify-sdk.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class CompletionIDs(unittest.TestCase):
    def test_completed_no_event_is_legal(self):
        self.assertEqual(probe.ids([{"event_id": None}]), [])

    def test_final_events_are_validated_and_deduplicated(self):
        event_id = str(uuid4())
        self.assertEqual(probe.ids([{"event_id": event_id}, {"event_id": event_id}]), [event_id])

    def test_async_empty_buffer_unknown_or_blob_id_is_not_completion(self):
        for results in (None, [], [{}], [{"id": str(uuid4())}], [{"event_id": ""}], [{"event_id": 123}]):
            with self.subTest(results=results), self.assertRaises((ValueError, TypeError, AttributeError)):
                probe.ids(results)

    def test_malformed_completion_preserves_known_raw_ids_and_cannot_replay(self):
        event_id = str(uuid4())
        raw = {"id": str(uuid4()), "chat_results": [{"event_id": event_id}, {}]}
        client = MagicMock()
        client.get_user.side_effect = lambda user_id: SimpleNamespace(user_id=user_id)
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            args = ["verify-sdk.py", "create", "https://fixture.example.com", str(receipt)]
            with patch.object(probe.sys, "argv", args), patch.object(probe.sys, "stdin", io.StringIO("fixture-token")), \
                    patch.object(probe, "MemoBaseClient", return_value=client), \
                    patch.object(probe, "unpack_response", return_value=SimpleNamespace(data=raw)):
                with self.assertRaises(ValueError):
                    probe.main()
            saved = json.loads(receipt.read_text())
            self.assertEqual(saved["status"], "response-received-small")
            self.assertEqual(saved["small_completion_results"][0]["event_id"], event_id)
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).glob(".sdk-receipt-*")), [])
            with patch.object(probe.sys, "argv", args), patch.object(probe.sys, "stdin", io.StringIO("fixture-token")), \
                    patch.object(probe, "MemoBaseClient", return_value=client), self.assertRaises(ValueError):
                probe.main()
            self.assertEqual(client.client.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
