"""稳定分支的实际镜像调用链及缺实现、过期源码反例。"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text())


class ImageWorkflows(unittest.TestCase):
    def test_verify_checks_real_candidate_without_business_or_publication(self):
        verify = load("verify.yml")
        triggers = verify.get("on", verify.get(True))
        self.assertEqual(set(triggers), {"pull_request", "merge_group", "workflow_dispatch"})
        job = verify["jobs"]["verify"]
        build = next(s["with"] for s in job["steps"] if "docker/build-push-action@" in s.get("uses", ""))
        self.assertEqual(build["platforms"], "linux/amd64")
        self.assertFalse(build["push"])
        self.assertTrue(build["load"])
        self.assertIn("mode=min", build["cache-to"])
        check = job["steps"][-1]["run"]
        self.assertIn("org.opencontainers.image.revision", check)
        self.assertIn("--network none", check)
        self.assertNotIn("/app/migrations", check)

    def test_manual_test_native_online_and_no_cloud_business_calls(self):
        test, online = load("deploy-test.yml"), load("deploy-online.yml")
        self.assertEqual(set(test.get("on", test.get(True))), {"workflow_dispatch"})
        self.assertEqual(set(test["jobs"]), {"publish-test", "deploy-test"})
        self.assertEqual(online["jobs"]["build-platforms"]["needs"], "validate-tag")
        matrix = online["jobs"]["build-platforms"]["strategy"]["matrix"]["include"]
        self.assertEqual({(v["arch"], v["runner"]) for v in matrix}, {("amd64", "ubuntu-24.04"), ("arm64", "ubuntu-24.04-arm")})
        self.assertEqual(online["jobs"]["deploy-online"]["environment"]["name"], "online")
        for workflow in (test, online, load("verify.yml")):
            text = yaml.safe_dump(workflow)
            for obsolete in ("workflow_call", "setup-qemu", "verify_local.py", "pytest", "uses: ./.github/workflows/verify.yml"):
                self.assertNotIn(obsolete, text)
            for job in workflow["jobs"].values():
                for step in job["steps"]:
                    if "docker/build-push-action@" in step.get("uses", ""):
                        self.assertIn("mode=min", step["with"]["cache-to"])

    def test_missing_branch_deployment_implementation_fails_before_ssh(self):
        for name, jobname in (("deploy-test.yml", "deploy-test"), ("deploy-online.yml", "deploy-online")):
            steps = load(name)["jobs"][jobname]["steps"]
            index = next(i for i,s in enumerate(steps) if s.get("name") == "Require this branch's deployment implementation")
            self.assertLess(index, next(i for i,s in enumerate(steps) if "direct SSH" in s.get("name", "")))
            with tempfile.TemporaryDirectory() as temporary:
                result = subprocess.run(["bash", "-c", steps[index]["run"]], cwd=temporary, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("lacks deployment implementation", result.stderr)

    def test_missing_implementation_fails_before_image_publication(self):
        for name, jobname in (("deploy-test.yml", "publish-test"), ("deploy-online.yml", "validate-tag")):
            steps = load(name)["jobs"][jobname]["steps"]
            guard = next(s["run"] for s in steps if s.get("name") == "Require this branch's image verification implementation")
            with tempfile.TemporaryDirectory() as temporary:
                result = subprocess.run(["bash", "-c", guard], cwd=temporary, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("lacks deployment implementation", result.stderr)
            for file in ("deploy/deploy-memoia.sh", "deploy/schema-fingerprint.sh", "deploy/recovery.py", "deploy/docker-compose.yml", "deploy/smoke-api.sh"):
                self.assertIn(file, guard)
            self.assertFalse(any("docker/login-action" in s.get("uses", "") or "docker/build-push-action" in s.get("uses", "") for s in steps[:steps.index(next(s for s in steps if s.get("run") == guard))]))

    def test_stale_test_candidate_fails_before_build(self):
        steps = load("deploy-test.yml")["jobs"]["publish-test"]["steps"]
        guard = next(s["run"] for s in steps if s.get("name") == "Require the selected current Test branch")
        with tempfile.TemporaryDirectory() as temporary:
            git = Path(temporary) / "git"
            git.write_text("#!/bin/sh\nprintf '%s\trefs/heads/test\n' '" + "b" * 40 + "'\n")
            git.chmod(0o755)
            env = dict(os.environ, PATH=temporary + ":" + os.environ["PATH"], SELECTED_REF="refs/heads/test", GITHUB_SHA="a" * 40)
            result = subprocess.run(["bash", "-c", guard], env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("newer Test commit", result.stderr)

    def test_all_embedded_shell_is_valid(self):
        for name in ("verify.yml", "deploy-test.yml", "deploy-online.yml"):
            for job in load(name)["jobs"].values():
                for step in job["steps"]:
                    if "run" in step:
                        result = subprocess.run(["bash", "-n"], input=step["run"], capture_output=True, text=True)
                        self.assertEqual(result.returncode, 0, result.stderr)
