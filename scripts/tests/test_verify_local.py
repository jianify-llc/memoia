"""源码快照及缺依赖反例，不读实际业务配置或启动共享服务。"""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
SPEC = importlib.util.spec_from_file_location("verify_local", SOURCE / "verify_local.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class LocalVerificationContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ci-source-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.target = self.root / "copy"
        self.target.mkdir()
        subprocess.run(["git", "init", "-q", str(self.source)], check=True, timeout=5)
        for name in (".env.local", ".env.example", "src/server/api/config.yaml", "src/server/api/config.yaml.example", "source.py"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture only")
        subprocess.run(["git", "add", "-f", "."], cwd=self.source, check=True, timeout=5)

    def copy(self):
        module.snapshot(self.source, self.target)

    def test_business_config_is_excluded_but_templates_and_source_are_kept(self):
        self.copy()
        self.assertFalse((self.target / ".env.local").exists())
        self.assertFalse((self.target / "src/server/api/config.yaml").exists())
        for name in (".env.example", "src/server/api/config.yaml.example", "source.py"):
            self.assertTrue((self.target / name).is_file())

    def test_external_symlink_cannot_smuggle_host_files(self):
        (self.source / "outside.py").symlink_to(self.root / "private")
        (self.root / "private").write_text("fixture private")
        subprocess.run(["git", "add", "outside.py"], cwd=self.source, check=True, timeout=5)
        with self.assertRaisesRegex(ValueError, "CI_SOURCE_SYMLINK_FORBIDDEN"):
            self.copy()

    def test_missing_dependency_fails_before_any_container_or_source_operation(self):
        with patch.object(module.shutil, "which", return_value=None), patch.object(module, "run") as run:
            with self.assertRaisesRegex(ValueError, "LOCAL_CI_DEPENDENCY_MISSING"):
                module.verify()
            run.assert_not_called()

    def test_publish_has_fixed_business_scope_without_querying_a_baseline(self):
        with patch.object(module, "run") as run:
            self.assertFalse(any(module.selections("publish").values()))
            run.assert_not_called()

    def test_diff_selects_dependencies_and_missing_baseline_expands_checks(self):
        with patch.object(module, "run", return_value="src/server/api/memoia_server/controllers/user.py\0"):
            self.assertFalse(any(module.selections("quick", "a" * 40).values()))
        with patch.object(module, "run", return_value="src/server/api/migrations/versions/new.py\0"):
            self.assertTrue(module.selections("quick", "a" * 40)["schema"])
        with patch.object(module, "run", return_value="deploy/cutover/patch.py\0"):
            self.assertTrue(module.selections("pr", "a" * 40)["legacy"])
        with patch.object(module, "run", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertTrue(all(module.selections("quick", "a" * 40).values()))
        self.assertTrue(all(module.selections("quick").values()))

    def test_clean_checkout_is_used_directly_without_copy_or_credentials(self):
        with patch.object(module, "ROOT", self.source), patch.object(module, "run", return_value=""), patch.object(module, "snapshot") as snapshot:
            with module.source_tree(True, self.root) as source:
                self.assertEqual(source, self.source)
            snapshot.assert_not_called()
        with patch.object(module, "run", return_value=" M business.py"):
            with self.assertRaisesRegex(ValueError, "CI_CHECKOUT_MUST_BE_CLEAN"):
                with module.source_tree(True, self.root):
                    self.fail("dirty cloud checkout accepted")

    def test_network_guard_fails_even_when_the_attempt_is_caught(self):
        guard = SOURCE / "offline-node.mjs"
        result = subprocess.run(["node", "--import", str(guard), "-e", "try { require('node:net').connect(1, '127.0.0.1'); } catch {}"], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)

    def test_quick_never_requires_docker_for_an_ordinary_business_diff(self):
        with patch.object(module, "selections", return_value=dict(hook=False, deploy=False, legacy=False, schema=False)), patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "snapshot"), patch.object(module, "run", side_effect=RuntimeError("STOP_AT_SNAPSHOT")) as run:
            with self.assertRaisesRegex(RuntimeError, "STOP_AT_SNAPSHOT"):
                module.verify("quick", "a" * 40)
            self.assertFalse(any(call.args[0][0] == "docker" for call in run.call_args_list))

    def test_tool_checks_do_not_inherit_business_fixture_connection_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            api = source / "src/server/api"
            api.mkdir(parents=True)
            for name in ("LICENSE", "NOTICE", "Dockerfile"):
                (api / name).write_text("fixture")
            calls = []

            def run(command, **kwargs):
                if "test_compose.py" in command:
                    calls.append(dict(kwargs["env"]))
                if command[:2] == ["docker", "context"]:
                    return "unix:///fixture.sock"
                if "import tiktoken; tiktoken.encoding_for_model('gpt-4o')" in command:
                    self.assertIn("fixture", kwargs["env"]["DATABASE_URL"])
                    raise RuntimeError("STOP_AFTER_TOOLS")
                return ""

            from contextlib import contextmanager
            @contextmanager
            def tree(*_):
                yield source

            with patch.object(module, "source_tree", tree), patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "run", side_effect=run), patch.object(module, "deployment_fixtures"), patch.object(module, "local_env", return_value={}):
                with self.assertRaisesRegex(RuntimeError, "STOP_AFTER_TOOLS"):
                    module.verify("full")
            self.assertEqual(len(calls), 1)
            self.assertNotIn("DATABASE_URL", calls[0])
            self.assertNotIn("REDIS_URL", calls[0])

    def test_python_network_guard_marks_caught_attempts_as_failure_and_restores_methods(self):
        spec = importlib.util.spec_from_file_location("offline_tests", SOURCE / "offline_tests.py")
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        from types import SimpleNamespace
        import socket
        session = SimpleNamespace(exitstatus=0)
        original = socket.create_connection
        try:
            guard.pytest_sessionstart(session)
            with self.assertRaisesRegex(RuntimeError, "QUICK_NETWORK_FORBIDDEN"):
                socket.create_connection(("127.0.0.1", 1))
        finally:
            guard.pytest_sessionfinish(session, 0)
        self.assertEqual(session.exitstatus, 1)
        self.assertIs(socket.create_connection, original)


if __name__ == "__main__":
    unittest.main()
