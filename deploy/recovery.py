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
from urllib.parse import unquote, urlsplit


ROOT = Path("/opt/memoia")
POSTGRESCTL = "/opt/postgres/postgresctl.py"


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


def company_postgres():
    status = json.loads(run(["python3", POSTGRESCTL, "status"]))
    if (status.get("healthy") is not True or status.get("mount") != "/opt/postgres/data"
            or status.get("network") != "jianify-data" or not status.get("container_id")):
        raise RuntimeError("Company PostgreSQL identity or health is invalid")
    return status


def postgres_command(container, *args):
    return ["docker", "exec", "-i", container, *args]


def redis_command(command, *args):
    return command + ["exec", "-T", "redis", "sh", "-c",
                      'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli "$@"', "sh", *args]


def writers(config):
    # Old paired snapshots remain API-only; new stacks have exactly one Worker.
    return ["memoia", *(["maintenance"] if "maintenance" in config["services"] else [])]


def check_quiet(command, config, postgres_container):
    sql = "SELECT count(*) FROM buffer_zones WHERE status IN ('processing','failed')"
    count = run(postgres_command(postgres_container, "psql", "-U", "jianify_app", "-d", "memoia", "-Atc", sql))
    if count != "0":
        raise RuntimeError("Processing or failed buffers block maintenance")
    project = config["services"]["memoia"]["environment"]["PROJECT_ID"]
    for prefix in ("memobase:user_lock", "memobase:user_buffer_queue"):
        if run(redis_command(command, "--scan", "--pattern", f"{prefix}:{project}:*")):
            raise RuntimeError("Redis execution state blocks maintenance")
    base = postgres_command(postgres_container, "psql", "-U", "jianify_app", "-d", "memoia", "-Atc")
    # 0006 将批次状态从 Source 移到 Blob；维护入口迁移前后都要用，未知结构不能跳过。
    layout = set(run(base + ["""SELECT table_name || '.' || column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name IN ('memory_sources','memory_blobs','memory_operations')
        AND column_name IN ('source_id','status') ORDER BY 1"""]).splitlines())
    operation_columns = {"memory_operations.source_id", "memory_operations.status"}
    if layout == operation_columns | {"memory_sources.status"}:
        batches = "memory_sources"
    elif layout == operation_columns | {"memory_sources.source_id", "memory_blobs.source_id", "memory_blobs.status"}:
        batches = "memory_blobs"
    else:
        raise RuntimeError("Unknown memory schema blocks maintenance; verify migrations without clearing state")
    flush_schema = run(base + ["""SELECT count(*) FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='memory_operations'
        AND column_name IN ('kind','lease_owner','lease_until')"""]) == "3"
    operation_predicate = "status='processing' AND kind!='flush'" if flush_schema else "status='processing'"
    for table, predicate in (("memory_operations", operation_predicate),
                             (batches, "status IN ('processing','rebuilding')")):
        if run(base + [f"SELECT count(*) FROM {table} WHERE {predicate}"]) != "0":
            raise RuntimeError("Unfinished v2 operations block maintenance; resolve without clearing state")
    if flush_schema:
        if run(base + ["SELECT count(*) FROM memory_operations WHERE kind='flush' AND lease_owner IS NOT NULL AND lease_until > now()"] ) != "0":
            raise RuntimeError("Active derived-memory execution blocks maintenance")
    if run(base + ["SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='memory_maintenance_tasks'"]) == "1":
        if run(base + ["SELECT count(*) FROM memory_maintenance_tasks WHERE lease_owner IS NOT NULL AND lease_until > now()"] ) != "0":
            raise RuntimeError("Active derived-memory execution blocks maintenance")


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


def database_counts(postgres_container):
    sql = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    base = postgres_command(postgres_container, "psql", "-U", "jianify_app", "-d", "memoia", "-Atc")
    tables = run(base + [sql]).splitlines()
    return {table: int(run(base + ['SELECT count(*) FROM "' + table.replace('"', '""') + '"'])) for table in tables}


