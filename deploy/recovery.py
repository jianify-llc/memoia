"""停写备份和隔离恢复；所有凭据只在受保护配置及子进程 stdin 中使用。"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit


ROOT = Path("/opt/memoia")


def run(args, *, input=None, output=None):
    result = subprocess.run(args, input=input, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # 不传播可能含连接串/配置的 stderr；保留失败阶段而不是秘密值。
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]} {args[1] if len(args) > 1 else ''}")
    return result.stdout.decode().strip() if output is None else None


def secure_file(path):
    stat = path.lstat()
    if not path.is_file() or path.is_symlink() or stat.st_uid != 0 or stat.st_gid != 0 or stat.st_mode & 0o777 != 0o600:
        raise RuntimeError("Configuration must be root:root 0600")


def compose(root, image):
    # 不 source dotenv，不依赖 sudo 继承调用者环境。
    os.environ["MEMOIA_IMAGE"] = image
    return ["docker", "compose", "--env-file", str(root / ".env"), "-f", str(root / "docker-compose.yml")]


def inspect(container):
    return json.loads(run(["docker", "inspect", container]))[0]


def redis_command(command, *args):
    return command + ["exec", "-T", "redis", "sh", "-c",
                      'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli "$@"', "sh", *args]


def check_quiet(command, config):
    sql = "SELECT count(*) FROM buffer_zones WHERE status IN ('processing','failed')"
    count = run(command + ["exec", "-T", "postgres", "sh", "-c",
                         'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', "sh", sql])
    if count != "0":
        raise RuntimeError("Processing or failed buffers block maintenance")
    project = config["services"]["memoia"]["environment"]["PROJECT_ID"]
    for prefix in ("memobase:user_lock", "memobase:user_buffer_queue"):
        if run(redis_command(command, "--scan", "--pattern", f"{prefix}:{project}:*")):
            raise RuntimeError("Redis execution state blocks maintenance")


def wait_healthy(command, service):
    container = run(command + ["ps", "-q", service])
    for _ in range(60):
        live = inspect(container)
        state = live["State"]
        if state.get("Health", {}).get("Status") == "healthy":
            if live["State"].get("OOMKilled") or live.get("RestartCount", 0):
                raise RuntimeError(f"{service} OOM or restart blocks acceptance")
            return
        if state.get("Status") == "exited" or state.get("Health", {}).get("Status") == "unhealthy":
            break
        time.sleep(3)
    raise RuntimeError(f"{service} is not healthy; isolated stack preserved")


def database_counts(command):
    sql = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    base = command + ["exec", "-T", "postgres", "sh", "-c",
                      'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', "sh"]
    tables = run(base + [sql]).splitlines()
    return {table: int(run(base + ['SELECT count(*) FROM "' + table.replace('"', '""') + '"'])) for table in tables}


def validate_isolation(config, target, source_config):
    name = config["name"]
    if not name.startswith("memoia-restore-") or name == source_config["name"]:
        raise RuntimeError("Restore must use a unique isolated project")
    if config["services"]["memoia"].get("ports"):
        raise RuntimeError("Restore API must not publish any host port")
    for service, destination in (("postgres", "/var/lib/postgresql/data"), ("redis", "/data")):
        volumes = config["services"][service]["volumes"]
        if len(volumes) != 1 or volumes[0]["source"] != str(target / "data" / service) or volumes[0]["target"] != destination:
            raise RuntimeError("Restore data mount is not isolated")
        if config["services"][service].get("ports"):
            raise RuntimeError("Restore database ports must not be published")
    for field, host in (("DATABASE_URL", "postgres"), ("REDIS_URL", "redis")):
        if urlsplit(config["services"]["memoia"]["environment"][field]).hostname != host:
            raise RuntimeError("Restore connections must target isolated Compose services")
    for network in config.get("networks", {}).values():
        if network.get("external") or not network.get("name", "").startswith(name + "_"):
            raise RuntimeError("Restore cannot reuse an existing network")


def backup():
    state = ROOT / ".deploy"
    if any((state / name).exists() for name in ("pending-deploy", "pending-maintenance")):
        raise RuntimeError("Unresolved deployment or maintenance blocks backup")
    accepted = (state / "deploy-state").read_text().split()
    image = accepted[2]
    command = compose(ROOT, image)
    config = json.loads(run(command + ["config", "--format", "json"]))
    if config["name"] != "memoia-test":
        raise RuntimeError("Online maintenance is disabled")
    for file in (ROOT / ".env", ROOT / "api/config.yaml"):
        secure_file(file)
    for service, destination in (("postgres", "/var/lib/postgresql/data"), ("redis", "/data")):
        live = inspect(run(command + ["ps", "-q", service]))
        mounts = [m["Source"] for m in live["Mounts"] if m["Destination"] == destination]
        if mounts != [str(ROOT / "data" / service)] or live["Config"]["Image"] != config["services"][service]["image"]:
            raise RuntimeError("Live infrastructure does not match fixed deployment")
    if run(["bash", str(Path(__file__).with_name("infra-fingerprint.sh")), str(ROOT)]) != (state / "infra-config.sha256").read_text().strip():
        raise RuntimeError("Infrastructure configuration changed")
    check_quiet(command, config)
    api = run(command + ["ps", "-q", "memoia"])
    live = inspect(api)
    if live["Config"]["Image"] != image or live["State"].get("Health", {}).get("Status") != "healthy":
        raise RuntimeError("Backup requires the accepted healthy API")
    identifier = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    directory = state / "backups" / identifier
    directory.mkdir(parents=True, mode=0o700)
    pending = state / "pending-maintenance"
    pending.write_text(f"backup {directory}\n")
    run(command + ["stop", "--timeout", "90", "memoia"])
    stopped = inspect(api)["State"]
    if stopped.get("Running") or stopped.get("ExitCode") != 0:
        raise RuntimeError("API did not stop gracefully; no backup accepted")
    check_quiet(command, config)
    # 持久探针不参与业务队列；保证恢复验证的不是过期 TTL 或旧 RDB。
    probe_key, probe_value = "memoia:restore-probe:" + identifier, uuid.uuid4().hex
    if run(redis_command(command, "SET", probe_key, probe_value)) != "OK":
        raise RuntimeError("Redis restore probe failed")
    counts = database_counts(command)
    with (directory / "postgres.dump").open("xb") as output:
        run(command + ["exec", "-T", "postgres", "sh", "-c",
                       'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], output=output)
    # SAVE 是同步屏障；必须拿到本次保存的 OK，不能复制先前 BGSAVE 的旧快照。
    if run(redis_command(command, "SAVE")) != "OK":
        raise RuntimeError("Redis synchronous snapshot failed")
    shutil.copyfile(ROOT / "data/redis/dump.rdb", directory / "redis.rdb")
    shutil.copyfile(ROOT / ".env", directory / ".env")
    shutil.copyfile(ROOT / "api/config.yaml", directory / "config.yaml")
    shutil.copyfile(ROOT / "docker-compose.yml", directory / "docker-compose.yml")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
    manifest = {"image": image, "accepted": accepted, "schema": (state / "schema.sha256").read_text().strip(),
                "hashes": hashes, "database_counts": counts, "redis_probe": [probe_key, probe_value]}
    (directory / "backup.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # 切点成功后才恢复同一个已验收 API；任何失败保留停写和维护标记。
    run(command + ["up", "-d", "--no-deps", "--no-build", "memoia"])
    wait_healthy(command, "memoia")
    pending.unlink()
    print(f"Paired backup complete: {directory}")


def restore(directory, target):
    directory = Path(directory)
    target = Path(target)
    parent = ROOT / "rehearsals"
    if directory.is_symlink() or directory.resolve().parent != (ROOT / ".deploy/backups").resolve():
        raise RuntimeError("Use a verified local paired backup")
    if target.parent != parent or not target.name.startswith("restore-") or not all(c.isalnum() or c == "-" for c in target.name):
        raise RuntimeError("Restore target must be a new /opt/memoia/rehearsals/restore-* directory")
    if target.exists() or parent.is_symlink():
        raise RuntimeError("Refusing any existing target, including an empty directory")
    manifest = json.loads((directory / "backup.json").read_text())
    for name, expected in manifest["hashes"].items():
        if Path(name).name != name or hashlib.sha256((directory / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError("Backup integrity check failed")
    parent.mkdir(mode=0o700, exist_ok=True)
    target.mkdir(mode=0o700)
    (target / "api").mkdir(mode=0o700)
    for service in ("postgres", "redis"):
        (target / "data" / service).mkdir(parents=True, mode=0o700)
    shutil.copyfile(directory / ".env", target / ".env")
    shutil.copyfile(directory / "config.yaml", target / "api/config.yaml")
    source = json.loads(run(compose(directory, manifest["image"]) + ["config", "--format", "json"]))
    # 备份目录 config 的相对 YAML 路径不同，实际恢复显式改为独立只读文件。
    config = json.loads(json.dumps(source))
    config["name"] = "memoia-" + target.name
    for network, values in config["networks"].items():
        values["name"] = config["name"] + "_" + network
    for service in ("postgres", "redis"):
        config["services"][service]["volumes"][0]["source"] = str(target / "data" / service)
    config["services"]["memoia"].pop("ports", None)
    config["services"]["memoia"]["volumes"][0]["source"] = str(target / "api/config.yaml")
    # 先从 RDB 加载；禁止正式 AOF 配置抢先覆盖 RDB。
    config["services"]["redis"]["command"][2] = 'exec redis-server --appendonly no --requirepass "$${REDIS_PASSWORD}"'
    validate_isolation(config, target, source)
    file = target / "docker-compose.yml"
    file.write_text(json.dumps(config))
    command = compose(target, manifest["image"]) + ["--project-name", config["name"]]
    effective = json.loads(run(command + ["config", "--format", "json"]))
    validate_isolation(effective, target, source)
    if run(command + ["ps", "-aq"]):
        raise RuntimeError("Restore project already has containers")
    shutil.copyfile(directory / "redis.rdb", target / "data/redis/dump.rdb")
    # 数据目录所有权交由各自 entrypoint；不修改正式环境的目录/网络/端口。
    run(command + ["up", "-d", "--no-build", "postgres", "redis"])
    for service in ("postgres", "redis"):
        wait_healthy(command, service)
        actual = inspect(run(command + ["ps", "-q", service]))
        expected = str(target / "data" / service)
        if actual["HostConfig"].get("PortBindings") or not any(m["Source"] == expected for m in actual["Mounts"]):
            raise RuntimeError("Actual restored mounts or ports violate isolation")
    with (directory / "postgres.dump").open("rb") as input_file:
        result = subprocess.run(command + ["exec", "-T", "postgres", "sh", "-c",
                                           'exec pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                                stdin=input_file, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("PostgreSQL restore failed; isolated data preserved")
    key, value = manifest["redis_probe"]
    if run(redis_command(command, "GET", key)) != value or database_counts(command) != manifest["database_counts"]:
        raise RuntimeError("Restored PostgreSQL/RDB verification failed")
    if run(redis_command(command, "CONFIG", "SET", "appendonly", "yes")) != "OK":
        raise RuntimeError("AOF initialization failed")
    for _ in range(60):
        info = run(redis_command(command, "INFO", "persistence"))
        status = dict(line.split(":", 1) for line in info.splitlines() if ":" in line)
        if status.get("aof_rewrite_in_progress") == "0" and status.get("aof_rewrite_scheduled") == "0" and status.get("aof_last_bgrewrite_status") == "ok":
            break
        time.sleep(2)
    else:
        raise RuntimeError("AOF rewrite did not finish")
    redis_container = run(command + ["ps", "-q", "redis"])
    run(command + ["stop", "--timeout", "30", "redis"])
    if inspect(redis_container)["State"].get("ExitCode") != 0:
        raise RuntimeError("Redis did not stop gracefully after AOF rewrite")
    config["services"]["redis"]["command"][2] = 'exec redis-server --appendonly yes --requirepass "$${REDIS_PASSWORD}"'
    file.write_text(json.dumps(config))
    run(command + ["up", "-d", "--no-deps", "--no-build", "redis"])
    wait_healthy(command, "redis")
    if run(redis_command(command, "GET", key)) != value:
        raise RuntimeError("AOF restart verification failed")
    run(command + ["up", "-d", "--no-deps", "--no-build", "memoia"])
    wait_healthy(command, "memoia")
    print(f"Isolated PostgreSQL, RDB→AOF and API restart verified: {target}")


def main():
    if os.geteuid() != 0 or sys.argv[2] != str(ROOT):
        raise RuntimeError("Run through sudo deploy-memoia.sh with /opt/memoia")
    os.umask(0o077)
    state = ROOT / ".deploy"
    with (state / ".deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if sys.argv[1] == "backup":
            backup()
        elif sys.argv[1] == "restore-data" and len(sys.argv) == 5:
            restore(sys.argv[3], sys.argv[4])
        else:
            raise RuntimeError("Invalid maintenance mode")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"Maintenance blocked: {error}", file=sys.stderr)
        sys.exit(1)
