"""旧稳定分支的本地业务检查；复用 Test 的源码隔离、进程和推送原语。"""
import argparse
from contextlib import contextmanager
import hashlib
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


def selections(mode, base=None):
    groups = dict(business=False, hook=False, deploy=False, legacy=False)
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
        if name.startswith(("src/server/", "src/client/memobase/", "src/client/tests/")) or name in ("setup.py", "requirements.txt", "scripts/local_tests.py"):
            groups["business"] = True
        if name.startswith(("scripts/", ".githooks/")):
            groups["hook"] = True
        if name.startswith((".github/", "deploy/")):
            groups["deploy"] = True
        if name.startswith("deploy/cutover/"):
            groups["legacy"] = True
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
    business = mode == "full" and selected["business"]
    env = local_env()
    if mode == "full" and not any(selected.values()):
        run(["git", "diff", "--check", base, "HEAD"], env=env, timeout=30)
        print("仅文档等非运行改动，差异检查通过。", flush=True)
        return
    commands = ["uv"]
    if selected["hook"] or selected["deploy"]:
        commands.append("shellcheck")
    if business or selected["deploy"]:
        commands.append("docker")
    if selected["deploy"] and (ROOT / "deploy/tests/test_deploy.py").is_file():
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
        return run(command, cwd=cwd, env=env, timeout=deadline-time.monotonic(), capture=capture)
    def container(name, arguments, cwd):
        owned.append(name)
        return step(["docker", "run", "--name", name, "--label", "jianify.local-ci=true", *arguments], cwd)
    try:
        with tempfile.TemporaryDirectory(prefix="memoia-local-ci-") as temporary, source_tree(temporary) as source:
            api = source / "src/server/api"
            env.update(UV_NO_CONFIG="true", PYTHON_DOTENV_DISABLED="1", PYTHONPATH=os.pathsep.join((str(source / "scripts"), str(source / "src/client"), str(api))),
                       MEMOBASE_LLM_API_KEY="fixture-only", MEMOBASE_EMBEDDING_API_KEY="fixture-only", ACCESS_TOKEN="secret", PROJECT_ID="memobase_dev",
                       MEMOBASE_LLM_BASE_URL="http://127.0.0.1:1/v1", MEMOBASE_EMBEDDING_BASE_URL="http://127.0.0.1:1/v1")
            step(["uv", "sync", "--frozen", "--python", "3.12", "--project", str(api)], source)
            python = str(api / ".venv/bin/python")
            step(["uv", "lock", "--check", "--python", "3.12", "--project", str(api)], source)
            if mode == "quick":
                step([python, "-m", "pytest", "-p", "offline_tests", "scripts/tests/test_sdk_offline.py", "-q"], source)
            if selected["hook"]:
                step(["shellcheck", str(source / ".githooks/pre-push")], source)
                step([python, "-m", "unittest", "discover", "-s", "scripts/tests", "-v"], source)
            suffix = uuid.uuid4().hex
            if selected["deploy"]:
                step(["shellcheck", *map(str, sorted((source / "deploy").glob("*.sh")))], source)
                for name in ("test_compose.py", "test_workflow.py", "test_recovery.py", "test_sdk_probe.py"):
                    if (source / "deploy/tests" / name).is_file():
                        step([python, "-m", "unittest", "discover", "-s", "deploy/tests", "-p", name, "-v"], source)
                if (source / "deploy/tests/test_deploy.py").is_file():
                    deployment_fixtures(step, container, source, temporary, suffix)
            if selected["legacy"] and (source / "deploy/cutover/verify_legacy_patch.py").is_file():
                step([python, "-m", "unittest", "discover", "-s", "deploy/cutover", "-p", "verify_legacy_patch.py", "-v"], source)
            if business:
                business_tests(step, container, source, api, python, env, suffix, deadline)
    finally:
        cleanup_errors = []
        for name in reversed(owned):
            try:
                if run(["docker", "container", "ls", "-aq", "--filter", f"name=^/{name}$"], env=local_env(), capture=True, timeout=15):
                    run(["docker", "rm", "-f", "-v", name], env=local_env(), timeout=15)
            except (OSError, subprocess.SubprocessError) as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            message = "LOCAL_CI_CLEANUP_FAILED: " + "; ".join(cleanup_errors)
            if sys.exc_info()[1] is not None:
                print(message, file=sys.stderr)
            else:
                raise ValueError(message)
    print(f"Memoia {mode} 本地检查通过；未部署或连接共享服务。", flush=True)


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


def business_tests(step, container, source, api, python, env, suffix, deadline):
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
    step([python, "-c", "import tiktoken; tiktoken.encoding_for_model('gpt-4o')"], api)
    reports = ROOT / ".local-ci-results" / suffix
    reports.mkdir(parents=True, exist_ok=True)
    tests = ["tests/"]
    step([python, "-m", "pytest", "-p", "local_tests", f"--junit-xml={reports / 'test-results-3.12.xml'}",
          "--cov=memoia_server", f"--cov-report=xml:{reports / 'coverage-3.12.xml'}", *tests, "-v"], api)
    env["MEMOIA_LOCAL_SDK_TESTS"] = "1"
    try:
        step([python, "-m", "pytest", "-p", "local_tests", "src/client/tests", "-v"], source)
    finally:
        env.pop("MEMOIA_LOCAL_SDK_TESTS", None)


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
