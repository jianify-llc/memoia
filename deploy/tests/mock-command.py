#!/usr/bin/env python3
"""隔离容器内模拟外部命令；不连接 Docker、数据库、Cloudflare 或 GitHub。"""
import json
import os
from pathlib import Path
import sys

command = Path(sys.argv[0]).name
args = sys.argv[1:]
fixture = Path(os.environ["MEMOIA_FIXTURE"])
old_image = "ghcr.io/jianify/memoia@sha256:" + "a" * 64
images = {"redis": "redis:7.4@sha256:" + "c" * 64,
          "memoia": os.getenv("FIXTURE_CURRENT_IMAGE", (fixture / "image").read_text())}
images["maintenance"] = os.getenv("FIXTURE_WORKER_IMAGE", images["memoia"])


def output(value):
    print(value)


if command == "systemctl":
    if args[0] == "is-active":
        sys.exit(1 if os.getenv("FIXTURE_TUNNEL_DOWN") else 0)
    if args[0] == "show":
        output("MainPID=42\nActiveEnterTimestamp=fixture-start")
    else:
        sys.exit("Unexpected systemctl mutation")
elif command == "curl":
    if args[-1].endswith("/ready"):
        sys.exit(1 if os.getenv("FIXTURE_TUNNEL_DOWN") else 0)
    elif args[-1].endswith("/metrics"):
        output("cloudflared_tunnel_ha_connections 4")
    elif "api.github.com" in args[-1]:
        expected_branch = os.getenv("FIXTURE_EXPECT_BRANCH")
        if expected_branch and not args[-1].endswith("/heads/" + expected_branch):
            sys.exit("Deployment checked the wrong release branch")
        output(json.dumps({"object": {"sha": os.getenv("FIXTURE_HEAD", "d" * 40)}}))
    else:
        sys.exit("Unexpected external HTTP call")
