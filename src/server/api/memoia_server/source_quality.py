"""Compute-only extraction regression, reusing the production structured protocol.

Run in a separate process; scoped patches intentionally forbid database/Redis I/O
and bypass accounting, not model validation. Fixed fixtures contain no real user data.
"""

import argparse
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import time
from contextlib import ExitStack, chdir
from unittest.mock import patch
from urllib.parse import urlsplit

from .source_quality_cases import CASES


def read_settings(value):
    allowed = {"api_key", "base_url", "model", "trials", "deadline_seconds", "extract_system"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError("Invalid quality settings")
    for key in ("api_key", "base_url", "model"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError("Explicit model configuration is required")
    url = urlsplit(value["base_url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Model endpoint must be a credential-free HTTPS URL")
    settings = {**value, "trials": value.get("trials", 1), "deadline_seconds": value.get("deadline_seconds", 1200)}
    for key, maximum in (("trials", 5), ("deadline_seconds", 7200)):
        if type(settings[key]) is not int or not 1 <= settings[key] <= maximum:
            raise ValueError("Quality budget is outside its fixed bounds")
    if "extract_system" in settings and (not isinstance(settings["extract_system"], str) or not settings["extract_system"].strip()):
        raise ValueError("Baseline system prompt must be nonempty")
    return settings


def grade(case, facts):
    """Small fixture-specific checks, not a general semantic judge."""
    def matches(fact, expected):
        content = fact["content"].casefold()
        groups = {frozenset(group) for group in fact["support_groups"]}
        event_time = fact.get("event_time") or {}
        return (
            all(any(word in content for word in concept) for concept in expected.concepts)
            and not any(word in content for word in expected.forbidden)
            and (not expected.subject or any(word in str(fact.get("subject", "")).casefold() for word in expected.subject))
            and (not expected.certainty or fact.get("certainty") in expected.certainty)
            and (not expected.event_dates or
                 (event_time.get("start_date"), event_time.get("end_date")) == expected.event_dates)
            and any(groups == {frozenset(group) for group in option}
                    for option in (expected.groups, *expected.alternative_groups))
        )

    found = [any(matches(fact, expected) for fact in facts) for expected in case.expected if expected.required]
    supported = [any(matches(fact, expected) for expected in case.expected) for fact in facts]
    return {"expected_concepts": all(found), "no_unexpected_facts": all(supported),
            "empty_when_expected": bool(facts) == bool(case.expected)}


async def run_quality(settings, *, cases=CASES, client=None):
    # Imports create no schema/connection; the CLI initializes only dummy service URLs.
    from openai import AsyncOpenAI
    from redis.asyncio.connection import AbstractConnection
    from . import connectors
    from .controllers import source
    from .env import CONFIG
    from .models.source import ImportSource

    own_client = client is None
    if own_client:
        client = AsyncOpenAI(api_key=settings["api_key"], base_url=settings["base_url"], max_retries=0)
    system = settings.get("extract_system", source.EXTRACT_SYSTEM)
    started = time.monotonic()
    rows = []
    report = {"compute_only": True, "model": settings["model"],
              "extract_system_sha256": hashlib.sha256(system.encode()).hexdigest(),
              "schema_sha256": hashlib.sha256(json.dumps(source.Extraction.model_json_schema(), sort_keys=True).encode()).hexdigest(),
              "trials": settings["trials"], "cases": rows, "human_review_required": True,
              "budgets": {key: getattr(CONFIG, key) for key in
                          ("source_max_input_tokens", "source_context_window_tokens", "source_output_reserve_tokens")}}

    async def no_accounting(*args, **kwargs):
        # Vendor charges still occur; only Memoia's business/accounting writes are disabled.
        return None

    try:
        with ExitStack() as stack:
            stack.enter_context(patch.object(source, "EXTRACT_SYSTEM", system))
            stack.enter_context(patch.object(CONFIG, "best_llm_model", settings["model"]))
            stack.enter_context(patch.object(source, "record_completion_usage", no_accounting))
            stack.enter_context(patch("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", return_value=client))
            stack.enter_context(patch.object(source, "Session", side_effect=RuntimeError("Compute-only SQL is forbidden")))
            stack.enter_context(patch.object(connectors.DB_ENGINE, "connect", side_effect=RuntimeError("Compute-only SQL is forbidden")))
            stack.enter_context(patch.object(AbstractConnection, "connect", side_effect=RuntimeError("Compute-only Redis is forbidden")))
            for trial in range(1, settings["trials"] + 1):
                for case in cases:
                    row = {"case": case.name, "trial": trial, "facts": []}
                    rows.append(row)
                    request = ImportSource(idempotency_key=f"quality-{case.name}", source_id=f"quality-{case.name}", messages=[
                        {"message_id": mid, "role": role, "content": content, "occurred_at": f"2026-01-01T00:00:{index:02d}Z"}
                        for index, (mid, role, content) in enumerate(case.messages)
                    ])
                    rules = {"language": "en", "strict_mode": case.strict, "profile_topics": [],
                             "validate_values": True, "event_tag_definitions": [], "event_theme_requirement": "Only supported facts"}
                    if case.strict:
                        rules["profile_topics"] = [{"topic": "work", "description": "Employment only", "sub_topics": [
                            {"name": "occupation", "description": "User's real occupation"}]}]
                    remaining = settings["deadline_seconds"] - (time.monotonic() - started)
                    if remaining <= 0:
                        row.update(passed=False, error={"code": "quality_deadline"})
                        continue
                    try:
                        extracted = await asyncio.wait_for(source.extract_source(request, rules=rules, project_id="quality-only"), remaining)
                        row["facts"] = [{key: fact[key] for key in (
                            "content", "subject", "reporter", "certainty", "support_groups", "event_time", "corrects")}
                            for fact in extracted.facts]
                        row["checks"] = grade(case, row["facts"])
                        row["passed"] = all(row["checks"].values())
                    except source.SourceError as error:
                        row.update(passed=False, error={"code": error.code, "status": error.status})
                    except Exception as error:
                        # Never print provider exceptions, credential-bearing URLs or response bodies.
                        row.update(passed=False, error={"code": "quality_call_failed", "type": type(error).__name__})
    finally:
        if own_client:
            await client.close()
    report["passed"] = bool(rows) and all(row["passed"] for row in rows)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List fixed synthetic cases without configuration or model calls")
    parser.add_argument("--case", action="append", choices=[case.name for case in CASES], help="Restrict the fixed suite")
    arguments = parser.parse_args()
    if arguments.list:
        print(json.dumps({"cases": [case.name for case in CASES]}))
        return 0
    try:
        settings = read_settings(json.load(sys.stdin))
        cases = tuple(case for case in CASES if not arguments.case or case.name in arguments.case)
        # No .env/config.yaml discovery, production URLs, credentials or telemetry listener.
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("MEMOBASE_") and key != "OPENAI_LOG"}
        environment.update({"DATABASE_URL": "postgresql://quality:unused@127.0.0.1:9/quality", "REDIS_URL": "redis://127.0.0.1:9/0",
                            "PROJECT_ID": "quality-only", "ACCESS_TOKEN": "quality-unused", "LOG_FORMAT": "plain",
                            "MEMOBASE_LLM_API_KEY": "quality-unused", "MEMOBASE_LLM_BASE_URL": "https://example.invalid/v1",
                            "MEMOBASE_ENABLE_EVENT_EMBEDDING": "false"})
        with tempfile.TemporaryDirectory(prefix="memoia-source-quality-") as directory, chdir(directory), \
                patch.dict(os.environ, environment, clear=True), patch("dotenv.load_dotenv", return_value=False), \
                patch("prometheus_client.start_http_server"):
            report = asyncio.run(run_quality(settings, cases=cases))
        print(json.dumps(report, ensure_ascii=False))
        return 0 if report["passed"] else 1
    except Exception as error:
        print(json.dumps({"compute_only": True, "passed": False, "error": {"code": "quality_setup_failed", "type": type(error).__name__}}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
