"""只解析真实 Compose，不启动容器；凭据全部为测试生成值。"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]


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
                "MEMOIA_IMAGE": "ghcr.io/jianify/memoia@sha256:" + "a" * 64,
                "POSTGRES_PASSWORD": "fixture-only", "REDIS_PASSWORD": "fixture-only",
                "DATABASE_URL": "postgresql://memoia:fixture-only@postgres:5432/memoia",
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
            self.assertEqual(set(config["services"]), {"postgres", "redis", "memoia"})
            for service in ("postgres", "redis"):
                self.assertFalse(config["services"][service].get("ports"))
                self.assertEqual(config["services"][service]["volumes"][0]["source"], "/opt/memoia/data/" + service)
            api = config["services"]["memoia"]
            self.assertEqual(api["ports"][0]["host_ip"], "127.0.0.1")
            self.assertEqual(api["ports"][0]["published"], "8000")
            volume = api["volumes"][0]
            self.assertEqual(volume["target"], "/app/config.yaml")
            self.assertTrue(volume["read_only"])
            self.assertFalse(volume["bind"].get("create_host_path", False))
            self.assertNotIn("MEMOBASE_EMBEDDING_MODEL", api["environment"])
            self.assertEqual(api["labels"]["io.jianify.environment"], "test")
            self.assertEqual(env.read_text(), "\n".join(lines) + "\n")


if __name__ == "__main__":
    unittest.main()
