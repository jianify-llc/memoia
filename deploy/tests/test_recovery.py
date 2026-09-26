"""恢复边界和 RDB→AOF 执行顺序；不连接真实 Docker 或数据库。"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("memoia_recovery", Path(__file__).parents[1] / "recovery.py")
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class RestoreBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "memoia"
        self.backup = self.root / ".deploy/backups/fixture"
        self.backup.mkdir(parents=True)
        self.target = self.root / "rehearsals/restore-fixture"
        for name in (".env", "config.yaml", "docker-compose.yml", "postgres.dump", "redis.rdb"):
            (self.backup / name).write_text("fixture-only")
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.backup.iterdir()}
        self.manifest = {"image": "fixture-image", "hashes": hashes, "database_counts": {"users": 1},
                         "redis_probe": ["fixture-probe", "fixture-value"]}
        (self.backup / "backup.json").write_text(json.dumps(self.manifest))
        self.source = {
            "name": "memoia-test", "networks": {"backend": {"name": "memoia-test_backend"}},
            "services": {
                "postgres": {"volumes": [{"source": str(self.root / "data/postgres"), "target": "/var/lib/postgresql/data"}]},
                "redis": {"volumes": [{"source": str(self.root / "data/redis"), "target": "/data"}],
                          "command": ["sh", "-c", "exec redis-server --appendonly yes"]},
                "memoia": {"ports": [{"published": "8000"}], "volumes": [{"source": "config.yaml", "target": "/app/config.yaml"}],
                           "environment": {"DATABASE_URL": "postgresql://fixture:fixture@postgres/fixture",
                                           "REDIS_URL": "redis://:fixture@redis/0"}}
            }}
        self.calls = []
        self.counts = patch.object(recovery, "database_counts", return_value={"users": 1})
        self.addCleanup(self.counts.stop)
        self.counts.start()
        for p in (patch.object(recovery, "ROOT", self.root), patch.object(recovery, "run", side_effect=self.mock_run),
                  patch.object(recovery, "inspect", side_effect=self.inspect),
                  patch.object(recovery.subprocess, "run", return_value=SimpleNamespace(returncode=0))):
            p.start()
            self.addCleanup(p.stop)

    def mock_run(self, args, **kwargs):
        self.calls.append(args)
        if "config" in args:
            file = Path(args[args.index("-f") + 1])
            if file == self.target / "docker-compose.yml":
                return file.read_text()
            return json.dumps(self.source)
        if "ps" in args:
            return "" if "-aq" in args else args[-1]
        if "GET" in args:
            return "fixture-value"
        if "CONFIG" in args:
            return "OK"
        if "INFO" in args:
            return "aof_rewrite_in_progress:0\naof_rewrite_scheduled:0\naof_last_bgrewrite_status:ok"
        return ""

    def inspect(self, container):
        return {"State": {"Health": {"Status": "healthy"}, "ExitCode": 0}, "HostConfig": {"PortBindings": {}},
                "Mounts": [{"Source": str(self.target / "data" / container)}]}

    def test_restore_is_isolated_and_verifies_rdb_then_aof_restart(self):
        recovery.restore(self.backup, self.target)
        config = json.loads((self.target / "docker-compose.yml").read_text())
        self.assertEqual(config["name"], "memoia-restore-fixture")
        self.assertNotIn("ports", config["services"]["memoia"])
        self.assertTrue(all("--project-name" in call for call in self.calls[1:]))
        get = [i for i, call in enumerate(self.calls) if "GET" in call]
        enable = next(i for i, call in enumerate(self.calls) if "CONFIG" in call)
        stop = next(i for i, call in enumerate(self.calls) if "stop" in call)
        self.assertEqual(len(get), 2)
        self.assertLess(get[0], enable)
        self.assertLess(enable, stop)
        self.assertLess(stop, get[1])
        self.assertIn("--appendonly yes", config["services"]["redis"]["command"][2])
        self.assertEqual((self.target / "data/redis/dump.rdb").read_text(), "fixture-only")

    def test_existing_even_empty_target_is_rejected(self):
        self.target.mkdir(parents=True)
        with self.assertRaises(RuntimeError):
            recovery.restore(self.backup, self.target)
        self.assertEqual(self.calls, [])

    def test_modified_backup_is_rejected_before_target_creation(self):
        (self.backup / "redis.rdb").write_text("old-snapshot")
        with self.assertRaises(RuntimeError):
            recovery.restore(self.backup, self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.calls, [])

    def test_formal_project_network_mount_port_and_connection_are_rejected(self):
        config = copy.deepcopy(self.source)
        with self.assertRaises(RuntimeError):
            recovery.validate_isolation(config, self.target, self.source)
        config["name"] = "memoia-restore-fixture"
        config["services"]["memoia"].pop("ports")
        config["networks"]["backend"]["name"] = "memoia-restore-fixture_backend"
        for service in ("postgres", "redis"):
            config["services"][service]["volumes"][0]["source"] = str(self.target / "data" / service)
        recovery.validate_isolation(config, self.target, self.source)
        for change in ("port", "network", "mount", "connection"):
            bad = copy.deepcopy(config)
            if change == "port": bad["services"]["memoia"]["ports"] = ["8000:8000"]
            if change == "network": bad["networks"]["backend"]["name"] = "memoia-test_backend"
            if change == "mount": bad["services"]["redis"]["volumes"][0]["source"] = str(self.root / "data/redis")
            if change == "connection": bad["services"]["memoia"]["environment"]["DATABASE_URL"] = "postgresql://external-host/db"
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                recovery.validate_isolation(bad, self.target, self.source)


if __name__ == "__main__":
    unittest.main()
