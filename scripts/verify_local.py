"""本地与远端 Verify 共用入口；临时源码、独占数据库，无平台部署权限。"""
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


def verify():
    env = local_env()
    for command in ("uv", "pnpm", "node", "shellcheck", "docker", "curl"):
        if not shutil.which(command):
            raise ValueError("LOCAL_CI_DEPENDENCY_MISSING: " + command)
    endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                   env=env, capture=True, timeout=15)
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
        with tempfile.TemporaryDirectory(prefix="memoia-local-ci-") as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            snapshot(ROOT, source)
            # 历史补丁测试读取既有 commit；只共享对象，不复制原 .git/config 的凭据。
            step(["git", "clone", "--bare", "--shared", "--quiet", str(ROOT), str(source / ".git")], ROOT)
            env.update(NPM_CONFIG_USERCONFIG="/dev/null", NPM_CONFIG_GLOBALCONFIG="/dev/null",
                       UV_NO_CONFIG="true", PYTHON_DOTENV_DISABLED="1")
            api = source / "src/server/api"
            (api / "config.yaml").write_text(json.dumps({
                "llm_api_key": "fixture-only", "embedding_api_key": "fixture-only",
                "llm_base_url": "http://127.0.0.1:1/v1", "embedding_base_url": "http://127.0.0.1:1/v1",
            }))
            step(["uv", "sync", "--frozen", "--python", "3.12", "--project", str(api)], source)
            python = str(api / ".venv/bin/python")
            step(["uv", "lock", "--check", "--python", "3.12", "--project", str(api)], source)
            step([python, "-c", "import memoia_server; print(memoia_server.__version__)"], api)
            if any(not (api / name).is_file() for name in ("LICENSE", "NOTICE", "Dockerfile")):
                raise ValueError("SERVER_PACKAGE_IDENTITY_MISSING")
            if "memobase_server" in (api / "Dockerfile").read_text():
                raise ValueError("SERVER_PACKAGE_IDENTITY_MISMATCH")
            step(["shellcheck", *map(str, sorted((source / "deploy").glob("*.sh"))),
                  str(source / ".githooks/pre-push")], source)
            step([python, "-m", "unittest", "discover", "-s", "scripts/tests", "-v"], source)
            for test in ("test_compose.py", "test_workflow.py", "test_recovery.py", "test_sdk_probe.py"):
                step([python, "-m", "unittest", "discover", "-s", "deploy/tests", "-p", test, "-v"], source)
            step([python, "-m", "unittest", "discover", "-s", "deploy/cutover", "-p", "verify_legacy_patch.py", "-v"], source)
            # 保留原开发 Compose 解析检查，但绝不启动其固定名称的共享容器。
            shutil.copy2(source / "src/server/.env.example", source / "src/server/.env")
            step(["docker", "compose", "--env-file", "src/server/.env", "-f",
                  "src/server/docker-compose.yml", "config", "--quiet"], source)
            suffix = uuid.uuid4().hex
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
            step([python, "export-openapi.py", str(source / "openapi-export.json")], api)
            if (source / "openapi-export.json").read_bytes() != (api / "openapi-v2.json").read_bytes():
                raise ValueError("SERVER_OPENAPI_STALE")
            try:
                step([python, "-m", "pytest", "--junit-xml=junit/test-results-3.12.xml",
                      "--cov=memoia_server", "--cov-report=xml:coverage-3.12.xml", "tests/", "-v"], api)
            finally:
                reports = ROOT / ".local-ci-results" / suffix
                for name in ("junit/test-results-3.12.xml", "coverage-3.12.xml"):
                    if (api / name).is_file():
                        target = reports / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(api / name, target)
            sdk = source / "sdks/typescript"
            step(["pnpm", "install", "--frozen-lockfile"], sdk)
            step(["pnpm", "check:generated"], sdk)
            step(["pnpm", "test"], sdk)
            step(["node", "--test", "deploy/tests/test_v2_sdk_probe.mjs"], source)
            print("Memoia 本地 CI 全部通过；未部署或连接共享业务服务。", flush=True)
    finally:
        cleanup_errors = []
        for name in reversed(owned):
            try:
                run(["docker", "rm", "-f", "-v", name], env=local_env(), timeout=15)
            except (OSError, subprocess.SubprocessError) as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            raise ValueError("LOCAL_CI_CLEANUP_FAILED: " + "; ".join(cleanup_errors))


def cancel(*_):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    try:
        if len(sys.argv) != 1:
            raise ValueError("Usage: python3 scripts/verify_local.py")
        verify()
    except (ValueError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        print(str(error) or "LOCAL_CI_CANCELLED", file=sys.stderr)
        sys.exit(1)
