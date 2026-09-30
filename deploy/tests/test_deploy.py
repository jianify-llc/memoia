"""发布脚本安全契约：必须在无宿主机数据挂载的一次性 Linux 容器内运行。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]
ROOT = Path("/opt/memoia")
IMAGE = "ghcr.io/jianify/memoia@sha256:" + "e" * 64
OLD_IMAGE = "ghcr.io/jianify/memoia@sha256:" + "a" * 64
SHA = "d" * 40


@unittest.skipUnless(os.getenv("MEMOIA_DEPLOY_TEST_ISOLATED") == "1" and Path("/.dockerenv").exists() and os.geteuid() == 0,
                     "Requires an explicitly isolated disposable root Linux container")
class DeploymentBoundary(unittest.TestCase):
    def setUp(self):
        if ROOT.exists():
            self.skipTest("Refusing a pre-existing deployment directory")
        self.postgres_root = Path("/opt/postgres")
        if self.postgres_root.exists():
            self.skipTest("Refusing a pre-existing company PostgreSQL directory")
        self.postgres_root.mkdir(mode=0o700)
        (self.postgres_root / "postgresctl.py").write_text('''import json, os, sys
if sys.argv[1] == "fingerprint":
    print(os.getenv("FIXTURE_POSTGRES_FINGERPRINT", "a" * 64))
elif sys.argv[1] == "status":
    if os.getenv("FIXTURE_DB_UNAVAILABLE"):
        sys.exit(1)
    print(json.dumps({"container_id": os.getenv("FIXTURE_PG_CONTAINER_ID", "company-postgres"), "image": "pgvector/pgvector:pg17@sha256:" + "b" * 64,
                      "mount": "/opt/postgres/data", "network": "jianify-data", "healthy": True,
                      "fingerprint": os.getenv("FIXTURE_POSTGRES_FINGERPRINT", "a" * 64)}))
else:
    sys.exit(2)
''')
        ROOT.mkdir(parents=True, mode=0o700)
        (ROOT / "api").mkdir(mode=0o700)
        self.managed = {
            ROOT / ".env": "JIANIFY_ENV=test\nACCESS_TOKEN=fixture-only\n",
            ROOT / "api/config.yaml": "embedding_provider: openai\nembedding_model: fixture\nembedding_dim: 1536\n",
            ROOT / "docker-compose.yml": (SOURCE / "docker-compose.yml").read_text(),
        }
        for file, content in self.managed.items():
            file.write_text(content)
            file.chmod(0o644 if file.name == "docker-compose.yml" else 0o600)
        self.fixture = tempfile.TemporaryDirectory(prefix="memoia-deploy-test-")
        fixture = Path(self.fixture.name)
        (fixture / "image").write_text(OLD_IMAGE)
        mock = fixture / "mock-command.py"
        shutil.copyfile(SOURCE / "tests/mock-command.py", mock)
        mock.chmod(0o755)
        for command in ("docker", "systemctl", "curl"):
            (fixture / command).symlink_to(mock)
        self.env = dict(os.environ, PATH=str(fixture) + ":" + os.environ["PATH"], MEMOIA_FIXTURE=str(fixture))
        self.compose_sha = hashlib.sha256(self.managed[ROOT / "docker-compose.yml"].encode()).hexdigest()
        self.state = ROOT / ".deploy"
        self.state.mkdir(mode=0o700)
        result = self.run_command("bash", str(SOURCE / "infra-fingerprint.sh"), str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.state / "infra-config.sha256").write_text(result.stdout)
        (self.state / "schema.sha256").write_text("f" * 64 + "\n")
        (self.state / "deploy-state").write_text(f"100 {'b' * 40} {OLD_IMAGE}\n")

    def tearDown(self):
        # setUp 确认不存在后才创建；不接触真实主机或任何现有部署目录。
        shutil.rmtree(ROOT)
        shutil.rmtree(self.postgres_root)
        self.fixture.cleanup()

    def run_command(self, *args):
        return subprocess.run(args, text=True, capture_output=True, env=self.env, timeout=20)

    def deploy(self, mode="prepare", run="200"):
        return self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), mode, str(ROOT), IMAGE, SHA, run, self.compose_sha)

    def adopt(self):
        return self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "adopt-external-postgres",
                                str(ROOT), OLD_IMAGE, "b" * 40, "100", self.compose_sha)

    def assert_configs_unchanged(self):
        for file, content in self.managed.items():
            self.assertEqual(file.read_text(), content)

    def actions(self):
        file = Path(self.fixture.name) / "actions"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def test_init_creates_templates_with_empty_secrets_and_preserves_values(self):
        for file in self.managed:
            file.unlink()
        result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        env = ROOT / ".env"
        for key in ("JIANIFY_ENV", "MEMOIA_IMAGE", "DATABASE_URL", "REDIS_PASSWORD", "ACCESS_TOKEN", "MEMOBASE_LLM_API_KEY"):
            self.assertIn(key + "=\n", env.read_text())
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        self.assertEqual((ROOT / "api/config.yaml").stat().st_mode & 0o777, 0o600)
        env.write_text("JIANIFY_ENV=test\nACCESS_TOKEN=operator-filled-value\n")
        env.chmod(0o644)
        for _ in range(2):
            result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(ROOT))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(env.read_text(), "JIANIFY_ENV=test\nACCESS_TOKEN=operator-filled-value\n")
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.actions(), [])

    def test_init_does_not_change_existing_data_permissions(self):
        data = ROOT / "data/postgres"
        data.mkdir(parents=True, mode=0o750)
        os.chown(data, 999, 999)
        before = (data.stat().st_uid, data.stat().st_gid, data.stat().st_mode)
        result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((data.stat().st_uid, data.stat().st_gid, data.stat().st_mode), before)
        self.assert_configs_unchanged()

    def test_init_does_not_create_server_configuration(self):
        server_root = Path("/opt/jianify")
        if server_root.exists():
            self.skipTest("Refusing a pre-existing server directory")
        result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(server_root.exists())
        self.assert_configs_unchanged()

    def test_old_nested_root_is_rejected_without_side_effects(self):
        old_root = Path("/opt/jianify/memoia")
        result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(old_root))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(old_root.exists())
        self.assert_configs_unchanged()
        self.assertEqual(self.actions(), [])

    def test_init_refuses_symlink_config(self):
        file = ROOT / ".env"
        file.unlink()
        destination = Path(self.fixture.name) / "secret"
        destination.write_text("do-not-change")
        file.symlink_to(destination)
        result = self.run_command("bash", str(SOURCE / "deploy-memoia.sh"), "init-config", str(ROOT))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(destination.read_text(), "do-not-change")

    def test_prepare_finalize_only_update_api_and_state(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.deploy("finalize")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_configs_unchanged()
        self.assertIn(IMAGE, (self.state / "deploy-state").read_text())
        self.assertFalse((ROOT / "image.env").exists())
        self.assertFalse((self.state / "pending-deploy").exists())
        actions = self.actions()
        self.assertEqual(len(actions), 3)
        self.assertTrue(all(action["args"][-1] == "memoia" for action in actions))
        self.assertIn("--no-deps", actions[-1]["args"])
        self.assertIn("--no-build", actions[-1]["args"])
        self.assertEqual(actions[-1]["image"], IMAGE)

    def test_live_api_drift_blocks_switch_without_pending_or_stop(self):
        self.env["FIXTURE_CURRENT_IMAGE"] = "ghcr.io/jianify/memoia@sha256:" + "f" * 64
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Running API differs from the accepted deployment", result.stderr)
        self.assertFalse((self.state / "pending-deploy").exists())
        self.assertTrue(all("pull" in action["args"] for action in self.actions()))
        self.assert_configs_unchanged()

    def test_missing_accepted_record_blocks_switch_without_stop(self):
        (self.state / "deploy-state").unlink()
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertFalse((self.state / "pending-deploy").exists())
        self.assertTrue(all("pull" in action["args"] for action in self.actions()))

    def test_missing_configuration_is_not_created(self):
        file = ROOT / "api/config.yaml"
        file.unlink()
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertFalse(file.exists())
        self.assertEqual(self.actions(), [])

    def test_wrong_permissions_are_not_repaired(self):
        file = ROOT / ".env"
        file.chmod(0o644)
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(file.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.actions(), [])

    def test_online_release_checks_its_own_branch_and_keeps_infrastructure(self):
        self.managed[ROOT / ".env"] = "JIANIFY_ENV=online\nACCESS_TOKEN=fixture-only\n"
        (ROOT / ".env").write_text(self.managed[ROOT / ".env"])
        self.env["FIXTURE_ENV"] = "online"
        self.env["FIXTURE_EXPECT_BRANCH"] = "release"
        fingerprint = self.run_command("bash", str(SOURCE / "infra-fingerprint.sh"), str(ROOT))
        self.assertEqual(fingerprint.returncode, 0, fingerprint.stderr)
        (self.state / "infra-config.sha256").write_text(fingerprint.stdout)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.deploy("finalize")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_configs_unchanged()
        self.assertEqual(len(self.actions()), 3)

    def test_stale_or_unresolved_run_cannot_update_api(self):
        self.assertNotEqual(self.deploy(run="99").returncode, 0)
        (self.state / "pending-deploy").write_text("unknown-result")
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.actions(), [])
        self.assert_configs_unchanged()

    def test_update_without_standalone_marker_succeeds(self):
        self.assertFalse((self.state / "standalone-mode").exists())
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deploy("finalize").returncode, 0)
        self.assert_configs_unchanged()

    def test_routine_update_does_not_probe_inflight_buffers_or_redis_queues(self):
        self.env["FIXTURE_NO_DRAIN_PROBES"] = "1"
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deploy("finalize").returncode, 0)
        self.assertTrue(all(action["args"][-1] == "memoia" for action in self.actions()))
        self.assert_configs_unchanged()

    def test_disconnected_tunnel_blocks_update(self):
        self.env["FIXTURE_TUNNEL_DOWN"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.actions(), [])

    def test_changed_embedding_config_requires_maintenance(self):
        (ROOT / "api/config.yaml").write_text("embedding_model: another-model-same-dimension\nembedding_dim: 1536\n")
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.actions(), [])

    def test_secret_change_between_phases_cannot_commit_success(self):
        self.assertEqual(self.deploy().returncode, 0)
        (ROOT / ".env").write_text("JIANIFY_ENV=test\nACCESS_TOKEN=rotated-fixture\n")
        self.assertNotEqual(self.deploy("finalize").returncode, 0)
        self.assertTrue((self.state / "pending-deploy").exists())
        self.assertTrue((self.state / "deploy-state").read_text().startswith("100 "))

    def test_failed_candidate_keeps_unknown_state(self):
        self.env["FIXTURE_UNHEALTHY"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.state / "pending-deploy").exists())
        self.assert_configs_unchanged()

    def test_schema_change_blocks_before_stop(self):
        self.env["FIXTURE_SCHEMA"] = "a" * 64
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertFalse(any("stop" in a["args"] or "up" in a["args"] for a in self.actions()))
        self.assertFalse((self.state / "pending-deploy").exists())

    def test_incorrect_revision_blocks_before_stop(self):
        self.env["FIXTURE_REVISION"] = "a" * 40
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertFalse(any("stop" in a["args"] or "up" in a["args"] for a in self.actions()))

    def test_force_killed_api_is_not_followed_by_candidate_start(self):
        self.env["FIXTURE_FORCE_KILL"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.state / "pending-deploy").exists())
        self.assertFalse(any("up" in a["args"] for a in self.actions()))

    def test_recovery_is_explicit_and_preserves_run_high_water(self):
        self.assertNotEqual(self.deploy("restore-api", run="99").returncode, 0)
        config_sha = self.run_command("bash", "-c", "sha256sum /opt/memoia/.env /opt/memoia/api/config.yaml | sha256sum | cut -d' ' -f1").stdout.strip()
        accepted = f"99 {SHA} {IMAGE} {self.compose_sha} {config_sha}\n"
        (self.state / "previous-accepted").write_text(accepted)
        (self.state / "accepted").mkdir()
        (self.state / "accepted" / SHA).write_text(accepted)
        self.assertEqual(self.deploy("restore-api", run="99").returncode, 0)
        self.assertEqual(self.deploy("finalize", run="99").returncode, 0)
        self.assertTrue((self.state / "deploy-state").read_text().startswith("100 "))
        self.assertNotEqual(self.deploy(run="100").returncode, 0)

    def test_first_install_is_empty_only_and_does_not_grant_acceptance(self):
        for file in ("infra-config.sha256", "schema.sha256", "deploy-state"):
            (self.state / file).unlink()
        for service in ("redis",):
            (ROOT / "data" / service).mkdir(parents=True)
        self.env["FIXTURE_EMPTY_STACK"] = "1"
        result = self.deploy("init")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.state / "pending-deploy").exists())
        self.assertFalse((self.state / "deploy-state").exists())
        self.assertFalse((self.state / "standalone-mode").exists())
        self.assert_configs_unchanged()

    def test_first_install_refuses_existing_data(self):
        for file in ("infra-config.sha256", "schema.sha256", "deploy-state"):
            (self.state / file).unlink()
        for service in ("redis",):
            (ROOT / "data" / service).mkdir(parents=True)
        self.env["FIXTURE_DB_TABLES"] = "3"
        self.env["FIXTURE_EMPTY_STACK"] = "1"
        self.assertNotEqual(self.deploy("init").returncode, 0)
        self.assertFalse(any("up" in a["args"] for a in self.actions()))

    def test_noncanonical_resolved_data_path_is_rejected_before_pull_or_start(self):
        self.env["FIXTURE_DATA_ROOT"] = "/opt/memoia/dat"
        for mode in ("init", "prepare", "finalize"):
            with self.subTest(mode=mode):
                self.assertNotEqual(self.deploy(mode).returncode, 0)
        self.assertEqual(self.actions(), [])

    def test_external_database_target_is_rejected_before_pull_or_start(self):
        self.env["FIXTURE_DATABASE_URL"] = "postgresql://fixture:fixture@another-project/fixture"
        self.assertNotEqual(self.deploy("init").returncode, 0)
        self.assertEqual(self.actions(), [])

    def test_company_postgres_drift_blocks_routine_publish(self):
        self.env["FIXTURE_POSTGRES_FINGERPRINT"] = "b" * 64
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Infrastructure configuration changed", result.stderr)
        self.assertEqual(self.actions(), [])

    def test_company_postgres_unavailable_blocks_before_pull(self):
        self.env["FIXTURE_DB_UNAVAILABLE"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.actions(), [])

    def test_running_api_database_drift_blocks_switch(self):
        self.env["FIXTURE_LIVE_DATABASE_URL"] = "postgresql://jianify_app:fixture@another-host/memoia"
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Running API database connection drifted", result.stderr)
        self.assertFalse((self.state / "pending-deploy").exists())

    def test_postgres_replacement_between_prepare_and_finalize_blocks_acceptance(self):
        self.assertEqual(self.deploy().returncode, 0)
        self.env["FIXTURE_PG_CONTAINER_ID"] = "replacement-postgres"
        result = self.deploy("finalize")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Company PostgreSQL changed", result.stderr)
        self.assertTrue((self.state / "pending-deploy").exists())

    def test_explicit_adoption_rebaselines_after_migrated_api_verification(self):
        self.env["FIXTURE_POSTGRES_FINGERPRINT"] = "b" * 64
        self.env["FIXTURE_DB_TABLES"] = "3"
        result = self.adopt()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "infra-config.sha256").read_text(),
                         self.run_command("bash", str(SOURCE / "infra-fingerprint.sh"), str(ROOT)).stdout)
        self.assertTrue((self.state / "pre-external-postgres").exists())
        self.assertFalse((self.state / "pending-maintenance").exists())
        self.assertEqual(self.deploy().returncode, 0)

    def test_adoption_rejects_unverified_database_before_rebaselining(self):
        self.env["FIXTURE_POSTGRES_FINGERPRINT"] = "b" * 64
        self.env["FIXTURE_DB_TABLES"] = "0"
        result = self.adopt()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.state / "deploy-state").read_text().split()[0], "100")
        self.assertFalse((self.state / "pre-external-postgres").exists())

    def test_adoption_refuses_running_old_postgres(self):
        self.env["FIXTURE_POSTGRES_FINGERPRINT"] = "b" * 64
        self.env["FIXTURE_DB_TABLES"] = "3"
        self.env["FIXTURE_OLD_POSTGRES_RUNNING"] = "1"
        result = self.adopt()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("old Memoia PostgreSQL", result.stderr)
        self.assertFalse((self.state / "pre-external-postgres").exists())

    def test_healthy_after_oom_cannot_be_accepted(self):
        self.env["FIXTURE_OOM"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.state / "pending-deploy").exists())
        self.assertNotEqual(self.deploy("finalize").returncode, 0)
        self.assertTrue((self.state / "deploy-state").read_text().startswith("100 "))


if __name__ == "__main__":
    unittest.main()
