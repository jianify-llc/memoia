"""本地业务验证；临时源码、独占数据库，无平台部署权限。"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from test_push import ROOT, local_env, run

# 这些测试只使用纯计算、MockTransport 和内存 mock；不得靠不存在的标签筛选集成测试。
QUICK_TESTS = (
    "test_llm_logging.py", "test_embedding_validation.py", "test_source_quality.py",
    "test_maintenance_agent.py", "test_maintenance_worker.py", "test_project_model_config.py",
    *["test_redis_boundaries.py::" + name for name in (
        "test_pool_bounds_override_url_options_and_disable_replay",
        "test_removed_provider_fails_in_yaml_and_environment",
        "test_acquisition_failure_never_installs_write_authority",
        "test_acquisition_and_release_have_deadlines",
        "test_renewal_failure_invalidates_authority",
        "test_cancellation_joins_heartbeat_and_resets_authority",
        "test_statistics_failure_is_not_reported_as_zero",
        "test_statistics_failure_does_not_skip_existing_billing",
        "test_ambiguous_pipeline_write_is_not_replayed",
    )],
    *["test_temporal_evidence.py::" + name for name in (
        "test_calendar_precision_and_unknown_are_not_invented_dates",
        "test_withdrawn_time_anchor_does_not_survive_independent_untimed_support",
        "test_extraction_contract_keeps_undated_content_support_without_requiring_time_support",
        "test_render_retains_precision_raw_expression_and_labels_recording_time",
        "test_real_structured_validation_rejects_missing_or_invalid_time_without_echoing_content",
        "test_extraction_anchors_each_message_in_its_recorded_zone_and_rejects_fake_quote",
    )],
    *["test_openai_model_llm.py::" + name for name in (
        "test_luna_uses_default_reasoning_and_total_budget", "test_luna_removes_all_unsupported_sampling_parameters",
        "test_luna_default_budget_ignores_old_limits_and_preserves_reasoning", "test_explicit_completion_budget_is_preserved",
        "test_luna_service_default_is_used_only_without_explicit_effort",
        "test_completed_empty_text_is_returned_unchanged", "test_empty_json_is_rejected_by_real_parser",
        "test_luna_json_mode_preserves_legacy_parser_contract", "test_parser_failure_keeps_existing_error_code",
        "test_incomplete_or_failed_response_is_not_success", "test_startup_sanity_uses_dedicated_completion_budget",
        "test_startup_probe_does_not_accept_empty_wrong_or_truncated_output", "test_missing_usage_metadata_does_not_discard_valid_text",
        "test_accounting_uses_provider_tokens_not_text_estimates", "test_missing_usage_is_unknown_and_does_not_debit",
    )],
)


def selections(mode, base=None):
    groups = dict(business=False, hook=False, deploy=False, legacy=False, schema=False)
    if mode == "quick":
        return groups
    if not base or base == "0" * 40:
        return dict.fromkeys(groups, True)
    if len(base) != 40 or any(c not in "0123456789abcdef" for c in base):
        raise ValueError("CI_BASE_INVALID")
    try:
        if run(["git", "status", "--porcelain"], cwd=ROOT, capture=True, timeout=30):
            return dict.fromkeys(groups, True)
        run(["git", "merge-base", "--is-ancestor", base, "HEAD"], cwd=ROOT, capture=True, timeout=30)
        changed = run(["git", "diff", "--name-only", "-z", base, "HEAD"], cwd=ROOT, capture=True, timeout=30).split("\0")
    except subprocess.CalledProcessError:
        return dict.fromkeys(groups, True)
    for name in changed:
        if name.endswith((".md", ".mdx")):
            continue
        if name.startswith(("src/server/", "sdks/")):
            groups["business"] = True
        if name.startswith("src/client/memobase/") or name in ("setup.py", "requirements.txt"):
            groups["business"] = groups["deploy"] = True
        if name.startswith(("scripts/", ".githooks/")):
            groups["hook"] = True
        if name.startswith(".github/"):
            groups["deploy"] = True
        if name.startswith("deploy/"):
            groups["deploy"] = True
        if name.startswith("deploy/cutover/"):
            groups["legacy"] = True
        if name in ("deploy/schema-maintenance.py", "deploy/schema-fingerprint.sh",
                    "deploy/recovery.py", "deploy/tests/test_recovery.py"):
            groups["schema"] = True
        if name.startswith(("src/server/api/migrations/", "src/server/api/memoia_server/models/",
                            "src/server/api/memoia_server/schema.py", "src/server/api/memoia_server/connectors.py")) or name.endswith(("alembic.ini", "test_schema_adoption.py", "test_db.py")):
            groups["schema"] = True
        if name in ("src/server/api/pyproject.toml", "src/server/api/uv.lock", "src/server/api/Dockerfile"):
            groups["schema"] = groups["deploy"] = True
    return groups


@contextmanager
def source_tree(temporary):
    source = Path(temporary) / "source"
    source.mkdir()
    snapshot(ROOT, source)
    # 共享对象，但不复制真实仓库凭据。
    run(["git", "clone", "--bare", "--shared", "--quiet", str(ROOT), str(source / ".git")], cwd=ROOT, env=local_env(), timeout=30)
    yield source

PYTHON_IMAGE = "python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e"
# jq 官方 1.8.1 release 的静态 Linux 二进制；避免每批容器 apt 下载和主机代理映射。
JQ_SHA256 = {
    "amd64": "020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d",
    "arm64": "6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4",
}


def snapshot(source, destination):
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=source
    ).decode().split("\0")
    for name in dict.fromkeys(paths):
        if not name:
            continue
        path = Path(name)
        if any(part.startswith(".env") and not part.endswith(".example") for part in path.parts):
            continue
        if name == "src/server/api/config.yaml":
            continue
        origin = source / path
        if not origin.exists():
            continue
        if origin.is_symlink() or ".." in path.parts:
            raise ValueError("CI_SOURCE_SYMLINK_FORBIDDEN: " + name)
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, target)


def verify(mode="full", base=None):
    selected = selections(mode, base)
    business = mode == "quick" or selected["business"]
    integration = mode == "full" and (business or selected["schema"])
    env = local_env()
    if not business and not any(selected.values()):
        run(["git", "diff", "--check", base, "HEAD"], cwd=ROOT, env=env, timeout=30)
        print("本地 CI：仅文档等非运行改动，Git 差异检查通过；未运行业务或工具验证。", flush=True)
        return
    commands = ["uv"]
    if business or selected["deploy"]:
        commands += ["pnpm", "node"]
    if selected["hook"] or selected["deploy"]:
        commands.append("shellcheck")
    if integration or selected["deploy"]:
        commands.append("docker")
    if selected["deploy"]:
        commands.append("curl")
    for command in commands:
        if not shutil.which(command):
            raise ValueError("LOCAL_CI_DEPENDENCY_MISSING: " + command)
    if "docker" in commands:
        endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], env=env, capture=True, timeout=15)
        if not endpoint.startswith(("unix://", "npipe://")):
            raise ValueError("LOCAL_DOCKER_REQUIRED")
        run(["docker", "info", "--format", "{{.ServerVersion}}"], env=env, timeout=15)
    deadline = time.monotonic() + 1200
    owned = []

    def step(command, cwd, capture=False):
        print("本地 CI：" + " ".join(command), flush=True)
        return run(command, cwd=cwd, env=env, timeout=deadline - time.monotonic(), capture=capture)

    def container(name, arguments, cwd):
        owned.append(name)  # 超时或中断创建命令后也只清理本批名字。
        return step(["docker", "run", "--name", name, "--label", "jianify.local-ci=true", *arguments], cwd)

    try:
        with tempfile.TemporaryDirectory(prefix="memoia-local-ci-") as temporary, source_tree(temporary) as source:
            env.update(NPM_CONFIG_USERCONFIG="/dev/null", NPM_CONFIG_GLOBALCONFIG="/dev/null",
                       UV_NO_CONFIG="true", PYTHON_DOTENV_DISABLED="1")
            api = source / "src/server/api"
            step(["uv", "sync", "--frozen", "--python", "3.12", "--project", str(api)], source)
            python = str(api / ".venv/bin/python")
            step(["uv", "lock", "--check", "--python", "3.12", "--project", str(api)], source)
            if business:
                step([python, "-c", "import memoia_server; print(memoia_server.__version__)"], api)
                if any(not (api / name).is_file() for name in ("LICENSE", "NOTICE", "Dockerfile")):
                    raise ValueError("SERVER_PACKAGE_IDENTITY_MISSING")
                if "memobase_server" in (api / "Dockerfile").read_text():
                    raise ValueError("SERVER_PACKAGE_IDENTITY_MISMATCH")
            if selected["hook"]:
                step(["shellcheck", str(source / ".githooks/pre-push")], source)
                step([python, "-m", "unittest", "discover", "-s", "scripts/tests", "-v"], source)
            if selected["deploy"]:
                step(["shellcheck", *map(str, sorted((source / "deploy").glob("*.sh")))], source)
                for test in ("test_compose.py", "test_workflow.py", "test_recovery.py", "test_schema_maintenance.py"):
                    step([python, "-m", "unittest", "discover", "-s", "deploy/tests", "-p", test, "-v"], source)
            if selected["legacy"]:
                step([python, "-m", "unittest", "discover", "-s", "deploy/cutover", "-p", "verify_legacy_patch.py", "-v"], source)
            # 保留原开发 Compose 解析检查，但绝不启动其固定名称的共享容器。
            if selected["deploy"]:
                step(["docker", "compose", "--env-file", "src/server/.env.example", "-f",
                      "src/server/docker-compose.yml", "config", "--quiet"], source)
            suffix = uuid.uuid4().hex
            if selected["deploy"]:
                deployment_fixtures(step, container, source, temporary, suffix)
            env.update(MEMOBASE_LLM_API_KEY="fixture-only", MEMOBASE_EMBEDDING_API_KEY="fixture-only",
                       MEMOBASE_LLM_BASE_URL="http://127.0.0.1:1/v1", MEMOBASE_EMBEDDING_BASE_URL="http://127.0.0.1:1/v1",
                       DATABASE_URL="postgresql://fixture:fixture@127.0.0.1:1/offline", REDIS_URL="redis://127.0.0.1:1",
                       ACCESS_TOKEN="secret", PROJECT_ID="memobase_dev")
            if business:
                # tiktoken 的公开词表属于依赖准备；quick 测试进程随后禁止一切 socket 连接。
                step([python, "-c", "import tiktoken; tiktoken.encoding_for_model('gpt-4o')"], api)
                step([python, "export-openapi.py", str(Path(temporary) / "openapi-export.json")], api)
                if (Path(temporary) / "openapi-export.json").read_bytes() != (api / "openapi.json").read_bytes():
                    raise ValueError("SERVER_OPENAPI_STALE")
            env["PYTHONPATH"] = str(source / "scripts")
            if mode == "quick":
                step([python, "-m", "pytest", "-p", "offline_tests", *["tests/" + name for name in QUICK_TESTS], "-q"], api)
            if integration:
                business_tests(step, container, source, api, python, env, suffix, not business, deadline)
            sdk = source / "sdks/typescript"
            if business or selected["deploy"]:
                step(["pnpm", "install", "--frozen-lockfile"], sdk)
                step(["pnpm", "check:generated"], sdk)
            if mode == "quick":
                step(["pnpm", "build"], sdk)
                step(["node", "--import", str(source / "scripts/offline-node.mjs"), "--test", "tests/client.test.mjs"], sdk)
            elif business:
                step(["pnpm", "test"], sdk)
            if selected["deploy"]:
                if not business:
                    step(["pnpm", "build"], sdk)
                step(["node", "--test", "deploy/tests/test_sdk_probe.mjs"], source)
    finally:
        cleanup_errors = []
        for name in reversed(owned):
            try:
                if run(["docker", "container", "ls", "-aq", "--filter", f"name=^/{name}$"],
                       env=local_env(), capture=True, timeout=15):
                    run(["docker", "rm", "-f", "-v", name], env=local_env(), timeout=15)
            except (OSError, subprocess.SubprocessError) as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            message = "LOCAL_CI_CLEANUP_FAILED: " + "; ".join(cleanup_errors)
            if sys.exc_info()[1] is not None:
                print(message, file=sys.stderr)
            else:
                raise ValueError(message)
    print(f"Memoia {mode} CI 全部通过；未部署或连接共享业务服务。", flush=True)


def deployment_fixtures(step, container, source, temporary, suffix):
    arch = step(["docker", "version", "--format", "{{.Server.Arch}}"], source, True)
    if arch not in JQ_SHA256:
        raise ValueError("LOCAL_DOCKER_ARCH_UNSUPPORTED")
    jq = Path(temporary) / "jq"
    step(["curl", "-fsSL", "--max-time", "60", "-o", str(jq),
          f"https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-{arch}"], source)
    if hashlib.sha256(jq.read_bytes()).hexdigest() != JQ_SHA256[arch]:
        raise ValueError("LOCAL_JQ_IDENTITY_MISMATCH")
    jq.chmod(0o755)
    container("memoia-ci-deploy-" + suffix, ["--network", "none", "-e", "MEMOIA_DEPLOY_TEST_ISOLATED=1",
              "--mount", f"type=bind,source={source / 'deploy'},target=/work/deploy,readonly",
              "--mount", f"type=bind,source={jq},target=/usr/local/bin/jq,readonly",
              "--entrypoint", "/bin/bash", PYTHON_IMAGE, "-c",
              "python -m unittest discover -s /work/deploy/tests -p test_deploy.py -v"], source)


def business_tests(step, container, source, api, python, env, suffix, schema_only, deadline):
    pg, redis = "memoia-ci-pg-" + suffix, "memoia-ci-redis-" + suffix
    container(pg, ["-d", "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=fixture-only",
                  "-e", "POSTGRES_DB=memoia_ci", "pgvector/pgvector:pg17"], source)
    container(redis, ["-d", "-p", "127.0.0.1::6379", "redis:7.4", "redis-server",
                     "--requirepass", "fixture-only"], source)
    for name, command in ((pg, ["pg_isready", "-U", "postgres"]),
                          (redis, ["redis-cli", "-a", "fixture-only", "ping"])):
        readiness = min(deadline, time.monotonic() + 120)
        while True:
            try:
                step(["docker", "exec", name, *command], source)
                break
            except subprocess.CalledProcessError:
                if time.monotonic() >= readiness:
                    raise ValueError("LOCAL_CI_CONTAINER_NOT_READY")
                time.sleep(1)
    pg_port = step(["docker", "port", pg, "5432"], source, True).split(":")[-1]
    redis_port = step(["docker", "port", redis, "6379"], source, True).split(":")[-1]
    env.update(DATABASE_URL=f"postgresql://postgres:fixture-only@127.0.0.1:{pg_port}/memoia_ci",
               REDIS_URL=f"redis://:fixture-only@127.0.0.1:{redis_port}",
               ACCESS_TOKEN="secret", PROJECT_ID="memobase_dev")
    step([python, "-m", "alembic", "upgrade", "head"], api)
    step([python, "-c", "from memoia_server.schema import check_schema; check_schema()"], api)
    reports = ROOT / ".local-ci-results" / suffix
    reports.mkdir(parents=True, exist_ok=True)
    tests = ["tests/test_db.py", "tests/test_schema_adoption.py"] if schema_only else ["tests/"]
    step([python, "-m", "pytest", f"--junit-xml={reports / 'test-results-3.12.xml'}",
          "--cov=memoia_server", f"--cov-report=xml:{reports / 'coverage-3.12.xml'}", *tests, "-v"], api)


def cancel(*_):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--mode", choices=("quick", "full"), default="full")
        parser.add_argument("--base")
        args = parser.parse_args()
        verify(args.mode, args.base)
    except (ValueError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        print(str(error) or "LOCAL_CI_CANCELLED", file=sys.stderr)
        sys.exit(1)
