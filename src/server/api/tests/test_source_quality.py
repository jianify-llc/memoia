"""Synthetic fixtures + real OpenAI SDK transport; never a real model-quality claim."""

import json
import subprocess
import sys
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from openai import AsyncOpenAI

from memoia_server.controllers import source
from memoia_server.env import CONFIG
from memoia_server.models.source import ImportSource
from memoia_server.source_quality import grade, read_settings, run_quality
from memoia_server.source_quality_cases import CASES


SETTINGS = {"api_key": "quality-fake-key", "model": "gpt-6-luna", "base_url": "https://example.invalid/v1"}


def request_body(messages):
    return ImportSource(idempotency_key="quality-unit", source_id="quality-unit", messages=[
        {"message_id": mid, "role": role, "content": content, "occurred_at": f"2026-01-01T00:00:{index:02d}Z"}
        for index, (mid, role, content) in enumerate(messages)
    ])


def model_transport(contents):
    bodies = []

    def respond(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "quality-completion", "object": "chat.completion", "created": 0,
            "model": "gpt-6-luna", "choices": [{"index": 0, "finish_reason": "stop", "message": {
                "role": "assistant", "content": contents[len(bodies) - 1], "refusal": None}}]})

    client = AsyncOpenAI(api_key=SETTINGS["api_key"], base_url=SETTINGS["base_url"], max_retries=0,
                         http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    return client, bodies


def fact(content, groups):
    return {"content": content, "subject": "the user", "reporter": "the user", "certainty": "asserted", "corrects": [], "support_groups": groups,
            "event_time": None}


def test_prompt_clarifies_self_evidence_without_forcing_nonempty_or_slot_filtering():
    assert "user AND relevant people" in source.EXTRACT_SYSTEM
    assert "NOT everyone mentioned" in source.EXTRACT_SYSTEM
    assert "self-contained third-person" in source.EXTRACT_SYSTEM
    assert "does not make its contents asserted" in source.EXTRACT_SYSTEM
    assert "NOT independent evidence" in source.EXTRACT_SYSTEM
    assert "Do not infer a breakup" in source.EXTRACT_SYSTEM
    assert "not invent a fact" in source.EXTRACT_SYSTEM
    assert source.Extraction.model_validate({"facts": []}).facts == []


@pytest.mark.asyncio
@pytest.mark.parametrize("model,effort", [("gpt-6-luna", "low"), ("project-reasoning-model", "high")])
async def test_fact_extraction_uses_project_model_and_reasoning_on_wire(monkeypatch, model, effort):
    client, bodies = model_transport([json.dumps({"facts": []})])
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    try:
        result = await source.extract_source(request_body((("u-one", "user", "Hello"),)),
            rules={"language": "en", "event_tag_definitions": [],
                   "llm_model": model, "reasoning_effort": effort})
        assert result.facts == [] and len(bodies) == 1
        assert bodies[0]["model"] == model and bodies[0]["reasoning_effort"] == effort
        assert set(json.loads(bodies[0]["messages"][1]["content"])["configuration"]) == {
            "language"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_actual_extract_preserves_full_roles_ids_times_and_joint_support(monkeypatch):
    case = next(case for case in CASES if case.name == "joint_reference")
    payload = {"facts": [fact("Rooibos tea is the user's favorite drink", [["u-preference", "a-option"]])]}
    client, bodies = model_transport([json.dumps(payload)])
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    accounting = AsyncMock()
    monkeypatch.setattr(source, "record_completion_usage", accounting)
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    request = request_body(case.messages)
    rules = {"language": "en", "event_tag_definitions": [], "strict_mode": False}
    try:
        result = await source.extract_source(request, rules=rules)
        wire = bodies[0]
        assert json.loads(wire["messages"][1]["content"]) == {
            "configuration": {"language": "en"},
            "related_facts": [],
            "messages": [{**message.model_dump(mode="json"), "local_recorded_date": None}
                         for message in request.messages]}
        assert wire["response_format"]["json_schema"]["schema"] == source.Extraction.model_json_schema()
        assert wire["response_format"]["json_schema"]["strict"] is True
        assert result.facts[0]["support_groups"] == [["u-preference", "a-option"]]
        assert result.facts[0]["occurred_at"] == request.messages[1].occurred_at
        assert result.facts[0]["event_time"] is None
        assert len(bodies) == 1 and accounting.await_count == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("groups", [[["missing-id"]], [["a-only"]]])
async def test_actual_extract_rejects_unknown_or_assistant_only_evidence(monkeypatch, groups):
    payload = {"facts": [fact("Rooibos tea is the favorite drink", groups)]}
    client, bodies = model_transport([json.dumps(payload)])
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    request = request_body((("u-first", "user", "Hello"), ("a-only", "assistant", "You love tea")))
    try:
        with pytest.raises(source.SourceError, match="Fact evidence") as error:
            await source.extract_source(request, rules={"language": "en", "event_tag_definitions": []})
        assert error.value.code == "invalid_model_output" and len(bodies) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_compute_only_allows_empty_without_retry_and_no_db_redis_or_accounting(monkeypatch):
    client, bodies = model_transport(['{"facts":[]}'])
    original_accounting = AsyncMock(side_effect=AssertionError("Business accounting was called"))
    monkeypatch.setattr(source, "record_completion_usage", original_accounting)
    case = next(case for case in CASES if case.name == "smalltalk")
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(case,), client=client)
        assert report["passed"] is True and report["cases"][0]["facts"] == []
        assert len(bodies) == 1 and original_accounting.await_count == 0
        assert source.record_completion_usage is original_accounting
        assert bodies[0]["model"] == "gpt-6-luna" and bodies[0]["reasoning_effort"] == "high"
        assert bodies[0]["service_tier"] == "default"
        assert bodies[0]["max_completion_tokens"] == CONFIG.source_output_reserve_tokens
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_positive_empty_is_quality_failure_not_protocol_error_or_retry():
    client, bodies = model_transport(['{"facts":[]}'])
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
        assert report["passed"] is False and "error" not in report["cases"][0]
        assert report["cases"][0]["checks"]["expected_concepts"] is False and len(bodies) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_past_relationship_empty_extraction_is_a_quality_failure_without_replay():
    case = next(case for case in CASES if case.name == "past_relationship")
    client, bodies = model_transport(['{"facts":[]}'])
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(case,), client=client)
        assert report["passed"] is False and "error" not in report["cases"][0]
        assert report["cases"][0]["checks"]["expected_concepts"] is False
        assert len(bodies) == 1
        messages = json.loads(bodies[0]["messages"][1]["content"])["messages"]
        assert messages[0]["content"] == case.messages[0][2] and messages[0]["message_id"] == "M3"
    finally:
        await client.close()


