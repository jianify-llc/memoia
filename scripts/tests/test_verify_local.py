"""源码快照及缺依赖反例，不读实际业务配置或启动共享服务。"""
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import contextmanager, redirect_stderr

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

    def test_full_without_a_baseline_checks_all_scopes_without_querying_history(self):
        with patch.object(module, "run") as run:
            self.assertTrue(all(module.selections("full").values()))
            run.assert_not_called()

    def test_diff_selects_dependencies_and_missing_baseline_expands_checks(self):
        def diff(path):
            return lambda command, **_: path + "\0" if "--name-only" in command else ""
        with patch.object(module, "run") as run:
            self.assertFalse(any(module.selections("quick", "a" * 40).values()))
            self.assertFalse(any(module.selections("quick").values()))
            run.assert_not_called()
        for path in ("src/server/api/memoia_server/controllers/user.py", "sdks/typescript/pnpm-lock.yaml"):
            with patch.object(module, "run", side_effect=diff(path)):
                scope = module.selections("full", "a" * 40)
                self.assertTrue(scope["business"])
                self.assertFalse(scope["legacy"])
        with patch.object(module, "run", side_effect=diff("src/server/api/migrations/versions/new.py")):
            self.assertTrue(module.selections("full", "a" * 40)["schema"])
        with patch.object(module, "run", side_effect=diff("deploy/cutover/patch.py")):
            scope = module.selections("full", "a" * 40)
            self.assertTrue(scope["legacy"])
            self.assertFalse(scope["business"])
        with patch.object(module, "run", side_effect=diff("scripts/test_push.py")):
            scope = module.selections("full", "a" * 40)
            self.assertTrue(scope["hook"])
            self.assertFalse(scope["business"])
        for path in ("src/client/memobase/network.py", "setup.py", "requirements.txt"):
            with patch.object(module, "run", side_effect=diff(path)):
                scope = module.selections("full", "a" * 40)
                self.assertTrue(scope["business"])
                self.assertTrue(scope["deploy"])
        with patch.object(module, "run", side_effect=diff("deploy/schema-maintenance.py")):
            scope = module.selections("full", "a" * 40)
            self.assertTrue(scope["schema"])
            self.assertFalse(scope["business"])
        for path in ("deploy/recovery.py", "deploy/tests/test_recovery.py"):
            with patch.object(module, "run", side_effect=diff(path)):
                scope = module.selections("full", "a" * 40)
                self.assertTrue(scope["schema"])
                self.assertTrue(scope["deploy"])
                self.assertFalse(scope["business"])
        with patch.object(module, "run", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertTrue(all(module.selections("full", "a" * 40).values()))
        with patch.object(module, "run", return_value=" M dirty-business.py"):
            self.assertTrue(all(module.selections("full", "a" * 40).values()))

    def test_documentation_only_full_does_not_prepare_business_dependencies(self):
        def run(command, **_):
            return "deploy/README.md\0" if command[:2] == ["git", "diff"] and "--name-only" in command else ""
        with patch.object(module, "run", side_effect=run), patch.object(module.shutil, "which") as dependencies, patch.object(module, "source_tree") as tree:
            module.verify("full", "a" * 40)
        dependencies.assert_not_called()
        tree.assert_not_called()

    def test_hook_only_full_does_not_run_api_database_or_sdk_tests(self):
        @contextmanager
        def tree(*_):
            yield self.source
        def run(command, **_):
            return "scripts/test_push.py\0" if command[:2] == ["git", "diff"] else ""
        with patch.object(module, "run", side_effect=run) as commands, patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "source_tree", tree), patch.object(module, "business_tests") as integration:
            module.verify("full", "a" * 40)
        integration.assert_not_called()
        self.assertFalse(any(call.args[0][0] in ("docker", "pnpm") for call in commands.call_args_list))
        self.assertTrue(any("unittest" in call.args[0] for call in commands.call_args_list))

    def test_local_source_copy_keeps_uncommitted_source_but_not_config_or_git_credentials(self):
        credential_url = "https://fixture-private:fixture-password@example.invalid/source.git"
        subprocess.run(["git", "remote", "add", "origin", credential_url], cwd=self.source, check=True, timeout=5)
        (self.source / "uncommitted.py").write_text("fixture source")
        task_isolated = self.root / "isolated"
        task_isolated.mkdir()
        with patch.object(module, "ROOT", self.source):
            with module.source_tree(task_isolated) as source:
                self.assertNotEqual(source, self.source)
                self.assertEqual((source / "uncommitted.py").read_text(), "fixture source")
                self.assertFalse((source / ".env.local").exists())
                self.assertFalse((source / "src/server/api/config.yaml").exists())
                self.assertNotIn(credential_url, (source / ".git/config").read_text())

    def test_network_guard_fails_even_when_the_attempt_is_caught(self):
        guard = SOURCE / "offline-node.mjs"
        result = subprocess.run(["node", "--import", str(guard), "-e", "try { require('node:net').connect(1, '127.0.0.1'); } catch {}"], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)

    def test_quick_never_requires_docker_for_an_ordinary_business_diff(self):
        with patch.object(module, "selections", return_value=dict(hook=False, deploy=False, legacy=False, schema=False)), patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "snapshot"), patch.object(module, "run", side_effect=RuntimeError("STOP_AT_SNAPSHOT")) as run:
            with self.assertRaisesRegex(RuntimeError, "STOP_AT_SNAPSHOT"):
                module.verify("quick", "a" * 40)
            self.assertFalse(any(call.args[0][0] == "docker" for call in run.call_args_list))

    def test_quick_keeps_source_and_temporal_offline_regressions_for_business_diffs(self):
        api = self.source / "src/server/api"
        for name in ("LICENSE", "NOTICE", "Dockerfile", "openapi.json"):
            (api / name).write_text("")

        @contextmanager
        def tree(*_):
            yield self.source

        temporal_tests = (
            "test_calendar_precision_and_unknown_are_not_invented_dates",
            "test_withdrawn_time_anchor_does_not_survive_independent_untimed_support",
            "test_extraction_contract_keeps_undated_content_support_without_requiring_time_support",
            "test_render_retains_precision_raw_expression_and_labels_recording_time",
            "test_real_structured_validation_rejects_missing_or_invalid_time_without_echoing_content",
            "test_extraction_anchors_each_message_in_its_recorded_zone_and_rejects_fake_quote",
        )
        for changed in ("temporal.py", "source_quality.py", "controllers/source.py"):
            with self.subTest(changed=changed):
                commands = []

                def run(command, **kwargs):
                    commands.append(command)
                    if command[:2] == ["git", "diff"]:
                        return "src/server/api/memoia_server/" + changed + "\0"
                    if len(command) > 1 and command[1] == "export-openapi.py":
                        Path(command[2]).write_text("")
                    return ""

                with patch.object(module, "source_tree", tree), patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "run", side_effect=run), patch.object(module, "business_tests") as integration, patch.object(module, "local_env", return_value={}):
                    module.verify("quick", "a" * 40)
                integration.assert_not_called()
                self.assertFalse(any(command[0] == "docker" for command in commands))
                pytest = next(command for command in commands if "pytest" in command)
                self.assertIn("offline_tests", pytest)
                self.assertIn("tests/test_source_quality.py", pytest)
                self.assertIn("tests/test_maintenance_agent.py", pytest)
                self.assertIn("tests/test_maintenance_worker.py", pytest)
                for name in temporal_tests:
                    self.assertIn("tests/test_temporal_evidence.py::" + name, pytest)
                self.assertNotIn("tests/test_temporal_evidence.py", pytest)
                nodes = [item for item in pytest if item.startswith("tests/")]
                self.assertEqual(len(nodes), len(set(nodes)))

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

    def test_cleanup_failure_preserves_primary_command_and_fails_successful_run(self):
        api = self.source / "src/server/api"
        for name in ("LICENSE", "NOTICE", "Dockerfile", "openapi.json"):
            (api / name).write_text("")
        @contextmanager
        def tree(*_):
            yield self.source

        for failed in (True, False):
            with self.subTest(primary_failed=failed):
                stderr = io.StringIO()
                def run(command, **kwargs):
                    if command[:2] == ["docker", "context"]:
                        return "unix:///fixture.sock"
                    if command[:3] == ["docker", "container", "ls"]:
                        return "owned-id"
                    if command[:2] == ["docker", "rm"]:
                        raise subprocess.CalledProcessError(1, ["docker", "rm", "fixture-owned"])
                    if len(command) > 1 and command[1] == "export-openapi.py":
                        Path(command[2]).write_text("")
                    return ""

                def business(step, container, source, *_):
                    container("fixture-owned", [], source)
                    if failed:
                        raise subprocess.CalledProcessError(7, ["pytest", "fixture-primary"])

                with patch.object(module, "source_tree", tree), patch.object(module.shutil, "which", return_value="fixture"), patch.object(module, "run", side_effect=run), patch.object(module, "business_tests", side_effect=business), patch.object(module, "selections", return_value=dict(business=True, hook=False, deploy=False, legacy=False, schema=False)), patch.object(module, "local_env", return_value={}), redirect_stderr(stderr):
                    if failed:
                        with self.assertRaises(subprocess.CalledProcessError) as original:
                            module.verify("full")
                        self.assertEqual(original.exception.returncode, 7)
                        self.assertEqual(original.exception.cmd, ["pytest", "fixture-primary"])
                        self.assertIn("LOCAL_CI_CLEANUP_FAILED", stderr.getvalue())
                    else:
                        with self.assertRaisesRegex(ValueError, "LOCAL_CI_CLEANUP_FAILED"):
                            module.verify("full")

    def test_reports_are_written_outside_clean_source_not_copied_back(self):
        commands = []
        def step(command, cwd, capture=False):
            commands.append(command)
            return "127.0.0.1:12345" if command[:2] == ["docker", "port"] else ""
        with patch.object(module, "ROOT", self.source):
            module.business_tests(step, lambda *_: None, self.source, self.source, "fixture-python",
                                  {}, "fixture-report", False, module.time.monotonic() + 60)
        pytest = next(command for command in commands if "pytest" in command)
        for prefix in ("--junit-xml=", "--cov-report=xml:"):
            path = Path(next(argument[len(prefix):] for argument in pytest if argument.startswith(prefix)))
            self.assertEqual(path.parent, self.source / ".local-ci-results/fixture-report")


if __name__ == "__main__":
    unittest.main()
