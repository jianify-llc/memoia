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


class BackupBoundary(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state = self.root / ".deploy"
        self.state.mkdir()
        (self.state / "deploy-state").write_text("100 fixture-source fixture-image\n")
        override = patch.object(recovery, "ROOT", self.root)
        override.start()
        self.addCleanup(override.stop)

    def test_backup_does_not_require_standalone_marker(self):
        with patch.object(recovery, "run", side_effect=RuntimeError("fixture-config-stage")) as command:
            with self.assertRaisesRegex(RuntimeError, "fixture-config-stage"):
                recovery.backup()
        self.assertEqual(command.call_count, 1)

    def test_unresolved_deployment_or_maintenance_blocks_before_commands(self):
        for name in ("pending-deploy", "pending-maintenance"):
            with self.subTest(name=name):
                pending = self.state / name
                pending.touch()
                with patch.object(recovery, "run") as command:
                    with self.assertRaisesRegex(RuntimeError, "Unresolved"):
                        recovery.backup()
                    command.assert_not_called()
                pending.unlink()

    def test_backup_still_requires_quiescent_processing_and_redis_state(self):
        config = {"services": {"memoia": {"environment": {"PROJECT_ID": "fixture"}}}}
        for results in (["1"], ["0", "fixture-lock"], ["0", "", "fixture-queue"]):
            with self.subTest(results=results), patch.object(recovery, "run", side_effect=results):
                with self.assertRaises(RuntimeError):
                    recovery.check_quiet(["docker", "compose"], config, "company-postgres")

    def test_paired_backup_dumps_only_memoia_database_and_redis_at_one_cutpoint(self):
        (self.root / "api").mkdir()
        (self.root / "data/redis").mkdir(parents=True)
        for name in (".env", "docker-compose.yml"):
            (self.root / name).write_text("fixture-only")
        (self.root / "api/config.yaml").write_text("fixture-only")
        (self.root / "data/redis/dump.rdb").write_bytes(b"redis-snapshot")
        (self.state / "schema.sha256").write_text("f" * 64)
        (self.state / "infra-config.sha256").write_text("current-fingerprint")
        database_url = "postgresql://jianify_app:fixture@jianify-postgres/memoia"
        config = {"name": "memoia-test", "services": {"redis": {"image": "redis-image"},
                  "memoia": {"environment": {"PROJECT_ID": "fixture", "DATABASE_URL": database_url}}}}
        postgres = {"container_id": "company-postgres", "image": "pgvector/pgvector:pg17@sha256:" + "a" * 64,
                    "fingerprint": "company-fingerprint"}
        calls = []
        stopped = False

        def command(args, *, input=None, output=None):
            nonlocal stopped
            calls.append(args)
            if args[-2:] == ["--format", "json"]:
                return json.dumps(config)
            if args[0] == "bash":
                return "current-fingerprint"
            if args[:3] == ["docker", "exec", "-i"]:
                if "pg_dump" in args:
                    output.write(b"pg-dump")
                    return None
                if "pg_tables" in args[-1]:
                    return "users"
                return "0"
            if "--scan" in args:
                return ""
            if "SET" in args or "SAVE" in args:
                return "OK"
            if "ps" in args:
                return args[-1]
            if "stop" in args:
                stopped = True
                return ""
            if "up" in args:
                return ""
            raise AssertionError(args)

        def live(container):
            if container == "redis":
                return {"Config": {"Image": "redis-image"}, "Mounts": [
                    {"Source": str(self.root / "data/redis"), "Destination": "/data"}]}
            return {"Config": {"Image": "fixture-image", "Env": ["DATABASE_URL=" + database_url]}, "State": {
                "Health": {"Status": "healthy"}, "Running": not stopped, "ExitCode": 0}}

        with (patch.object(recovery, "run", side_effect=command), patch.object(recovery, "inspect", side_effect=live),
              patch.object(recovery, "company_postgres", return_value=postgres),
              patch.object(recovery, "database_counts", return_value={"users": 1}),
              patch.object(recovery, "secure_file"), patch.object(recovery, "wait_healthy")):
            recovery.backup()

        self.assertFalse((self.state / "pending-maintenance").exists())
        backup = next((self.state / "backups").iterdir())
        self.assertEqual((backup / "postgres.dump").read_bytes(), b"pg-dump")
        self.assertEqual((backup / "redis.rdb").read_bytes(), b"redis-snapshot")
        self.assertEqual(json.loads((backup / "backup.json").read_text())["postgres_image"], postgres["image"])
        dump = next(args for args in calls if "pg_dump" in args)
        self.assertEqual(dump[:4], ["docker", "exec", "-i", "company-postgres"])
        self.assertEqual(dump[-5:], ["-U", "jianify_app", "-d", "memoia", "-Fc"])
        self.assertLess(next(i for i, args in enumerate(calls) if "stop" in args),
                        next(i for i, args in enumerate(calls) if "pg_dump" in args))


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
                         "postgres_image": "pgvector/pgvector:pg17@sha256:" + "a" * 64,
                         "redis_probe": ["fixture-probe", "fixture-value"]}
        (self.backup / "backup.json").write_text(json.dumps(self.manifest))
        self.source = {
            "name": "memoia-test", "networks": {"backend": {"name": "memoia-test_backend"},
                                                  "data": {"name": "jianify-data", "external": True}},
            "services": {
                "redis": {"volumes": [{"source": str(self.root / "data/redis"), "target": "/data"}],
                          "command": ["sh", "-c", "exec redis-server --appendonly yes"]},
                "memoia": {"ports": [{"published": "8000"}], "volumes": [{"source": "config.yaml", "target": "/app/config.yaml"}],
                           "environment": {"DATABASE_URL": "postgresql://jianify_app:fixture@jianify-postgres/memoia",
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
        self.assertEqual(config["services"]["postgres"]["networks"]["data"]["aliases"], ["jianify-postgres"])
        self.assertFalse(any(net.get("external") for net in config["networks"].values()))
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
        config["networks"]["backend"]["internal"] = True
        config["networks"]["data"] = {"name": "memoia-restore-fixture_data", "internal": True}
        config["services"]["redis"]["volumes"][0]["source"] = str(self.target / "data/redis")
        config["services"]["postgres"] = {
            "environment": {"POSTGRES_USER": "jianify_app", "POSTGRES_PASSWORD": "fixture", "POSTGRES_DB": "memoia"},
            "volumes": [{"source": str(self.target / "data/postgres"), "target": "/var/lib/postgresql/data"}],
            "networks": {"data": {"aliases": ["jianify-postgres"]}},
        }
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
