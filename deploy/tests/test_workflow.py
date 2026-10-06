"""执行真实 workflow 的部署 shell；外部命令全部 mock，不连接 SSH/GitHub/业务 API。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/deploy-test.yml"
ONLINE_WORKFLOW = WORKFLOW.with_name("deploy-online.yml")
VERIFY_WORKFLOW = WORKFLOW.with_name("verify.yml")
SHA = "d" * 40
MOCK = r'''
import json, os, pathlib, sys
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ["WORKFLOW_FIXTURE"])
record = {"command": command, "args": args if command != "bash" else args[:1]}
if command == "git":
    branch = os.environ.get("FIXTURE_BRANCH", "test")
    assert args == ["ls-remote", "origin", "refs/heads/" + branch]
    print(os.environ.get("FIXTURE_HEAD", "d" * 40) + "\trefs/heads/" + branch)
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
    assert args == ["-C", "deploy", "-cf", "-", "deploy-memoia.sh", "infra-fingerprint.sh", "schema-fingerprint.sh", "recovery.py", "schema-maintenance.py"]
    print("fixture-only archive")
elif command == "bash":
    assert args == ["deploy/smoke-api.sh", os.environ.get("FIXTURE_API", "https://test-memoia.jianify.dev"), "fixture-bearer"]
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
    def test_cloud_only_builds_images_and_keeps_runner_budgets(self):
        verify_source = VERIFY_WORKFLOW.read_text()
        for path in (WORKFLOW, ONLINE_WORKFLOW, VERIFY_WORKFLOW):
            self.assertNotIn("scripts/verify_local.py", path.read_text())
            self.assertNotIn("pytest", path.read_text())
            self.assertNotIn("pnpm test", path.read_text())
            self.assertNotIn("setup-node", path.read_text())
        build = next(step for step in yaml.safe_load(verify_source)["jobs"]["verify"]["steps"] if "docker/build-push-action" in step.get("uses", ""))
        self.assertFalse(build["with"]["push"])
        self.assertTrue(build["with"]["load"])
        self.assertEqual(build["with"]["context"], "./src/server/api")
        self.assertEqual(build["with"]["platforms"], "linux/amd64")
        self.assertIn("import memoia_server", verify_source)
        self.assertIn("--network none", verify_source)
        local = (WORKFLOW.parents[2] / "scripts/verify_local.py").read_text()
        for name in ("test_compose.py", "test_recovery.py", "test_sdk_probe.mjs", "test_deploy.py", "pytest", "check:generated"):
            self.assertIn(name, local)
        for path in (WORKFLOW, ONLINE_WORKFLOW, VERIFY_WORKFLOW):
            for job in yaml.safe_load(path.read_text())["jobs"].values():
                if "runs-on" in job:
                    self.assertGreater(job["timeout-minutes"], 0)
                    self.assertLessEqual(job["timeout-minutes"], 75)

    def test_manual_selector_rejects_wrong_ref_and_changed_head(self):
        step = next(step for step in yaml.safe_load(WORKFLOW.read_text())["jobs"]["publish-test"]["steps"] if step.get("name") == "Require the selected current Test branch")
        with tempfile.TemporaryDirectory() as directory:
            git = Path(directory) / "git"
            git.write_text('#!/bin/sh\nprintf "%s\\trefs/heads/test\\n" "$FIXTURE_HEAD"\n')
            git.chmod(0o755)
            for ref, head, accepted in (("refs/heads/test", SHA, True),
                                        ("refs/heads/main", SHA, False),
                                        ("refs/heads/test", "a" * 40, False)):
                environment = dict(PATH=directory + ":/usr/bin:/bin", SELECTED_REF=ref,
                                   GITHUB_SHA=SHA, FIXTURE_HEAD=head)
                result = subprocess.run(["bash", "-c", step["run"]], env=environment,
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)

    def test_test_and_online_workflows_have_separate_triggers_and_environments(self):
        test = yaml.safe_load(WORKFLOW.read_text())
        online = yaml.safe_load(ONLINE_WORKFLOW.read_text())
        verify = yaml.safe_load(VERIFY_WORKFLOW.read_text())
        self.assertEqual(set(test[True]), {"workflow_dispatch"})
        selection = test[True]["workflow_dispatch"]["inputs"]["deploy"]
        self.assertEqual(selection["type"], "boolean")
        self.assertTrue(selection["default"])
        self.assertIn("inputs.deploy", test["jobs"]["deploy-test"]["if"])
        self.assertEqual(set(test["jobs"]), {"publish-test", "deploy-test"})
        guard = next(step for step in test["jobs"]["publish-test"]["steps"] if step.get("name") == "Require the selected current Test branch")
        self.assertIn('"$SELECTED_REF" == refs/heads/test', guard["run"])
        self.assertEqual(online[True], {"push": {"tags": ["v*"]}})
        self.assertNotIn("workflow_call", verify[True])
        self.assertNotIn("push", verify[True])
        self.assertEqual(verify[True]["pull_request"], {"branches": ["main"]})
        self.assertIn("merge_group", verify[True])
        self.assertNotIn("build", verify["jobs"])
        self.assertIn("docker/build-push-action", VERIFY_WORKFLOW.read_text())
        self.assertFalse(VERIFY_WORKFLOW.with_name("main-verify.yaml").exists())
        self.assertNotIn("verify", online["jobs"])
        self.assertEqual(online["jobs"]["build-platforms"]["needs"], "validate-tag")
        self.assertEqual(online["jobs"]["build-online"]["needs"], "build-platforms")
        self.assertEqual(online["jobs"]["deploy-online"]["needs"], "build-online")
        self.assertIn("refs/heads/release", online["jobs"]["validate-tag"]["steps"][-1]["run"])
        build_step = next(step for step in online["jobs"]["build-platforms"]["steps"] if step.get("name", "").startswith("Build this architecture"))
        self.assertTrue(build_step["with"]["push"])
        self.assertIn("push-by-digest=true", build_step["with"]["outputs"])
        self.assertIn("@${MANIFEST_DIGEST}", online["jobs"]["deploy-online"]["steps"][1]["run"])
        self.assertEqual(online["jobs"]["deploy-online"]["environment"]["name"], "online")
        for name, job in online["jobs"].items():
            if name != "deploy-online":
                self.assertNotIn("environment", job)

    def test_platform_and_clean_checkout_contracts(self):
        test = yaml.safe_load(WORKFLOW.read_text())["jobs"]
        online = yaml.safe_load(ONLINE_WORKFLOW.read_text())["jobs"]
        platforms = online["build-platforms"]["strategy"]["matrix"]["include"]
        self.assertEqual(platforms, [{"arch": "amd64", "runner": "ubuntu-24.04"}, {"arch": "arm64", "runner": "ubuntu-24.04-arm"}])
        build = next(step for step in test["publish-test"]["steps"] if "docker/build-push-action" in step.get("uses", ""))
        self.assertEqual(build["with"]["platforms"], "linux/amd64")
        source = WORKFLOW.read_text()
        self.assertNotIn("setup-qemu", source + ONLINE_WORKFLOW.read_text())
        self.assertIn('platforms:["linux/amd64"]', source)
        self.assertIn("for arch in amd64; do", source)
        for workflow in (WORKFLOW, ONLINE_WORKFLOW, VERIFY_WORKFLOW):
            for job in yaml.safe_load(workflow.read_text())["jobs"].values():
                for step in job.get("steps", []):
                    if "uses" in step and not step["uses"].startswith("./"):
                        self.assertRegex(step["uses"], r"@[0-9a-f]{40}$")
                    if "actions/checkout" in step.get("uses", ""):
                        self.assertFalse(step["with"]["persist-credentials"])
                    if "docker/build-push-action" in step.get("uses", ""):
                        self.assertIn("mode=min", step["with"]["cache-to"])
                        self.assertIn("scope=", step["with"]["cache-to"])
        verify = yaml.safe_load(VERIFY_WORKFLOW.read_text())["jobs"]["verify"]
        self.assertNotIn("environment", verify)
        self.assertNotIn("secrets.", VERIFY_WORKFLOW.read_text())

    def test_deployment_gate_uses_repository_variable_before_environment_start(self):
        job = yaml.safe_load(WORKFLOW.read_text())["jobs"]["deploy-test"]
        guide = (WORKFLOW.parents[2] / "deploy/README.md").read_text()
        self.assertEqual(job["if"], "${{ vars.MEMOIA_TEST_DEPLOY_ENABLED == 'true' && inputs.deploy }}")
        self.assertEqual(job["environment"]["name"], "test")
        self.assertIn("`MEMOIA_TEST_DEPLOY_ENABLED` 的设置入口", guide)
        self.assertIn("必须使用仓库级 Variable", guide)
        self.assertIn("Settings → Secrets and variables → Actions → Variables", guide)

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


class NativeManifestContract(unittest.TestCase):
    def test_assembly_executes_validated_identity_and_fails_closed(self):
        workflow = yaml.safe_load(ONLINE_WORKFLOW.read_text())["jobs"]
        script = next(step["run"] for step in workflow["build-online"]["steps"] if step.get("id") == "identity")
        cases = ("new", "existing", "attested", "registry_error", "wrong_sha", "wrong_manifest", "missing_arch", "schema_missing", "schema_conflict")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                platforms = root / "platforms"
                platforms.mkdir()
                for arch, digit in (("amd64", "a"), ("arm64", "b")):
                    data = dict(arch=arch, digest="sha256:" + digit * 64, source_commit=SHA, schema="e" * 64)
                    if case == "wrong_sha" and arch == "arm64":
                        data["source_commit"] = "f" * 40
                    if case == "schema_conflict" and arch == "arm64":
                        data["schema"] = "f" * 64
                    if case == "schema_missing":
                        data.pop("schema")
                    (platforms / (arch + ".json")).write_text(json.dumps(data))
                docker = root / "docker"
                docker.write_text("#!" + sys.executable + "\n" + r'''
import json, os, pathlib, sys
root = pathlib.Path(os.environ["RUNNER_TEMP"])
case = os.environ["CASE"]
args = sys.argv[1:]
image = "ghcr.io/fixture/memoia"
version = image + ":v1.2.3"
def manifests(digits):
    return {"manifests": [{"platform": {"os": "linux", "architecture": arch}, "digest": "sha256:" + digit * 64} for arch, digit in digits]}
if args[:3] == ["buildx", "imagetools", "create"]:
    assert args[3:] == ["--tag", version, image + "@sha256:" + "a"*64, image + "@sha256:" + "b"*64]
    (root / "created").touch()
elif "--format" in args:
    print(json.dumps({"digest": "sha256:" + "c"*64}))
elif "--raw" in args:
    if args[3] == image + "@sha256:" + "c"*64:
        digits = [("amd64", "d" if case == "attested" else "a"), ("arm64", "b")]
        if case == "wrong_manifest": digits[0] = ("amd64", "f")
        if case == "missing_arch": digits.pop()
        print(json.dumps(manifests(digits)))
    elif args[3] == image + "@sha256:" + "a"*64 and case == "attested":
        print(json.dumps(manifests([("amd64", "d")])))
    else:
        sys.exit(1)
elif args == ["buildx", "imagetools", "inspect", version]:
    if case == "registry_error":
        sys.stderr.write("ERROR: registry connection timed out\n")
        sys.exit(1)
    if case not in ("existing",) and not (root / "created").exists():
        sys.stderr.write("ERROR: " + version + ": not found\n")
        sys.exit(1)
else:
    sys.exit("Unexpected Docker invocation")
''')
                docker.chmod(0o755)
                env = dict(PATH=str(root) + os.pathsep + os.environ["PATH"], RUNNER_TEMP=str(root),
                           REGISTRY="ghcr.io", IMAGE_NAME="fixture/memoia", GITHUB_REF_NAME="v1.2.3",
                           GITHUB_SHA=SHA, GITHUB_OUTPUT=str(root / "output"), GITHUB_STEP_SUMMARY=str(root / "summary"), CASE=case)
                result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, case in ("new", "existing", "attested"), result.stderr)
                if case == "existing" or case in ("registry_error", "wrong_sha", "schema_missing", "schema_conflict"):
                    self.assertFalse((root / "created").exists())
                if result.returncode == 0:
                    self.assertIn("digest=sha256:" + "c"*64, (root / "output").read_text())


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
                        REGISTRY="ghcr.io", IMAGE_NAME="jianify-llc/memoia", MANIFEST_DIGEST="sha256:" + "a" * 64)
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


class OnlineDirectSSHWorkflow(unittest.TestCase):
    def test_online_uses_release_branch_and_independent_hostname(self):
        fixture = DirectSSHWorkflow(methodName="test_direct_ssh_without_access_preserves_two_phase_release")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        workflow = yaml.safe_load(ONLINE_WORKFLOW.read_text())
        fixture.job = workflow["jobs"]["deploy-online"]
        steps = [step for step in fixture.job["steps"] if step.get("name") == "Deploy the approved digest over direct SSH"]
        self.assertEqual(len(steps), 1)
        fixture.script = steps[0]["run"]
        fixture.env["ONLINE_BEARER_TOKEN"] = fixture.env.pop("TEST_BEARER_TOKEN")
        fixture.env["FIXTURE_BRANCH"] = "release"
        fixture.env["FIXTURE_API"] = "https://memoia.jianify.dev"
        result = fixture.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [action["args"] for action in fixture.actions() if action["command"] == "ssh"]
        self.assertEqual(len(calls), 4)
        self.assertIn(" prepare '/opt/memoia'", calls[2][-1])
        self.assertIn(" finalize '/opt/memoia'", calls[3][-1])
        fixture.assert_keys_cleaned()


if __name__ == "__main__":
    unittest.main()
