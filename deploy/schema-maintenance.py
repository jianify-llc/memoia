"""Verify explicit schema-maintenance evidence; never edit business rows or fingerprints."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from recovery import secure_file, check_quiet, compose, company_postgres, run


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    secure_file(path)
    return json.loads(path.read_text())


def identity(document, image, sha, run_id):
    if any(document.get(key) != value for key, value in {"image": image, "source_sha": sha, "run_id": run_id}.items()):
        raise RuntimeError("Schema evidence does not identify this exact candidate")


def preflight(root, image, sha, run_id, evidence_path):
    document = load(evidence_path)
    identity(document, image, sha, run_id)
    policy = document.get("data_policy", "backup-required")
    if policy not in ("backup-required", "disposable-test"):
        raise RuntimeError("Unknown schema maintenance data policy")
    state = root / ".deploy"
    if policy == "disposable-test":
        # 开发 Test 的显式不可恢复授权，不伪造备份；停机后的审计仍必须通过。
        config = json.loads(run(compose(root, image) + ["config", "--format", "json"]))
        if (config["name"] != "memoia-test"
                or config["services"]["memoia"]["labels"].get("io.jianify.environment") != "test"):
            raise RuntimeError("Disposable data policy is Test-only")
        if document.get("unknown_results_resolved") is not True:
            raise RuntimeError("Unknown outcomes must be resolved before migration")
        return {"image": image, "source_sha": sha, "run_id": run_id, "mode": "migrate-schema",
                "data_policy": policy, "evidence_sha256": digest(evidence_path),
                "backup_sha256": None, "old_schema": (state / "schema.sha256").read_text().strip()}
    if document.get("writers_paused") is not True or document.get("unknown_results_resolved") is not True:
        raise RuntimeError("Operator must confirm paused writers and resolved unknown outcomes")
    backup = Path(document["backup_directory"])
    restore = Path(document["restore_directory"])
    if backup.is_symlink() or backup.resolve().parent != (state / "backups").resolve():
        raise RuntimeError("Schema maintenance needs a local paired backup")
    if restore.is_symlink() or restore.resolve().parent != (root / "rehearsals").resolve():
        raise RuntimeError("Restore evidence must come from the isolated rehearsal directory")
    manifest = load(backup / "backup.json")
    if manifest["accepted"] != (state / "deploy-state").read_text().split() or manifest["schema"] != (state / "schema.sha256").read_text().strip():
        raise RuntimeError("Backup does not match the currently accepted API/schema")
    expected_files = {".env", "config.yaml", "docker-compose.yml", "postgres.dump", "redis.rdb"}
    if not expected_files.issubset(manifest["hashes"]):
        raise RuntimeError("Incomplete paired backup")
    for name, expected in manifest["hashes"].items():
        path = backup / name
        if Path(name).name != name or path.is_symlink() or digest(path) != expected:
            raise RuntimeError("Paired backup integrity mismatch")
    for name, actual in {".env": root / ".env", "config.yaml": root / "api/config.yaml", "docker-compose.yml": root / "docker-compose.yml"}.items():
        if manifest["hashes"][name] != digest(actual):
            raise RuntimeError("Configuration changed since the paired backup")
    receipt = load(restore / "restore-verified.json")
    restored_config = load(restore / "docker-compose.yml")
    project = receipt.get("project", "")
    connections = receipt.get("connections", {})
    if (receipt.get("backup_sha256") != digest(backup / "backup.json")
            or receipt.get("image") != manifest["image"] or receipt.get("database_counts") != manifest["database_counts"]
            or receipt.get("target") != str(restore) or not project.startswith("memoia-restore-")
            or receipt.get("isolated") is not True or receipt.get("redis_aof_restart_verified") is not True
            or receipt.get("compose_sha256") != digest(restore / "docker-compose.yml")
            or restored_config.get("name") != project or not receipt.get("networks")
            or any(not network.startswith(project + "_") for network in receipt["networks"])
            or receipt.get("data_mounts") != {service: str(restore / "data" / service) for service in ("postgres", "redis")}
            or any(connections.get("postgres", {}).get(key) != value for key, value in
                   {"host": "jianify-postgres", "database": "memoia", "user": "jianify_app"}.items())
            or any(connections.get("redis", {}).get(key) != value for key, value in {"host": "redis", "database": "0"}.items())
            or not all(connections.get(service, {}).get("container_id") for service in ("postgres", "redis"))
            or not connections.get("api_container_id")):
        raise RuntimeError("Isolated restore was not verified for this paired backup")
    return {"image": image, "source_sha": sha, "run_id": run_id, "mode": "migrate-schema",
            "data_policy": policy,
            "evidence_sha256": digest(evidence_path), "backup_sha256": digest(backup / "backup.json"),
            "old_schema": manifest["schema"]}


def audit(root, image):
    command = compose(root, image)
    config = json.loads(run(command + ["config", "--format", "json"]))
    pg = company_postgres()["container_id"]
    check_quiet(command, config, pg)


def finalize(root, image, sha, run_id, evidence_path):
    pending = load(root / ".deploy/pending-maintenance")
    identity(pending, image, sha, run_id)
    if pending.get("mode") != "migrate-schema":
        raise RuntimeError("Another maintenance mode is pending")
    evidence = load(evidence_path)
    identity(evidence, image, sha, run_id)
    required = {"authentication", "source_replay", "retract", "profile_history", "model", "embedding"}
    if any(evidence.get("checks", {}).get(name) is not True for name in required):
        raise RuntimeError("Schema business acceptance is incomplete")
    files = evidence.get("evidence_files", [])
    if not files:
        raise RuntimeError("Business acceptance must reference protected evidence files")
    for item in files:
        path = Path(item["path"])
        if not path.resolve().is_relative_to((root / ".deploy").resolve()):
            raise RuntimeError("Acceptance evidence must stay in the protected deployment directory")
        secure_file(path)
        if not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) or digest(path) != item["sha256"]:
            raise RuntimeError("Business evidence integrity mismatch")


if __name__ == "__main__":
    try:
        mode, root, image = sys.argv[1:4]
        root = Path(root)
        if os.geteuid() != 0 or root != Path("/opt/memoia"):
            raise RuntimeError("Use the versioned deployment entry point with sudo")
        if mode == "audit":
            audit(root, image)
        elif mode == "preflight":
            print(json.dumps(preflight(root, image, sys.argv[4], sys.argv[5], Path(sys.argv[6]))))
        elif mode == "finalize":
            finalize(root, image, sys.argv[4], sys.argv[5], Path(sys.argv[6]))
        else:
            raise RuntimeError("Unknown schema maintenance stage")
    except (RuntimeError, OSError, ValueError, KeyError, IndexError) as error:
        print(f"Schema maintenance blocked: {error}", file=sys.stderr)
        sys.exit(1)