def validate_isolation(config, target, source_config):
    name = config["name"]
    if not name.startswith("memoia-restore-") or name == source_config["name"]:
        raise RuntimeError("Restore must use a unique isolated project")
    for service in writers(config):
        if config["services"][service].get("ports"):
            raise RuntimeError("Restored application must not publish any host port")
        if config["services"][service]["volumes"][0]["source"] != str(target / "api/config.yaml"):
            raise RuntimeError("Restored application config mount is not isolated")
    for service, destination in (("postgres", "/var/lib/postgresql/data"), ("redis", "/data")):
        volumes = config["services"][service]["volumes"]
        if len(volumes) != 1 or volumes[0]["source"] != str(target / "data" / service) or volumes[0]["target"] != destination:
            raise RuntimeError("Restore data mount is not isolated")
        if config["services"][service].get("ports"):
            raise RuntimeError("Restore database ports must not be published")
    for service in writers(config):
        environment = config["services"][service]["environment"]
        for field, host in (("DATABASE_URL", "jianify-postgres"), ("REDIS_URL", "redis")):
            if urlsplit(environment[field]).hostname != host:
                raise RuntimeError("Restore connections must target isolated Compose services")
            if environment[field] != config["services"]["memoia"]["environment"][field]:
                raise RuntimeError("Restored Worker connection differs from the restored API")
    if "jianify-postgres" not in config["services"]["postgres"].get("networks", {}).get("data", {}).get("aliases", []):
        raise RuntimeError("Isolated PostgreSQL must own the expected database alias")
    db = urlsplit(config["services"]["memoia"]["environment"]["DATABASE_URL"])
    pg = config["services"]["postgres"]["environment"]
    if (db.path != "/memoia" or unquote(db.username or "") != "jianify_app"
            or pg.get("POSTGRES_DB") != "memoia" or pg.get("POSTGRES_USER") != "jianify_app"
            or unquote(db.password or "") != pg.get("POSTGRES_PASSWORD")):
        raise RuntimeError("Isolated PostgreSQL credentials or database differ from the API")
    networks = config.get("networks", {})
    if set(networks) != {"backend", "ingress", "data"}:
        raise RuntimeError("Restore networks must use the explicit isolated topology")
    for key, network in networks.items():
        if (network.get("external") or not network.get("name", "").startswith(name + "_")
                or (key != "ingress" and network.get("internal") is not True)):
            raise RuntimeError("Restore cannot reuse an existing network")
    expected = {"postgres": {"data"}, "redis": {"backend"}, "memoia": {"backend", "ingress", "data"}}
    if "maintenance" in config["services"]:
        expected["maintenance"] = expected["memoia"]
    for service, membership in expected.items():
        if set(config["services"][service].get("networks", [])) != membership:
            raise RuntimeError("Only the restored application may use the isolated outbound network")


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
    postgres = company_postgres()
    live = inspect(run(command + ["ps", "-q", "redis"]))
    mounts = [m["Source"] for m in live["Mounts"] if m["Destination"] == "/data"]
    if mounts != [str(ROOT / "data/redis")] or live["Config"]["Image"] != config["services"]["redis"]["image"]:
        raise RuntimeError("Live Redis does not match fixed deployment")
    if run(["bash", str(Path(__file__).with_name("infra-fingerprint.sh")), str(ROOT)]) != (state / "infra-config.sha256").read_text().strip():
        raise RuntimeError("Infrastructure configuration changed")
    check_quiet(command, config, postgres["container_id"])
    containers = {}
    for service in writers(config):
        containers[service] = run(command + ["ps", "-q", service])
        live = inspect(containers[service])
        if (live["Config"]["Image"] != image or live["State"].get("Health", {}).get("Status") != "healthy"
                or live["State"].get("OOMKilled") or live.get("RestartCount", 0)):
            raise RuntimeError("Backup requires accepted healthy API and Worker")
        environment = dict(item.split("=", 1) for item in live["Config"]["Env"] if "=" in item)
        for field in ("DATABASE_URL", "REDIS_URL"):
            expected = config["services"][service]["environment"].get(field)
            if expected is not None and environment.get(field) != expected:
                raise RuntimeError("Running application connection differs from the paired backup source")
    identifier = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    directory = state / "backups" / identifier
    directory.mkdir(parents=True, mode=0o700)
    pending = state / "pending-maintenance"
    pending.write_text(f"backup {directory}\n")
    run(command + ["stop", "--timeout", "90", *writers(config)])
    for container in containers.values():
        stopped = inspect(container)["State"]
        if stopped.get("Running") or stopped.get("ExitCode") != 0:
            raise RuntimeError("API or Worker did not stop gracefully; no backup accepted")
    current_postgres = company_postgres()
    if (current_postgres["container_id"] != postgres["container_id"]
            or current_postgres["fingerprint"] != postgres["fingerprint"]):
        raise RuntimeError("Company PostgreSQL changed during the backup cutpoint")
    check_quiet(command, config, postgres["container_id"])
    # 持久探针不参与业务队列；保证恢复验证的不是过期 TTL 或旧 RDB。
    probe_key, probe_value = "memoia:restore-probe:" + identifier, uuid.uuid4().hex
    if run(redis_command(command, "SET", probe_key, probe_value)) != "OK":
        raise RuntimeError("Redis restore probe failed")
    counts = database_counts(postgres["container_id"])
    with (directory / "postgres.dump").open("xb") as output:
        run(postgres_command(postgres["container_id"], "pg_dump", "-U", "jianify_app", "-d", "memoia", "-Fc"), output=output)
    current_postgres = company_postgres()
    if (current_postgres["container_id"] != postgres["container_id"]
            or current_postgres["fingerprint"] != postgres["fingerprint"]):
        raise RuntimeError("Company PostgreSQL changed while producing the paired dump")
    # SAVE 是同步屏障；必须拿到本次保存的 OK，不能复制先前 BGSAVE 的旧快照。
    if run(redis_command(command, "SAVE")) != "OK":
        raise RuntimeError("Redis synchronous snapshot failed")
    shutil.copyfile(ROOT / "data/redis/dump.rdb", directory / "redis.rdb")
    shutil.copyfile(ROOT / ".env", directory / ".env")
    shutil.copyfile(ROOT / "api/config.yaml", directory / "config.yaml")
    shutil.copyfile(ROOT / "docker-compose.yml", directory / "docker-compose.yml")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
    manifest = {"image": image, "accepted": accepted, "schema": (state / "schema.sha256").read_text().strip(),
                "postgres_image": postgres["image"], "postgres_fingerprint": postgres["fingerprint"],
                "hashes": hashes, "database_counts": counts, "redis_probe": [probe_key, probe_value]}
    (directory / "backup.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # 切点成功后才恢复同一已验收 API/Worker；任何失败保留停写和维护标记。
    run(command + ["up", "-d", "--no-deps", "--no-build", *writers(config)])
    for service in writers(config):
        wait_healthy(command, service)
    pending.unlink()
    print(f"Paired backup complete: {directory}")


def isolated_config(source, manifest, target):
    # 备份目录 config 的相对 YAML 路径不同；所有持久资源改为隔离路径。
    config = json.loads(json.dumps(source))
    config["name"] = "memoia-" + target.name
    config["networks"].setdefault("ingress", {})
    for network, values in config["networks"].items():
        values.pop("external", None)
        values["name"] = config["name"] + "_" + network
        # Application startup/model tools may egress, but only on isolated networks.
        values["internal"] = network != "ingress"
    config["services"]["redis"]["networks"] = {"backend": {}}
    for service in writers(config):
        config["services"][service]["networks"] = {"backend": {}, "ingress": {}, "data": {}}
    config["services"]["redis"]["volumes"][0]["source"] = str(target / "data/redis")
    database = urlsplit(config["services"]["memoia"]["environment"]["DATABASE_URL"])
    if (database.hostname != "jianify-postgres" or database.path != "/memoia"
            or unquote(database.username or "") != "jianify_app" or not database.password):
        raise RuntimeError("Paired backup does not describe the company Memoia database")
    config["services"]["postgres"] = {
        "image": manifest["postgres_image"],
        "environment": {"POSTGRES_USER": "jianify_app", "POSTGRES_PASSWORD": unquote(database.password),
                        "POSTGRES_DB": "memoia"},
        "volumes": [{"type": "bind", "source": str(target / "data/postgres"),
                     "target": "/var/lib/postgresql/data"}],
        "healthcheck": {"test": ["CMD-SHELL", 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"'],
                        "interval": "10s", "timeout": "5s", "retries": 12},
        "networks": {"data": {"aliases": ["jianify-postgres"]}},
    }
    for service in writers(config):
        config["services"][service].pop("ports", None)
        config["services"][service]["volumes"][0]["source"] = str(target / "api/config.yaml")
    # 先从 RDB 加载；禁止正式 AOF 配置抢先覆盖 RDB。
    config["services"]["redis"]["command"][2] = 'exec redis-server --appendonly no --maxmemory-policy noeviction --requirepass "$${REDIS_PASSWORD}"'
    return config


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
    if "@sha256:" not in manifest["postgres_image"]:
        raise RuntimeError("Paired backup lacks a pinned PostgreSQL image")
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
    config = isolated_config(source, manifest, target)
    validate_isolation(config, target, source)
    file = target / "docker-compose.yml"
    file.write_text(json.dumps(config))
    file.chmod(0o600)
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
                                           'exec pg_restore --exit-on-error --no-owner --no-acl --no-comments -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                                stdin=input_file, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("PostgreSQL restore failed; isolated data preserved")
    key, value = manifest["redis_probe"]
    postgres_container = run(command + ["ps", "-q", "postgres"])
    if run(redis_command(command, "GET", key)) != value or database_counts(postgres_container) != manifest["database_counts"]:
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
    config["services"]["redis"]["command"][2] = 'exec redis-server --appendonly yes --maxmemory-policy noeviction --requirepass "$${REDIS_PASSWORD}"'
    file.write_text(json.dumps(config))
    run(command + ["up", "-d", "--no-deps", "--no-build", "redis"])
    wait_healthy(command, "redis")
    redis_container = run(command + ["ps", "-q", "redis"])
    if run(redis_command(command, "GET", key)) != value:
        raise RuntimeError("AOF restart verification failed")
    run(command + ["up", "-d", "--no-deps", "--no-build", *writers(config)])
    containers = {}
    for service in writers(config):
        wait_healthy(command, service)
        containers[service] = run(command + ["ps", "-q", service])
        live = inspect(containers[service])
        environment = dict(item.split("=", 1) for item in live["Config"]["Env"] if "=" in item)
        if (live["Config"].get("Image") != manifest["image"] or live["HostConfig"].get("PortBindings")
                or any(environment.get(field) != config["services"][service]["environment"][field]
                       for field in ("DATABASE_URL", "REDIS_URL"))):
            raise RuntimeError("Restored application connections or host ports differ from the isolated configuration")
    expected_networks = sorted(network["name"] for network in config["networks"].values())
    for service, container in {"postgres": postgres_container, "redis": redis_container, **containers}.items():
        actual = inspect(container)["NetworkSettings"]["Networks"]
        membership = {config["networks"][key]["name"] for key in config["services"][service]["networks"]}
        if set(actual) != membership:
            raise RuntimeError("Restored container is connected to a non-isolated network")
    receipt = {"backup_sha256": hashlib.sha256((directory / "backup.json").read_bytes()).hexdigest(),
               "image": manifest["image"], "database_counts": manifest["database_counts"],
               "target": str(target), "project": config["name"], "isolated": True,
               "redis_aof_restart_verified": True, "networks": expected_networks,
               "compose_sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
               "connections": {"postgres": {"host": "jianify-postgres", "database": "memoia", "user": "jianify_app",
                                               "container_id": postgres_container},
                               "redis": {"host": "redis", "database": "0", "container_id": redis_container},
                               "api_container_id": containers["memoia"],
                               **({"worker_container_id": containers["maintenance"]} if "maintenance" in containers else {})},
               "data_mounts": {service: str(target / "data" / service) for service in ("postgres", "redis")}}
    receipt_path = target / "restore-verified.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    receipt_path.chmod(0o600)
    print(f"Isolated paired PostgreSQL, RDB→AOF and application restart verified: {target}")


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