elif command == "docker":
    if args[0] == "compose":
        action = next(item for item in args if item in ("config", "ps", "exec", "pull", "stop", "up", "run"))
        if action == "config":
            if "--quiet" in args:
                sys.exit(0)
            services = {
                "redis": {"image": images["redis"], "environment": {"REDIS_PASSWORD": "fixture"}, "volumes": [{"source": os.getenv("FIXTURE_DATA_ROOT", "/opt/memoia/data") + "/redis"}]},
                "memoia": {"image": old_image,
                           "labels": {"io.jianify.environment": os.getenv("FIXTURE_ENV", "test")},
                           "environment": {"PROJECT_ID": "fixture", "DATABASE_URL": os.getenv("FIXTURE_DATABASE_URL", "postgresql://jianify_app:fixture@jianify-postgres/memoia"), "REDIS_URL": "redis://:fixture@redis/0"}},
            }
            services["maintenance"] = {
                **services["memoia"],
                "environment": {**services["memoia"]["environment"], "MAINTENANCE_CONCURRENCY": "2"},
                "command": ["/app/.venv/bin/python", "-m", "memoia_server.maintenance_worker"],
                "healthcheck": {"test": ["CMD", "/app/.venv/bin/python", "-m", "memoia_server.maintenance_worker", "--healthcheck"]},
            }
            if os.getenv("FIXTURE_WORKER_CONFIG_DRIFT"):
                services["maintenance"]["environment"]["DATABASE_URL"] = "postgresql://wrong/other"
            output(json.dumps({"name": "memoia-" + os.getenv("FIXTURE_ENV", "test"), "services": services,
                               "networks": {"data": {"name": "jianify-data", "external": True}}}))
        elif action == "ps":
            worker_missing = args[-1] == "maintenance" and os.getenv("FIXTURE_WORKER_MISSING") and not (fixture / "worker-started").exists()
            if not os.getenv("FIXTURE_EMPTY_STACK") and not worker_missing:
                output(args[-1])
        elif action == "exec":
            if os.getenv("FIXTURE_NO_DRAIN_PROBES"):
                sys.exit("Routine release must not probe buffer or Redis execution state")
            output("" if "--scan" in args else "0")
        elif action in ("pull", "stop", "up", "run"):
            with (fixture / "actions").open("a") as file:
                file.write(json.dumps({"args": args, "image": os.getenv("MEMOIA_IMAGE")}) + "\n")
            if action == "up":
                if "memoia" in args:
                    (fixture / "image").write_text(os.environ["MEMOIA_IMAGE"])
                if "maintenance" in args:
                    (fixture / "worker-started").touch()
            elif action == "run" and os.getenv("FIXTURE_MIGRATION_FAIL"):
                sys.exit("Migration failed")
    elif args[0] == "inspect":
        service = args[-1]
        if "--format" in args:
            if ".Config.Image" in args[args.index("--format") + 1]:
                output(images[service])
            elif ".State.ExitCode" in args[args.index("--format") + 1]:
                output("137" if os.getenv("FIXTURE_FORCE_KILL") or (service == "maintenance" and os.getenv("FIXTURE_WORKER_FORCE_KILL")) else "0")
            elif ".State.OOMKilled" in args[args.index("--format") + 1]:
                output("true 1" if (service == "memoia" and os.getenv("FIXTURE_OOM")) or (service == "maintenance" and os.getenv("FIXTURE_WORKER_OOM")) else "false 0")
            else:
                output("unhealthy" if (os.getenv("FIXTURE_UNHEALTHY") and service == "memoia") or (os.getenv("FIXTURE_WORKER_UNHEALTHY") and service == "maintenance") else "healthy")
        else:
            if service in ("memoia", "maintenance"):
                db_url = os.getenv("FIXTURE_LIVE_DATABASE_URL", os.getenv("FIXTURE_DATABASE_URL", "postgresql://jianify_app:fixture@jianify-postgres/memoia"))
                redis_url = os.getenv("FIXTURE_LIVE_REDIS_URL", "redis://:fixture@redis/0")
                project_id = os.getenv("FIXTURE_LIVE_PROJECT_ID", "fixture")
                if service == "maintenance":
                    redis_url = os.getenv("FIXTURE_WORKER_REDIS_URL", redis_url)
                    project_id = os.getenv("FIXTURE_WORKER_PROJECT_ID", project_id)
                output(json.dumps([{"Config": {"Env": ["DATABASE_URL=" + db_url,
                    "REDIS_URL=" + redis_url, "PROJECT_ID=" + project_id]}, "Mounts": []}]))
            else:
                output(json.dumps([{"Mounts": [{"Source": "/opt/memoia/data/" + service, "Destination": "/data"}]}]))
    elif args[0] == "exec":
        if os.getenv("FIXTURE_DB_UNAVAILABLE"):
            sys.exit("Company database query failed")
        if "information_schema.columns" in args[-1] and "lease_owner" in args[-1]:
            output("0")
        elif "information_schema.columns" in args[-1]:
            output(os.getenv("FIXTURE_MEMORY_LAYOUT", "memory_blobs.source_id\nmemory_blobs.status\nmemory_operations.source_id\nmemory_operations.status\nmemory_sources.source_id"))
        elif "information_schema.tables" in args[-1]:
            output("1" if os.getenv("FIXTURE_MAINTENANCE_TABLE") else "0")
        elif "memory_maintenance_tasks" in args[-1]:
            output(os.getenv("FIXTURE_MAINTENANCE_ACTIVE", "0"))
        elif "buffer_zones" in args[-1]:
            actions = (fixture / "actions").read_text() if (fixture / "actions").exists() else ""
            stopped = '"stop"' in actions
            output(os.getenv("FIXTURE_ACTIVE_BUFFER_AFTER_STOP", "0") if stopped else os.getenv("FIXTURE_ACTIVE_BUFFER", "0"))
        elif any(table in args[-1] for table in ("memory_operations", "memory_sources", "memory_blobs")):
            output(os.getenv("FIXTURE_V2_UNFINISHED", "0"))
        elif "pg_extension" in args[-1]:
            output("1")
        else:
            output(os.getenv("FIXTURE_DB_TABLES", "0"))
    elif args[0] == "ps":
        if os.getenv("FIXTURE_OLD_POSTGRES_RUNNING"):
            output("old-postgres")
    elif args[:2] == ["image", "inspect"]:
        output(os.getenv("FIXTURE_REVISION", "d" * 40))
    elif args[0] == "run":
        if args[-1] == "legacy":
            output(os.getenv("FIXTURE_LEGACY_SCHEMA", "f" * 64))
        elif "ghcr.io/jianify/memoia@sha256:" + "a" * 64 in args:
            output(os.getenv("FIXTURE_ACCEPTED_SCHEMA", "f" * 64))
        else:
            output(os.getenv("FIXTURE_SCHEMA", "f" * 64))
    else:
        sys.exit("Unexpected Docker action")
else:
    sys.exit("Unexpected command")