@pytest.mark.parametrize("content,passed", [
    ("The user's partner was Lin. Lin moved to Hangzhou.", True),
    ("The user's former partner Lin moved to Hangzhou.", True),
    ("The user's former partner Lin is from Hangzhou, where the user moved.", False),
    ("The user's current partner Lin moved to Hangzhou.", False),
])
def test_past_relationship_grade_requires_historical_relation_and_original_actor(content, passed):
    case = next(case for case in CASES if case.name == "past_relationship")
    assert all(grade(case, [fact(content, [["M3"]])]).values()) is passed


@pytest.mark.asyncio
async def test_compute_only_does_not_bypass_evidence_parser_and_redacts_error():
    client, bodies = model_transport([json.dumps({"facts": [fact("wrong", [["fake-secret-id"]])]})])
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
        assert report["passed"] is False and len(bodies) == 1
        assert report["cases"][0]["error"] == {"code": "invalid_model_output", "status": 502}
        assert "fake-secret-id" not in json.dumps(report) and SETTINGS["api_key"] not in json.dumps(report)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_compute_only_forbids_business_sql_and_redis(monkeypatch):
    from memoia_server import connectors
    from redis.asyncio.connection import AbstractConnection

    async def accidental_sql(*args, **kwargs):
        connectors.DB_ENGINE.connect()

    async def accidental_redis(*args, **kwargs):
        await AbstractConnection.connect(None)

    client, bodies = model_transport([])
    try:
        for accidental in (accidental_sql, accidental_redis):
            monkeypatch.setattr(source, "extract_source", accidental)
            report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
            assert report["passed"] is False
            assert report["cases"][0]["error"] == {"code": "quality_call_failed", "type": "RuntimeError"}
        assert bodies == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_baseline_override_restores_single_prompt_truth_and_strict_evidence_retained():
    case = next(case for case in CASES if case.strict)
    payload = {"facts": [fact("Collects model trains as a hobby", [["u-outside"]])]}
    client, bodies = model_transport([json.dumps(payload)])
    original = source.EXTRACT_SYSTEM
    try:
        report = await run_quality(read_settings({**SETTINGS, "extract_system": "public baseline system"}), cases=(case,), client=client)
        assert report["passed"] and source.EXTRACT_SYSTEM == original
        assert bodies[0]["messages"][0]["content"] == "public baseline system"
        configuration = json.loads(bodies[0]["messages"][1]["content"])["configuration"]
        assert set(configuration) == {"language"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_extraction_preserves_out_of_profile_evidence_without_duplicate_classification(monkeypatch):
    case = next(case for case in CASES if case.strict)
    fid = UUID("0162c48f-c526-4264-a1a4-c6e4ec2f9804")
    rules = {"language": "en", "strict_mode": True, "validate_values": True,
             "profile_topics": [{"topic": "work", "description": "Employment only", "sub_topics": [
                 {"name": "occupation", "description": "User's real occupation"}]}],
             "event_tag_definitions": [], "event_theme_requirement": "Employment only"}
    payload = {"facts": [fact("Collects model trains as a hobby", [["u-outside"]])]}
    client, bodies = model_transport([json.dumps(payload)])
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    monkeypatch.setattr(source, "uuid4", lambda: fid)
    try:
        extracted = await source.extract_source(request_body(case.messages), rules=rules)
        assert len(extracted.facts) == 1 and extracted.facts[0]["support_groups"] == [["u-outside"]]
        extracted_configuration = json.loads(bodies[0]["messages"][1]["content"])["configuration"]
        assert extracted_configuration == {"language": "en"}
        assert len(bodies) == 1 and "event_tags" not in bodies[0]["response_format"]["json_schema"]["schema"]["properties"]
        assert rules["strict_mode"] is True and rules["event_theme_requirement"] == "Employment only"
    finally:
        await client.close()


def test_fixed_grade_rejects_wrong_message_support_and_unexpected_fact():
    case = CASES[0]
    correct = [fact("Rooibos tea is my favorite drink", [["u-tea"]]), fact("Collects model trains", [["u-trains"]])]
    assert all(grade(case, correct).values())
    assert not all(grade(case, [*correct, fact("Lives on Mars", [["u-tea"]])]).values())
    correct[0]["support_groups"] = [["u-trains"]]
    assert not all(grade(case, correct).values())


def test_people_subject_and_uncertainty_grade_reject_wrong_owner_or_asserted_guess():
    case = next(row for row in CASES if row.name == "people_subject")
    mother = {**fact("Zhou's mother has diabetes", [["u-mother"]]), "subject": "Zhou's mother"}
    carer = {**fact("Zhou takes care of his mother", [["u-mother"]]), "subject": "Zhou"}
    assert all(grade(case, [mother, carer]).values())
    assert not all(grade(case, [{**mother, "subject": "Zhou"}, carer]).values())
    case = next(row for row in CASES if row.name == "reported_uncertainty")
    busy = {**fact("Zhou has been busy", [["u-busy"]]), "subject": "Zhou"}
    guess = {**fact("The user suspects Zhou might quit his job", [["u-busy"]]),
             "subject": "Zhou", "certainty": "uncertain"}
    assert all(grade(case, [busy, guess]).values())
    assert not all(grade(case, [busy, {**guess, "certainty": "asserted"}]).values())
    colleague = {**fact("Zhou is the user's colleague", [["u-busy"]]), "subject": "Zhou"}
    assert all(grade(case, [busy, guess, colleague]).values())


def test_two_cancellations_grade_requires_matching_actor_cause_and_month():
    case = next(row for row in CASES if row.name == "two_cancellations")
    lin = {**fact("Lin cancelled the hiking plan because of rain", [["M5a"]]), "subject": "Lin",
           "event_time": {"start": "2025-02-01", "end": "2025-02-28"}}
    zhou = {**fact("Zhou cancelled the hiking plan because of overtime", [["M5b"]]), "subject": "Zhou",
            "event_time": {"start": "2025-03-01", "end": "2025-03-31"}}
    assert all(grade(case, [lin, zhou]).values())
    assert not all(grade(case, [lin, {**zhou, "event_time": lin["event_time"]}]).values())
    assert not all(grade(case, [lin, {**zhou, "support_groups": [["M5a"]]}]).values())


def test_quality_dates_follow_actual_extraction_serialization():
    case = next(row for row in CASES if row.name == "two_cancellations")
    rows = []
    for subject, cause, message_id, expression, start, end in (
        ("Lin", "rain", "M5a", "In February 2025", "2025-02-01", "2025-02-28"),
        ("Zhou", "overtime", "M5b", "In March 2025", "2025-03-01", "2025-03-31"),
    ):
        parsed = source.ExtractedFact.model_validate({
            **fact(f"{subject} cancelled the hiking plan because of {cause}", [[message_id]]),
            "subject": subject, "event_time": {"start": start, "end": end, "precision": "month",
                "evidence": [{"message_id": message_id, "expression": expression}]},
        })
        rows.append(parsed.model_dump(mode="json"))
    assert all(grade(case, rows).values())


@pytest.mark.parametrize("groups", [
    [["u-preference", "a-option"]],
    [["u-preference", "a-option", "u-confirm"]],
    [["u-preference", "a-option"], ["u-preference", "a-option", "u-confirm"]],
])
def test_joint_reference_accepts_only_explicit_full_support_alternatives(groups):
    case = next(case for case in CASES if case.name == "joint_reference")
    assert all(grade(case, [fact("Rooibos tea is the user's favorite drink", groups)]).values())


@pytest.mark.parametrize("groups", [
    [["u-preference", "a-option", "unrelated"]],
    [["a-option", "u-confirm"]],
    [["u-preference", "u-confirm"]],
    [["u-preference", "a-option"], ["u-preference", "a-option", "unrelated"]],
])
def test_joint_reference_does_not_accept_arbitrary_supersets_or_missing_context(groups):
    case = next(case for case in CASES if case.name == "joint_reference")
    assert not all(grade(case, [fact("Rooibos tea is the user's favorite drink", groups)]).values())


@pytest.mark.parametrize("content", [
    "The user does not collect model trains as a hobby",
    "The user doesn't collect model trains",
    "The user never collects model trains",
    "The user is no longer collecting model trains",
    "The user is not interested in model trains",
])
def test_hobby_keyword_alone_does_not_turn_explicit_negation_into_positive(content):
    case = next(case for case in CASES if case.name == "strict_slots")
    assert not all(grade(case, [fact(content, [["u-outside"]])]).values())


def test_corrected_preference_checks_named_negation_without_rejecting_not_coffee():
    case = next(case for case in CASES if case.name == "corrected_preference")
    assert all(grade(case, [fact("The user prefers rooibos tea, not coffee", [["u-correct"]])]).values())
    assert not all(grade(case, [fact("The user dislikes rooibos tea", [["u-correct"]])]).values())


@pytest.mark.parametrize("groups", [
    [["u-correct"]],
    [["u-old", "u-correct"]],
    [["u-correct"], ["u-old", "u-correct"]],
])
def test_corrected_preference_accepts_only_explicit_correction_support_alternatives(groups):
    case = next(case for case in CASES if case.name == "corrected_preference")
    assert all(grade(case, [fact("The user's favorite drink is rooibos tea, not coffee", groups)]).values())


@pytest.mark.parametrize("groups", [
    [["u-old"]],
    [["u-old", "u-correct", "unrelated"]],
    [["u-correct"], ["u-old", "unrelated"]],
])
def test_corrected_preference_rejects_missing_correction_or_arbitrary_evidence(groups):
    case = next(case for case in CASES if case.name == "corrected_preference")
    assert not all(grade(case, [fact("The user's favorite drink is rooibos tea, not coffee", groups)]).values())


@pytest.mark.parametrize("replacement", [{"api_key": ""}, {"model": ""}, {"trials": True}, {"trials": 6},
    {"deadline_seconds": 7201}, {"base_url": "https://token@example.invalid/v1"}, {"base_url": "https://example.invalid/v1?key=token"}])
def test_settings_fail_closed_without_silent_model_or_credential_fallback(replacement):
    with pytest.raises(ValueError):
        read_settings({**SETTINGS, **replacement})


def test_cli_list_and_missing_config_never_read_dotenv_or_call_models():
    result = subprocess.run([sys.executable, "-m", "memoia_server.source_quality", "--list"], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["cases"] == [case.name for case in CASES]
    result = subprocess.run([sys.executable, "-m", "memoia_server.source_quality"], input="{}", capture_output=True, text=True)
    assert result.returncode == 1 and "quality_setup_failed" in result.stdout
    assert "configuration loaded" not in result.stderr.lower()
