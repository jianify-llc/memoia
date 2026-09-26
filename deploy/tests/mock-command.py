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
images = {"postgres": "pgvector/pgvector:pg17@sha256:" + "b" * 64,
          "redis": "redis:7.4@sha256:" + "c" * 64,
          "memoia": (fixture / "image").read_text()}


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
        output(json.dumps({"object": {"sha": os.getenv("FIXTURE_HEAD", "d" * 40)}}))
    else:
        sys.exit("Unexpected external HTTP call")
elif command == "docker":
    if args[0] == "compose":
        action = next(item for item in args if item in ("config", "ps", "exec", "pull", "stop", "up"))
        if action == "config":
            if "--quiet" in args:
                sys.exit(0)
            services = {
                "postgres": {"image": images["postgres"], "environment": {"POSTGRES_DB": "fixture", "POSTGRES_USER": "fixture", "POSTGRES_PASSWORD": "fixture"}, "volumes": [{"source": os.getenv("FIXTURE_DATA_ROOT", "/opt/memoia/data") + "/postgres"}]},
                "redis": {"image": images["redis"], "environment": {"REDIS_PASSWORD": "fixture"}, "volumes": [{"source": os.getenv("FIXTURE_DATA_ROOT", "/opt/memoia/data") + "/redis"}]},
                "memoia": {"image": old_image,
                           "labels": {"io.jianify.environment": os.getenv("FIXTURE_ENV", "test")},
                           "environment": {"PROJECT_ID": "fixture", "DATABASE_URL": os.getenv("FIXTURE_DATABASE_URL", "postgresql://fixture:fixture@postgres/fixture"), "REDIS_URL": "redis://:fixture@redis/0"}},
            }
            output(json.dumps({"name": "memoia-" + os.getenv("FIXTURE_ENV", "test"), "services": services}))
        elif action == "ps":
            if not os.getenv("FIXTURE_EMPTY_STACK"):
                output(args[-1])
        elif action == "exec":
            output("0")
        elif action in ("pull", "stop", "up"):
            with (fixture / "actions").open("a") as file:
                file.write(json.dumps({"args": args, "image": os.getenv("MEMOIA_IMAGE")}) + "\n")
            if action == "up":
                (fixture / "image").write_text(os.environ["MEMOIA_IMAGE"])
    elif args[0] == "inspect":
        service = args[-1]
        if "--format" in args:
            if ".Config.Image" in args[args.index("--format") + 1]:
                output(images[service])
            elif ".State.ExitCode" in args[args.index("--format") + 1]:
                output("137" if os.getenv("FIXTURE_FORCE_KILL") else "0")
            elif ".State.OOMKilled" in args[args.index("--format") + 1]:
                output("true 1" if os.getenv("FIXTURE_OOM") else "false 0")
            else:
                output("unhealthy" if os.getenv("FIXTURE_UNHEALTHY") and service == "memoia" else "healthy")
        else:
            destination = "/var/lib/postgresql/data" if service == "postgres" else "/data"
            output(json.dumps([{"Mounts": [{"Source": "/opt/memoia/data/" + service, "Destination": destination}]}]))
    elif args[:2] == ["image", "inspect"]:
        output(os.getenv("FIXTURE_REVISION", "d" * 40))
    elif args[0] == "run":
        output(os.getenv("FIXTURE_SCHEMA", "f" * 64))
    else:
        sys.exit("Unexpected Docker action")
else:
    sys.exit("Unexpected command")
