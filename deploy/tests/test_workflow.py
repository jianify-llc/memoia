"""执行真实 workflow 的部署 shell；外部命令全部 mock，不连接 SSH/GitHub/业务 API。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/publish.yaml"
SHA = "d" * 40
MOCK = r'''
import json, os, pathlib, sys
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ["WORKFLOW_FIXTURE"])
record = {"command": command, "args": args if command != "bash" else args[:1]}
if command == "git":
    assert args == ["ls-remote", "origin", "refs/heads/test"]
    print(os.environ.get("FIXTURE_HEAD", "d" * 40) + "\trefs/heads/test")
    sys.exit(0)
if command == "ssh":
    for flag in ("-i",):
        path = pathlib.Path(args[args.index(flag) + 1])
        assert path.is_file() and path.stat().st_mode & 0o777 == 0o600
    hostfile = next(arg.split("=", 1)[1] for arg in args if arg.startswith("UserKnownHostsFile="))
    assert pathlib.Path(hostfile).stat().st_mode & 0o777 == 0o600
    if "sudo -n tar " in args[-1]:
        sys.stdin.read()
elif command == "tar":
    assert args == ["-C", "deploy", "-cf", "-", "deploy-memoia.sh", "infra-fingerprint.sh", "schema-fingerprint.sh", "recovery.py"]
    print("fixture-only archive")
elif command == "bash":
    assert args == ["deploy/smoke-api.sh", "https://test-memoia.jianify.dev", "fixture-bearer"]
else:
    sys.exit("Unexpected intermediary command")
with (root / "actions").open("a") as file:
    file.write(json.dumps(record) + "\n")
if command == "ssh" and os.getenv("FIXTURE_SSH_FAIL") and " prepare " in args[-1]:
    sys.exit(255)
if command == "bash" and os.getenv("FIXTURE_SMOKE_FAIL"):
    sys.exit(1)
'''


class PublicationContract(unittest.TestCase):
    def test_same_source_publications_are_serialized_without_cancellation(self):
        job = yaml.safe_load(WORKFLOW.read_text())["jobs"]["publish-test"]
        self.assertEqual(job["concurrency"], {
            "group": "memoia-publication-${{ github.repository }}-${{ github.sha }}",
            "cancel-in-progress": False,
        })

    def test_deployment_receipt_describes_only_basic_acceptance(self):
        job = yaml.safe_load(WORKFLOW.read_text())["jobs"]["deploy-test"]
        step = next(step for step in job["steps"] if step.get("name") == "Record successful test deployment")
        self.assertIn("Basic acceptance: API health, auth and user CRUD passed", step["run"])
        self.assertIn("not full memory acceptance", step["run"])


class DirectSSHWorkflow(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="memoia-workflow-")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        self.runner = self.root / "runner"
        self.runner.mkdir(mode=0o700)
        # 读取唯一真实步骤，不复制部署规则或改写测试目标脚本。
        workflow = yaml.safe_load(WORKFLOW.read_text())
        self.job = workflow["jobs"]["deploy-test"]
        steps = [step for step in self.job["steps"] if step.get("name") == "Deploy over direct SSH and smoke test the public API"]
        self.assertEqual(len(steps), 1)
        self.script = steps[0]["run"]
        mock = self.root / "mock"
        mock.write_text("#!" + sys.executable + "\n" + MOCK)
        mock.chmod(0o755)
        for command in ("git", "ssh", "tar", "bash", "docker", "cloudflared"):
            (self.root / command).symlink_to(mock)
        self.env = dict(os.environ, PATH=str(self.root) + ":" + os.environ["PATH"],
                        WORKFLOW_FIXTURE=str(self.root), RUNNER_TEMP=str(self.runner),
                        SSH_PRIVATE_KEY="fixture-only-not-a-real-key", SSH_KNOWN_HOSTS="fixture-only-known-hosts",
                        DEPLOY_HOST="203.0.113.10", DEPLOY_PORT="22", DEPLOY_USER="github",
                        TEST_BEARER_TOKEN="fixture-bearer", GITHUB_SHA=SHA, GITHUB_RUN_ID="200",
                        REGISTRY="ghcr.io", IMAGE_NAME="jianify/memoia", MANIFEST_DIGEST="sha256:" + "a" * 64)
        for name in ("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "TUNNEL_SERVICE_TOKEN_ID", "TUNNEL_SERVICE_TOKEN_SECRET"):
            self.env.pop(name, None)

    def run_step(self):
        return subprocess.run(["/bin/bash", "-c", self.script], env=self.env, cwd=WORKFLOW.parents[2],
                              capture_output=True, text=True, timeout=15)

    def actions(self):
        file = self.root / "actions"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def assert_keys_cleaned(self):
        self.assertEqual(list(self.runner.iterdir()), [])

    def test_direct_ssh_without_access_preserves_two_phase_release(self):
        self.assertFalse(any("CF_ACCESS" in value for value in self.job["env"].values()))
        for name in ("DEPLOY_HOST", "DEPLOY_PORT", "DEPLOY_USER"):
            self.assertEqual(self.job["env"][name], "${{ secrets." + name + " }}")
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [action["args"] for action in self.actions() if action["command"] == "ssh"]
        self.assertEqual(len(calls), 4)
        for args in calls:
            self.assertEqual(args[-2], "github@203.0.113.10")
            self.assertEqual(args[args.index("-p") + 1], "22")
            self.assertEqual(args[args.index("-F") + 1], "/dev/null")
            for option in ("BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=15"):
                self.assertIn(option, args)
            self.assertFalse(any("Proxy" in arg or "cloudflared" in arg for arg in args))
        self.assertIn(" prepare '/opt/memoia'", calls[2][-1])
        self.assertIn(" finalize '/opt/memoia'", calls[3][-1])
        commands = [action["command"] for action in self.actions()]
        self.assertLess(commands.index("bash"), len(commands) - 1)
        self.assertEqual(commands[-1], "ssh")
        self.assert_keys_cleaned()

    def test_dns_target_and_custom_port(self):
        self.env.update(DEPLOY_HOST="test-vps.example.com", DEPLOY_PORT="2222")
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        for action in self.actions():
            if action["command"] == "ssh":
                self.assertEqual(action["args"][-2], "github@test-vps.example.com")
                self.assertEqual(action["args"][action["args"].index("-p") + 1], "2222")
        self.assert_keys_cleaned()

    def test_missing_required_value_fails_before_upload(self):
        for name in ("DEPLOY_HOST", "DEPLOY_PORT", "DEPLOY_USER", "SSH_PRIVATE_KEY", "SSH_KNOWN_HOSTS"):
            with self.subTest(name=name):
                previous = self.env.pop(name)
                self.assertNotEqual(self.run_step().returncode, 0)
                self.env[name] = previous
                self.assertEqual(self.actions(), [])
                self.assert_keys_cleaned()

    def test_invalid_host_fails_closed(self):
        for host in ("-oProxyCommand=bad", "host user", "https://example.com", "user@host"):
            with self.subTest(host=host):
                self.env["DEPLOY_HOST"] = host
                self.assertNotEqual(self.run_step().returncode, 0)
                self.assertEqual(self.actions(), [])
                self.assert_keys_cleaned()

    def test_invalid_port_fails_closed(self):
        for port in ("0", "65536", "123456", "22x"):
            with self.subTest(port=port):
                self.env["DEPLOY_PORT"] = port
                self.assertNotEqual(self.run_step().returncode, 0)
                self.assertEqual(self.actions(), [])
                self.assert_keys_cleaned()

    def test_other_user_is_rejected(self):
        self.env["DEPLOY_USER"] = "ubuntu"
        self.assertNotEqual(self.run_step().returncode, 0)
        self.assertEqual(self.actions(), [])
        self.assert_keys_cleaned()

    def test_stale_sha_cannot_connect(self):
        self.env["FIXTURE_HEAD"] = "e" * 40
        self.assertNotEqual(self.run_step().returncode, 0)
        self.assertEqual(self.actions(), [])
        self.assert_keys_cleaned()

    def test_prepare_connection_failure_cannot_smoke_or_finalize(self):
        self.env["FIXTURE_SSH_FAIL"] = "1"
        self.assertNotEqual(self.run_step().returncode, 0)
        self.assertEqual(sum(action["command"] == "ssh" for action in self.actions()), 3)
        self.assertIn(" prepare ", self.actions()[-1]["args"][-1])
        self.assertFalse(any(action["command"] == "bash" or " finalize " in action["args"][-1] for action in self.actions()))
        self.assert_keys_cleaned()

    def test_smoke_failure_cannot_finalize(self):
        self.env["FIXTURE_SMOKE_FAIL"] = "1"
        self.assertNotEqual(self.run_step().returncode, 0)
        self.assertTrue(any(action["command"] == "bash" for action in self.actions()))
        self.assertFalse(any(" finalize " in action["args"][-1] for action in self.actions()))
        self.assert_keys_cleaned()


if __name__ == "__main__":
    unittest.main()
