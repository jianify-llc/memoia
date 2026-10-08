"""只解析真实 Compose，不启动容器；凭据全部为测试生成值。"""
import json
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("memoia_recovery", SOURCE / "recovery.py")
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


@unittest.skipUnless(shutil.which("docker"), "Requires Docker Compose CLI")
class ComposeContract(unittest.TestCase):
    def test_host_tunnel_ro_config_and_fixed_data_paths(self):
        with tempfile.TemporaryDirectory(prefix="memoia-compose-") as directory:
            root = Path(directory)
            (root / "api").mkdir()
            shutil.copyfile(SOURCE / "docker-compose.yml", root / "docker-compose.yml")
            shutil.copyfile(SOURCE / "config.yaml.example", root / "api/config.yaml")
            values = {
                "JIANIFY_ENV": "test", "COMPOSE_PROJECT_NAME": "memoia-test",
                "MEMOIA_IMAGE": "ghcr.io/jianify-llc/memoia@sha256:" + "a" * 64,
                "REDIS_PASSWORD": "fixture-only",
                "DATABASE_URL": "postgresql://jianify_app:fixture-only@jianify-postgres:5432/memoia",
                "REDIS_URL": "redis://:fixture-only@redis:6379/0",
                "ACCESS_TOKEN": "fixture-only", "PROJECT_ID": "fixture",
                "MEMOBASE_LLM_API_KEY": "fixture-only", "MEMOBASE_EMBEDDING_API_KEY": "fixture-only",
                "API_HOSTS": "https://test-memoia.jianify.dev",
            }
            lines = []
            for line in (SOURCE / ".env.example").read_text().splitlines():
                if line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    line = key + "=" + values.get(key, value)
                lines.append(line)
            env = root / ".env"
            env.write_text("\n".join(lines) + "\n")
            result = subprocess.run(["docker", "compose", "--env-file", str(env), "-f", str(root / "docker-compose.yml"),
                                     "config", "--format", "json"], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(result.stdout)
            self.assertEqual(config["name"], "memoia-test")
            self.assertEqual(set(config["services"]), {"redis", "memoia", "maintenance"})
            self.assertFalse(config["services"]["redis"].get("ports"))
            self.assertEqual(config["services"]["redis"]["volumes"][0]["source"], "/opt/memoia/data/redis")
            self.assertEqual(config["networks"]["data"]["name"], "jianify-data")
            self.assertTrue(config["networks"]["data"]["external"])
            api = config["services"]["memoia"]
            self.assertEqual(api["ports"][0]["host_ip"], "127.0.0.1")
            self.assertEqual(api["ports"][0]["published"], "8000")
            volume = api["volumes"][0]
            self.assertEqual(volume["target"], "/app/config.yaml")
            self.assertTrue(volume["read_only"])
            self.assertFalse(volume["bind"].get("create_host_path", False))
            self.assertNotIn("MEMOBASE_EMBEDDING_MODEL", api["environment"])
            self.assertEqual(api["labels"]["io.jianify.environment"], "test")
            self.assertIn("data", api["networks"])
            self.assertIn("ingress", api["networks"])
            self.assertFalse(config["networks"]["ingress"].get("internal", False))
            self.assertEqual(api["environment"]["DATABASE_URL"], values["DATABASE_URL"])
            worker = config["services"]["maintenance"]
            self.assertFalse(worker.get("ports"))
            self.assertEqual(worker["image"], api["image"])
            self.assertEqual(worker["volumes"], api["volumes"])
            self.assertEqual(worker["networks"], api["networks"])
            self.assertEqual(worker["command"], ["/app/.venv/bin/python", "-m", "memoia_server.maintenance_worker"])
            self.assertEqual(worker["healthcheck"]["test"][-1], "--healthcheck")
            self.assertEqual(worker["environment"]["MAINTENANCE_CONCURRENCY"], "2")
            self.assertEqual({key: value for key, value in worker["environment"].items()
                              if key != "MAINTENANCE_CONCURRENCY"}, api["environment"])
            target = root / "rehearsals/restore-fixture"
            (target / "api").mkdir(parents=True)
            (target / "api/config.yaml").write_text("fixture-only")
            candidate = recovery.isolated_config(
                config, {"postgres_image": "pgvector/pgvector:pg17@sha256:" + "b" * 64}, target)
            file = target / "docker-compose.json"
            file.write_text(json.dumps(candidate))
            isolated = subprocess.run(["docker", "compose", "--env-file", str(env), "-f", str(file),
                                       "--project-name", candidate["name"],
                                       "config", "--format", "json"], capture_output=True, text=True, timeout=30)
            self.assertEqual(isolated.returncode, 0, isolated.stderr)
            effective = json.loads(isolated.stdout)
            recovery.validate_isolation(effective, target, config)
            self.assertTrue(effective["networks"]["backend"]["internal"])
            self.assertTrue(effective["networks"]["data"]["internal"])
            self.assertFalse(effective["networks"]["ingress"].get("internal", False))
            self.assertEqual(set(effective["services"]["redis"]["networks"]), {"backend"})
            self.assertEqual(set(effective["services"]["postgres"]["networks"]), {"data"})
            self.assertFalse(effective["services"]["maintenance"].get("ports"))
            self.assertEqual(effective["services"]["maintenance"]["volumes"], effective["services"]["memoia"]["volumes"])
            self.assertEqual(env.read_text(), "\n".join(lines) + "\n")


if __name__ == "__main__":
    unittest.main()
