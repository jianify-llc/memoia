"""精确多提交差异、来源隔离和quick固定离线边界。"""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("verify_local", SCRIPTS / "verify_local.py")
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class LocalCI(unittest.TestCase):
    def test_full_without_base_does_not_query_history(self):
        with patch.object(ci, "run") as run:
            self.assertTrue(all(ci.selections("full").values()))
            run.assert_not_called()

    def test_quick_never_starts_database_or_tool_fixtures(self):
        with patch.object(ci, "run") as run:
            self.assertFalse(any(ci.selections("quick", "a"*40).values()))
            run.assert_not_called()
        source = (SCRIPTS / "verify_local.py").read_text()
        self.assertIn('"-p", "offline_tests", "scripts/tests/test_sdk_offline.py"', source)
        self.assertIn('business = mode == "full"', source)

    def test_multi_commit_diff_selects_business_and_tools(self):
        def run(command, **kwargs):
            return "src/server/api/api.py\0deploy/recovery.py\0" if "--name-only" in command else ""
        with patch.object(ci, "run", side_effect=run) as command:
            result = ci.selections("full", "a"*40)
            self.assertTrue(result["business"])
            self.assertTrue(result["deploy"])
            self.assertFalse(result["hook"])
            self.assertTrue(any(call.args[0][-2:] == ["a"*40, "HEAD"] for call in command.call_args_list))

    def test_tool_only_diff_does_not_run_whole_api(self):
        with patch.object(ci, "run", side_effect=lambda command, **kwargs: "scripts/test_push.py\0" if "--name-only" in command else ""):
            result = ci.selections("full", "a"*40)
            self.assertTrue(result["hook"])
            self.assertFalse(result["business"])

    def test_sdk_business_fixture_changes_run_actual_business_tests(self):
        with patch.object(ci, "run", side_effect=lambda command, **kwargs: "scripts/local_tests.py\0" if "--name-only" in command else ""):
            result = ci.selections("full", "a"*40)
            self.assertTrue(result["hook"])
            self.assertTrue(result["business"])

    def test_dirty_or_unavailable_base_expands(self):
        with patch.object(ci, "run", return_value=" M fixture.py"):
            self.assertTrue(all(ci.selections("full", "a"*40).values()))
        with patch.object(ci, "run", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertTrue(all(ci.selections("full", "a"*40).values()))

    def test_snapshot_excludes_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary)/"source", Path(temporary)/"copy"
            source.mkdir(); target.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            for name in (".env.local", ".env.example", "source.py"):
                (source/name).write_text("fixture")
            subprocess.run(["git", "add", "-f", "."], cwd=source, check=True)
            ci.snapshot(source, target)
            self.assertFalse((target/".env.local").exists())
            self.assertTrue((target/".env.example").is_file())
            self.assertTrue((target/"source.py").is_file())
