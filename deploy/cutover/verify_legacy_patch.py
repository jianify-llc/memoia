"""验证旧版备份补丁能正反应用，并保持一次性切换的停机切点。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SOURCE = "54c0ba7664261ea2f68b0b3ab6375392d46a13e9"
PATCH = Path(__file__).with_name("54c0ba7-keep-api-stopped.patch")
REPO = Path(__file__).resolve().parents[2]


class LegacyCutoverPatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_dir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.source_dir.cleanup)
        root = Path(cls.source_dir.name)
        source = root / "deploy"
        source.mkdir()
        for name in ("deploy-memoia.sh", "recovery.py"):
            content = subprocess.run(
                ["git", "show", f"{SOURCE}:deploy/{name}"], cwd=REPO,
                check=True, capture_output=True,
            ).stdout
            (source / name).write_bytes(content)
        for args in (["git", "apply", "--unidiff-zero", "--check", str(PATCH)],
                     ["git", "apply", "--unidiff-zero", str(PATCH)],
                     ["git", "apply", "--unidiff-zero", "--reverse", "--check", str(PATCH)],
                     ["git", "apply", "--unidiff-zero", "--reverse", str(PATCH)],
                     ["git", "apply", "--unidiff-zero", "--check", str(PATCH)],
                     ["git", "apply", "--unidiff-zero", str(PATCH)]):
            subprocess.run(args, cwd=root, check=True, capture_output=True)
        subprocess.run(["bash", "-n", str(source / "deploy-memoia.sh")], check=True)
        subprocess.run(["python3", "-m", "py_compile", str(source / "recovery.py")], check=True)
        spec = importlib.util.spec_from_file_location("memoia_legacy_cutover", source / "recovery.py")
        cls.recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.recovery)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state = self.root / ".deploy"
        self.state.mkdir()
        (self.state / "deploy-state").write_text("100 source-sha fixture-image\n")
        (self.state / "infra-config.sha256").write_text("fixed-infra\n")
        (self.state / "schema.sha256").write_text("fixed-schema\n")
        (self.root / "api").mkdir()
        (self.root / "data/redis").mkdir(parents=True)
        (self.root / "data/redis/dump.rdb").write_bytes(b"redis-snapshot")
        for name in (".env", "docker-compose.yml"):
            (self.root / name).write_text("fixture")
        (self.root / "api/config.yaml").write_text("fixture")
        self.stopped = False
        self.restart_before_final_check = False
        self.fail_dump = False
        self.api_inspections = 0
        self.calls = []
        root_patch = patch.object(self.recovery, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def run_command(self, args, *, input=None, output=None):
        self.calls.append(args)
        if args[-3:] == ["config", "--format", "json"]:
            return json.dumps({"name": "memoia-test", "services": {
                "postgres": {"image": "postgres-image"}, "redis": {"image": "redis-image"},
                "memoia": {"environment": {"PROJECT_ID": "fixture"}},
            }})
        if args[0] == "bash":
            return "fixed-infra"
        if "ps" in args:
            return args[-1]
        if "stop" in args:
            self.stopped = True
            return ""
        if "up" in args:
            self.stopped = False
            return ""
        if "--scan" in args:
            return ""
        if "SET" in args or "SAVE" in args:
            return "OK"
        if "pg_dump" in args[-1]:
            if self.fail_dump:
                raise RuntimeError("fixture dump failure")
            output.write(b"postgres-dump")
            return None
        if "SELECT tablename" in args[-1]:
            return "users"
        if 'SELECT count(*) FROM "users"' in args[-1]:
            return "1"
        if "buffer_zones" in args[-1]:
            return "0"
        raise AssertionError(args)

    def inspect(self, container):
        if container in ("postgres", "redis"):
            destination = "/var/lib/postgresql/data" if container == "postgres" else "/data"
            return {"Config": {"Image": f"{container}-image"}, "Mounts": [
                {"Source": str(self.root / "data" / container), "Destination": destination},
            ]}
        self.api_inspections += 1
        restarted = self.restart_before_final_check and self.api_inspections >= 3
        return {"Config": {"Image": "fixture-image"}, "State": {
            "Health": {"Status": "healthy"}, "Running": not self.stopped or restarted,
            "ExitCode": 0,
        }}

    def backup(self, *, keep_stopped=False):
        with (patch.object(self.recovery, "run", side_effect=self.run_command),
              patch.object(self.recovery, "inspect", side_effect=self.inspect),
              patch.object(self.recovery, "secure_file"),
              patch.object(self.recovery, "wait_healthy")):
            self.recovery.backup(keep_stopped=keep_stopped)

    def test_daily_backup_still_restarts_api(self):
        self.backup()
        self.assertFalse(self.stopped)
        self.assertTrue(any("up" in call for call in self.calls))
        self.assertFalse((self.state / "pending-maintenance").exists())

    def test_cutover_keeps_api_stopped_with_original_manifest(self):
        self.backup(keep_stopped=True)
        self.assertTrue(self.stopped)
        self.assertFalse(any("up" in call for call in self.calls))
        self.assertFalse((self.state / "pending-maintenance").exists())
        directory = next((self.state / "backups").iterdir())
        manifest = json.loads((directory / "backup.json").read_text())
        self.assertEqual(manifest["database_counts"], {"users": 1})
        self.assertEqual(manifest["accepted"], ["100", "source-sha", "fixture-image"])
        self.assertEqual(set(manifest["hashes"]), {
            "postgres.dump", "redis.rdb", ".env", "config.yaml", "docker-compose.yml",
        })
        self.assertLess(next(i for i, call in enumerate(self.calls) if "stop" in call),
                        next(i for i, call in enumerate(self.calls) if "pg_dump" in call[-1]))

    def test_failure_after_stop_keeps_maintenance_marker_and_api_down(self):
        self.fail_dump = True
        with self.assertRaisesRegex(RuntimeError, "fixture dump failure"):
            self.backup(keep_stopped=True)
        self.assertTrue(self.stopped)
        self.assertTrue((self.state / "pending-maintenance").exists())
        self.assertFalse(any("up" in call for call in self.calls))

    def test_cutover_requires_live_api_before_creating_backup(self):
        self.stopped = True
        with self.assertRaisesRegex(RuntimeError, "API to be running"):
            self.backup(keep_stopped=True)
        self.assertFalse((self.state / "backups").exists())
        self.assertFalse(any("stop" in call for call in self.calls))

    def test_restarted_api_rejects_cutover(self):
        self.restart_before_final_check = True
        with self.assertRaisesRegex(RuntimeError, "API restarted"):
            self.backup(keep_stopped=True)
        self.assertTrue((self.state / "pending-maintenance").exists())

    def test_cli_dispatches_only_explicit_cutover_mode(self):
        with (patch.object(self.recovery.os, "geteuid", return_value=0),
              patch.object(self.recovery.sys, "argv", ["recovery.py", "backup-cutover", str(self.root)]),
              patch.object(self.recovery, "backup") as backup):
            self.recovery.main()
        backup.assert_called_once_with(keep_stopped=True)


if __name__ == "__main__":
    unittest.main()
