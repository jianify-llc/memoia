"""Synthetic fixtures + real OpenAI SDK transport; never a real model-quality claim."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from openai import AsyncOpenAI

from memoia_server.controllers import source
from memoia_server.env import CONFIG
from memoia_server.models.source import ImportSource
from memoia_server.source_quality import grade, read_settings, run_quality
from memoia_server.source_quality_cases import CASES, ExpectedFact, QualityCase


SETTINGS = {"api_key": "quality-fake-key", "model": "gpt-6-luna", "base_url": "https://example.invalid/v1"}


@pytest.fixture(autouse=True)
def native_cache_capability(monkeypatch):
    monkeypatch.setattr(CONFIG, "llm_base_url", None)
    monkeypatch.setattr(CONFIG, "llm_prompt_cache_options", None)


def source_material(content, tag="source_material"):
    root = ElementTree.fromstring(content)
    assert root.tag == tag and len(root) == 0
    return json.loads(root.text)


def request_body(messages):
    return ImportSource(idempotency_key="quality-unit", source_id="quality-unit", messages=[
        {"message_id": mid, "role": role, "content": content, "occurred_at": f"2026-01-01T00:00:{index:02d}Z"}
        for index, (mid, role, content) in enumerate(messages)
    ])


def model_transport(contents, *, usages=None):
    bodies = []

    def respond(request):
        assert request.url.path == "/v1/responses"
        assert len(bodies) < len(contents), "Unexpected model request: provide every response explicitly"
        bodies.append(json.loads(request.content))
        content = contents[len(bodies) - 1]
        if callable(content):
            content = content(source_material(bodies[-1]["input"][1]["content"][0]["text"])["messages"])
        return httpx.Response(200, json={"id": "resp-quality", "object": "response", "created_at": 0,
            "model": "gpt-6-luna", "status": "completed", "error": None,
            "usage": usages[len(bodies) - 1] if usages is not None else None,
            "output": [{"id": "msg-quality", "type": "message", "status": "completed", "role": "assistant",
                        "content": [{"type": "output_text", "text": content, "annotations": []}]}]})

    client = AsyncOpenAI(api_key=SETTINGS["api_key"], base_url=SETTINGS["base_url"], max_retries=0,
                         http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    return client, bodies


def fact(content, groups):
    return {"content": content, "subject": "the user", "reporter": "the user", "certainty": "asserted", "support_groups": groups,
            "fact_time": None}


def model_outputs(facts):
    def wire_content(messages):
        buckets = [{"message_id": message["message_id"], "facts": []}
                   for message in messages if message["role"] == "user"]
        for value in facts:
            groups = value["support_groups"]
            anchor = next((bucket for bucket in buckets
                           if any(bucket["message_id"] in group for group in groups)), buckets[0])
            anchor["facts"].append({**{key: item for key, item in value.items() if key != "support_groups"},
                                    "any_of": [{"all_of": group} for group in groups]})
        return json.dumps({"messages": buckets})
    return [wire_content]


def test_extraction_loads_complete_prompt_and_keeps_empty_output_contract():
    prompt = Path(source.__file__).parent.parent / "prompts" / "fact_extraction.md"
    assert source.EXTRACT_SYSTEM == prompt.read_text(encoding="utf-8").strip()
    assert source.MessageExtraction.model_validate({"messages": [{"message_id": "u", "facts": []}]}).messages[0].facts == []


def test_removable_name_fixture_rejects_identity_copied_into_independent_preference():
    case = next(case for case in CASES if case.name == "removable_user_name")
    name = fact("The user's name is Renata Calder", [["u-name"]])
    preference = fact("The user's favourite food is lemon risotto", [["u-food"]])
    assert all(grade(case, [name, preference]).values())
    leaked = {**preference, "content": "Renata Calder's favourite food is lemon risotto"}
    assert not all(grade(case, [name, leaked]).values())


@pytest.mark.asyncio
@pytest.mark.parametrize("model,effort", [("gpt-6-luna", "low"), ("project-reasoning-model", "high")])
async def test_fact_extraction_uses_project_model_and_reasoning_on_wire(monkeypatch, model, effort):
    client, bodies = model_transport(model_outputs([]))
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    try:
        result = await source.extract_source(request_body((("u-one", "user", "Hello"),)),
            rules={"language": "en", "event_tag_definitions": [],
                   "llm_model": model, "reasoning_effort": effort})
        assert result.facts == [] and len(bodies) == 1
        assert all(wire["model"] == model and wire["reasoning"] == {"effort": effort, "mode": "standard"}
                   and wire["service_tier"] == "default" and wire["store"] is False for wire in bodies)
        assert set(source_material(bodies[0]["input"][1]["content"][0]["text"])) == {"messages"}
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,effort,temperature,expected_temperature", [
    ("gpt-6.1-terra", "none", 0.2, 0.2), ("gpt-6-luna", "none", 0, 0),
    ("gpt-6.1-terra", "high", 0.2, None), ("gpt-6.1-terra", "none", None, None),
])
async def test_fact_overrides_on_wire_preserve_cache_and_single_call(
        monkeypatch, model, effort, temperature, expected_temperature):
    client, bodies = model_transport(model_outputs([]))
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    try:
        await source.extract_source(request_body((("u-one", "user", "Hello"),)), rules={
            "llm_model": "gpt-6-luna", "reasoning_effort": "high",
            "fact_llm_model": model, "fact_reasoning_effort": effort, "fact_temperature": temperature})
        assert len(bodies) == 1
        wire = bodies[0]
        assert wire["model"] == model and wire["reasoning"] == {"effort": effort, "mode": "standard"}
        assert wire.get("temperature") == expected_temperature
        assert ("temperature" in wire) == (expected_temperature is not None)
        assert wire["service_tier"] == "default" and wire["store"] is False
        assert wire["prompt_cache_options"] == {"mode": "explicit", "ttl": "30m"}
        assert wire["input"][0]["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
        assert "prompt_cache_breakpoint" not in wire["input"][1]["content"][0]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("project_language", ["en", "zh", None])
async def test_extraction_preserves_mixed_language_material_and_result_without_language_configuration(
        monkeypatch, project_language):
    # Wire preservation, not proof that a real model follows the language instruction.
    request = request_body((("zh", "user", "我喜欢骑车。"),
                            ("en", "user", "I enjoy visiting libraries.")))
    expected = [
        {**fact("用户喜欢骑车。", [["zh"]]), "subject": "用户", "reporter": "用户"},
        fact("The user enjoys visiting libraries.", [["en"]]),
    ]
    client, bodies = model_transport(model_outputs(expected))
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    rules = {"language": project_language} if project_language else None
    try:
        extracted = await source.extract_source(request, rules=rules)
        assert len(bodies) == 1
        assert source_material(bodies[0]["input"][1]["content"][0]["text"]) == {
            "messages": [{**message.model_dump(mode="json", exclude={"time_zone"}), "local_recorded_date": None}
                         for message in request.messages]}
        assert [{key: item[key] for key in expected[0]} for item in extracted.facts] == expected
        recovered = await source.extract_source(request, rules=rules, candidate={"facts": expected})
        assert [{key: item[key] for key in expected[0]} for item in recovered.facts] == expected
        assert len(bodies) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("messages,expected", [
    (next(case for case in CASES if case.name == "joint_reference").messages,
     fact("Rooibos tea is the user's favorite drink", [["u-preference", "a-option"]])),
    ((("identity", "user", "My colleague Mira stayed late."),
      ("guess", "assistant", "Maybe they missed a bus."),
      ("concern", "user", "I don't know; I worry they are tired."),
      ("independent", "user", "I worry Mira is tired.")),
     fact("The user is worried Mira is tired.", [["identity", "concern"], ["independent"]])),
    ((("visit", "user", "I returned the parcel at the shop and bought a stamp there. I plan to mail a letter."),),
     fact("The user returned a parcel at the shop and bought a stamp during that visit.", [["visit"]])),
    ((("gift", "user", "I made a scarf for my sister."),),
     fact("The user made a scarf for their sister.", [["gift"]])),
    ((("identity", "user", "I am a man and use he/him pronouns."),),
     fact("The user is a man and uses he/him pronouns.", [["identity"]])),
    ((("identity", "user", "My colleague Mira stayed late."),
      ("guess", "assistant", "Maybe they missed a bus."),
      ("uncertainty", "user", "I don't know whether they missed a bus.")),
     fact("The user does not know whether Mira missed a bus.", [["identity", "uncertainty"]])),
    ((("possibility", "user", "Mira may be tired."),),
     {**fact("Mira may be tired.", [["possibility"]]), "subject": "Mira", "certainty": "uncertain"}),
    ((("report", "user", "Mira told me the office was closed."),),
     {**fact("According to Mira, the office was closed.", [["report"]]),
      "subject": "the office", "certainty": "reported"}),
    ((("past", "user", "I used to live in Nanjing."),
      ("present", "user", "Now I live in Suzhou.")),
     fact("The user used to live in Nanjing and now lives in Suzhou.", [["past", "present"]])),
    ((("claim", "user", "I live in Nanjing."),
      ("correction", "user", "Sorry, I meant Suzhou, not Nanjing.")),
     fact("The user corrected their residence to Suzhou, not Nanjing.", [["claim", "correction"]])),
    ((("question", "assistant", "你更喜欢安静的图书馆吗？"),
      ("confirmation", "user", "OK")),
     {**fact("用户更喜欢安静的图书馆。", [["question", "confirmation"]]),
      "subject": "用户", "reporter": "用户"}),
    ((("question", "assistant", "Do you prefer quiet libraries?"),
      ("confirmation", "user", "👍")),
     fact("The user prefers quiet libraries.", [["question", "confirmation"]])),
])
async def test_actual_extract_preserves_full_roles_ids_times_and_joint_support(monkeypatch, messages, expected):
    # Transport preservation only; semantic choices are assessed with real-model cases.
    outputs = model_outputs([expected])
    client, bodies = model_transport(outputs)
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    accounting = AsyncMock()
    monkeypatch.setattr(source, "record_completion_usage", accounting)
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    request = request_body(messages)
    rules = {"language": "en"}
    try:
        result = await source.extract_source(request, rules=rules)
        wire = bodies[0]
        assert len(wire["input"]) == 2
        assert wire["prompt_cache_options"] == {"mode": "explicit", "ttl": "30m"}
        assert wire["input"][0] == {"role": "developer", "content": [{
            "type": "input_text", "text": source.EXTRACT_SYSTEM,
            "prompt_cache_breakpoint": {"mode": "explicit"}}]}
        assert wire["input"][1]["role"] == "developer"
        assert "prompt_cache_key" not in wire
        assert source_material(wire["input"][1]["content"][0]["text"]) == {
            "messages": [{**message.model_dump(mode="json", exclude={"time_zone"}), "local_recorded_date": None}
                         for message in request.messages]}
        assert wire["text"]["format"]["schema"] == source.MessageExtraction.model_json_schema()
        assert wire["text"]["format"]["strict"] is True
        assert {key: result.facts[0][key] for key in expected} == expected
        supported = {mid for group in expected["support_groups"] for mid in group}
        assert result.facts[0]["occurred_at"] == max(
            message.occurred_at for message in request.messages if message.message_id in supported)
        assert len(bodies) == 1 and accounting.await_count == 1
        assert "prompt_cache_breakpoint" not in wire["input"][1]["content"][0]
        assert all("previous_response_id" not in body and "prompt_cache_key" not in body and "include" not in body
                   and all(item["role"] == "developer" for item in body["input"]) for body in bodies)
        assert all(body["store"] is False and body["service_tier"] == "default"
                   and body["text"]["verbosity"] == "low" for body in bodies)
        assert [call.kwargs["kind"] for call in accounting.await_args_list] == ["fact_extraction"]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("groups", [[["missing-id"]], [["a-only"]]])
async def test_actual_extract_rejects_unknown_or_assistant_only_evidence(monkeypatch, groups):
    client, bodies = model_transport(model_outputs([fact("Rooibos tea is the favorite drink", groups)]))
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    request = request_body((("u-first", "user", "Hello"), ("a-only", "assistant", "You love tea")))
    try:
        with pytest.raises(source.SourceError) as error:
            await source.extract_source(request, rules={"language": "en", "event_tag_definitions": []})
        assert error.value.code == "invalid_model_output" and len(bodies) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_compute_only_allows_empty_without_retry_and_no_db_redis_or_accounting(monkeypatch):
    client, bodies = model_transport(model_outputs([]))
    original_accounting = AsyncMock(side_effect=AssertionError("Business accounting was called"))
    monkeypatch.setattr(source, "record_completion_usage", original_accounting)
    case = next(case for case in CASES if case.name == "smalltalk")
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(case,), client=client)
        assert report["passed"] is True and report["cases"][0]["facts"] == []
        assert len(bodies) == 1 and original_accounting.await_count == 0
        assert source.record_completion_usage is original_accounting
        assert all(body["model"] == "gpt-6-luna" and body["reasoning"] == {"effort": "high", "mode": "standard"}
                   and body["service_tier"] == "default" and body["store"] is False
                   and body["max_output_tokens"] == CONFIG.source_output_reserve_tokens for body in bodies)
        assert report["evaluation_scope"] == "extraction_heuristic_screen_not_semantic_acceptance"
        assert report["human_review_required"] is True
        assert [call["kind"] for call in report["cases"][0]["model_calls"]] == ["fact_extraction"]
        assert report["extract_schema_sha256"] == hashlib.sha256(json.dumps(
            source.MessageExtraction.model_json_schema(), sort_keys=True).encode()).hexdigest()
        assert not any("association" in key for key in report)
        assert report["extract_system_override_scope"] is None
        assert all(call["input_tokens"] is None for call in report["cases"][0]["model_calls"])
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_positive_empty_is_quality_failure_not_protocol_error_or_retry():
    client, bodies = model_transport(model_outputs([]))
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
        assert report["passed"] is False and "error" not in report["cases"][0]
        assert report["cases"][0]["checks"]["expected_concepts"] is False and len(bodies) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_compute_only_retains_single_call_usage_without_summing_cache_again():
    usages = [
        {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
         "input_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 40}},
    ]
    client, bodies = model_transport(model_outputs([]), usages=usages)
    case = next(case for case in CASES if case.name == "smalltalk")
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(case,), client=client)
        calls = report["cases"][0]["model_calls"]
        assert report["passed"] and len(bodies) == len(calls) == 1
        assert [call["kind"] for call in calls] == ["fact_extraction"]
        assert [(call["input_tokens"], call["output_tokens"], call["cached_tokens"], call["cache_write_tokens"])
                for call in calls] == [(100, 20, 30, 40)]
        assert calls[0]["input_tokens"] == 100
        assert calls[0]["output_tokens"] == 20
        assert all(call["latency_ms"] >= 0 for call in calls)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_past_relationship_empty_extraction_is_a_quality_failure_without_replay():
    case = next(case for case in CASES if case.name == "past_relationship")
    client, bodies = model_transport(model_outputs([]))
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(case,), client=client)
        assert report["passed"] is False and "error" not in report["cases"][0]
        assert report["cases"][0]["checks"]["expected_concepts"] is False
        assert len(bodies) == 1
        messages = source_material(bodies[0]["input"][1]["content"][0]["text"])["messages"]
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
    client, bodies = model_transport(model_outputs([fact("wrong", [["fake-secret-id"]])]))
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
        assert report["passed"] is False and len(bodies) == 1
        assert report["cases"][0]["error"] == {"code": "invalid_model_output", "status": 502}
        assert "fake-secret-id" not in json.dumps(report) and SETTINGS["api_key"] not in json.dumps(report)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_compute_only_reports_missing_evidence_without_content_leak_or_retry():
    client, bodies = model_transport(model_outputs([fact("Sensitive fixture content", [])]))
    try:
        report = await run_quality(read_settings(SETTINGS), cases=(CASES[0],), client=client)
        assert report["passed"] is False and len(bodies) == 1
        assert report["cases"][0]["facts"] == []
        assert report["cases"][0]["error"] == {"code": "invalid_model_output", "status": 502}
        assert "Sensitive fixture content" not in json.dumps(report)
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
async def test_baseline_override_restores_single_prompt_truth_and_evidence_retained():
    case = next(case for case in CASES if case.name == "hobby_statement")
    client, bodies = model_transport(model_outputs([fact("Collects model trains as a hobby", [["u-outside"]])]))
    original = source.EXTRACT_SYSTEM
    try:
        report = await run_quality(read_settings({**SETTINGS, "extract_system": "public baseline system"}), cases=(case,), client=client)
        assert report["passed"] and source.EXTRACT_SYSTEM == original
        assert bodies[0]["input"][0] == {"role": "developer", "content": [{
            "type": "input_text", "text": "public baseline system"}]}
        assert all("prompt_cache_options" not in body for body in bodies)
        assert len(bodies) == 1 and report["extract_system_override_scope"] == "fact_extraction_only"
        assert report["extract_system_sha256"] == hashlib.sha256(b"public baseline system").hexdigest()
        assert set(source_material(bodies[0]["input"][1]["content"][0]["text"])) == {"messages"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_extraction_preserves_out_of_profile_evidence_without_duplicate_classification(monkeypatch):
    case = next(case for case in CASES if case.name == "hobby_statement")
    fid = UUID("0162c48f-c526-4264-a1a4-c6e4ec2f9804")
    rules = {"language": "en",
             "profile_topics": [{"topic": "work", "description": "Employment only", "sub_topics": [
                 {"name": "occupation", "description": "User's real occupation"}]}],
             "event_tag_definitions": []}
    client, bodies = model_transport(model_outputs([fact("Collects model trains as a hobby", [["u-outside"]])]))
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    monkeypatch.setattr(source, "uuid4", lambda: fid)
    try:
        extracted = await source.extract_source(request_body(case.messages), rules=rules)
        assert len(extracted.facts) == 1 and extracted.facts[0]["support_groups"] == [["u-outside"]]
        assert set(source_material(bodies[0]["input"][1]["content"][0]["text"])) == {"messages"}
        assert len(bodies) == 1
        assert all("event_tags" not in body["text"]["format"]["schema"]["properties"] for body in bodies)
        assert rules["profile_topics"][0]["topic"] == "work"
    finally:
        await client.close()


def test_fixed_grade_rejects_wrong_message_support_and_unexpected_fact():
    case = next(case for case in CASES if case.name == "self_preferences")
    correct = [fact("Rooibos tea is my favorite drink", [["u-tea"]]), fact("Collects model trains", [["u-trains"]])]
    assert all(grade(case, correct).values())
    assert not all(grade(case, [*correct, fact("Lives on Mars", [["u-tea"]])]).values())
    correct[0]["support_groups"] = [["u-trains"]]
    assert not all(grade(case, correct).values())


@pytest.mark.parametrize("facts,passed", [
    ([fact("The user worries Mira is tired", [["identity", "concern"]]),
      fact("The user worries Mira is tired", [["independent"]])], True),
    ([fact("The user worries Mira is tired", [["identity", "concern"], ["independent"]])], True),
    ([fact("The user worries Mira is tired", [["independent"]])], False),
    ([fact("The user worries Mira is tired", [["identity", "concern"]])], False),
    ([fact("The user worries about Mira", [["identity", "concern"]]),
      fact("Mira is tired", [["independent"]])], False),
    ([fact("The user worries Mira is tired", [["identity", "concern"]]),
      fact("The user worries Mira is tired", [["concern"]])], False),
])
def test_grade_checks_complete_facts_before_accepting_independent_support(facts, passed):
    case = QualityCase("independent_worry", (), (
        ExpectedFact((("worries",), ("mira",), ("tired",)),
                     (("identity", "concern"), ("independent",))),
    ))
    assert all(grade(case, facts).values()) is passed


def test_people_subject_and_uncertainty_grade_reject_wrong_owner_or_asserted_guess():
    case = next(row for row in CASES if row.name == "people_subject")
    mother = {**fact("Zhou's mother has diabetes", [["u-mother"]]), "subject": "Zhou's mother"}
    carer = {**fact("Zhou takes care of his mother", [["u-mother"]]), "subject": "Zhou"}
    assert all(grade(case, [mother, carer]).values())
    assert not all(grade(case, [{**mother, "subject": "Zhou"}, carer]).values())
    case = next(row for row in CASES if row.name == "reported_uncertainty")
    busy = {**fact("Zhou has been busy", [["u-busy"]]), "subject": "Zhou"}
    guess = {**fact("Zhou might quit his job, according to the user's suspicion", [["u-busy"]]),
             "subject": "Zhou", "certainty": "uncertain"}
    assert all(grade(case, [busy, guess]).values())
    assert not all(grade(case, [busy, {**guess, "certainty": "asserted"}]).values())
    colleague = {**fact("Zhou is the user's colleague", [["u-busy"]]), "subject": "Zhou"}
    assert all(grade(case, [busy, guess, colleague]).values())


def test_two_cancellations_grade_requires_matching_actor_cause_and_month():
    case = next(row for row in CASES if row.name == "two_cancellations")
    lin = {**fact("Lin cancelled the hiking plan because of rain", [["M5a"]]), "subject": "Lin",
           "fact_time": {"start": "2025-02-01", "end": "2025-02-28"}}
    zhou = {**fact("Zhou cancelled the hiking plan because of overtime", [["M5b"]]), "subject": "Zhou",
            "fact_time": {"start": "2025-03-01", "end": "2025-03-31"}}
    assert all(grade(case, [lin, zhou]).values())
    assert not all(grade(case, [lin, {**zhou, "fact_time": lin["fact_time"]}]).values())
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
            "subject": subject, "fact_time": {"start": start, "end": end, "precision": "month",
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
    case = next(case for case in CASES if case.name == "hobby_statement")
    assert not all(grade(case, [fact(content, [["u-outside"]])]).values())


def test_corrected_preference_checks_named_negation_without_rejecting_not_coffee():
    case = next(case for case in CASES if case.name == "corrected_preference")
    assert all(grade(case, [fact("The user prefers rooibos tea, not coffee", [["u-correct"]])]).values())
    assert not all(grade(case, [fact("The user dislikes rooibos tea", [["u-correct"]])]).values())


def test_correction_screen_allows_supported_history_but_not_wrong_support():
    case = next(case for case in CASES if case.name == "corrected_preference")
    correction = fact("The user prefers rooibos tea, not coffee", [["u-correct"]])
    historical = fact("The user originally stated coffee was their favorite drink", [["u-old"]])
    assert all(grade(case, [correction, historical]).values())
    assert not all(grade(case, [correction, {**historical, "support_groups": [["u-correct"]]}]).values())
    for wrong_history in ("The user's favorite drink is coffee",
                          "The user's favorite drink was previously coffee"):
        assert not all(grade(case, [correction, {**historical, "content": wrong_history}]).values())


@pytest.mark.parametrize("content,subject,certainty,passed", [
    ("Zhou might quit his job, according to the user's suspicion.", "Zhou", "uncertain", True),
    ("The user suspects Zhou might quit his job.", "the user", "asserted", True),
    ("The user is unsure whether Zhou might quit his job.", "user", "asserted", True),
    ("Zhou might quit his job.", "Zhou", "asserted", False),
    ("The user suspects Zhou might quit his job.", "the user", "uncertain", False),
    ("The user suspects Zhou might quit his job.", "Zhou", "uncertain", False),
    ("Zhou might quit his job.", "the user", "asserted", False),
    ("Zhou has quit his job.", "Zhou", "asserted", False),
    ("The user suspects Zhou might quit but he has resigned.", "the user", "asserted", False),
])
def test_uncertainty_screen_pairs_the_claim_with_its_subject_and_certainty(content, subject, certainty, passed):
    case = next(case for case in CASES if case.name == "reported_uncertainty")
    busy = {**fact("Zhou has been busy recently.", [["u-busy"]]), "subject": "Zhou"}
    claim = {**fact(content, [["u-busy"]]), "subject": subject, "certainty": certainty}
    assert all(grade(case, [busy, claim]).values()) is passed
    if passed:
        assert not all(grade(case, [busy, {**claim, "support_groups": [["a-guess"]]}]).values())
        assert not all(grade(case, [busy, {**claim, "support_groups": [["u-busy", "a-guess"]]}]).values())


def test_user_doubt_exception_does_not_relax_other_fixture_certainty():
    original = next(case for case in CASES if case.name == "reported_uncertainty")
    other = QualityCase("other_uncertainty", original.messages, original.expected)
    facts = [{**fact("Zhou has been busy recently.", [["u-busy"]]), "subject": "Zhou"},
             fact("The user suspects Zhou might quit his job.", [["u-busy"]])]
    assert all(grade(original, facts).values())
    assert not all(grade(other, facts).values())


def test_normal_chain_cases_have_fixed_roles_steps_and_deletion_identities():
    # Fixture integrity only: semantic quality requires the normal API chain and human review.
    from collections import Counter
    from memoia_server.models.source import DeleteMessages

    fixture = Path(__file__).resolve().parents[4] / "docs/experiments/prompt-quality/cases.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]
    assert len({case["id"] for case in cases}) == 6
    assert Counter(case["split"] for case in cases) == {"development": 3, "holdout": 3}
    assert Counter(case["language"] for case in cases) == {"zh": 4, "en": 2}
    for case in cases:
        seen, deleted = set(), set()
        assert all(case[field] for field in ("must_preserve", "must_not", "acceptable_variations"))
        for index, step in enumerate(case["steps"]):
            identity = {"source_id": case["source_id"], "idempotency_key": f"{case['id']}-{index}"}
            if step["action"] == "import":
                body = ImportSource(**identity, messages=step["messages"])
                ids = {message.message_id for message in body.messages}
                assert len(ids) == len(body.messages) and not seen.intersection(ids)
                seen.update(ids)
            else:
                assert step["action"] == "delete"
                body = DeleteMessages(idempotency_key=identity["idempotency_key"], message_ids=step["message_ids"])
                assert set(body.message_ids) <= seen - deleted
                deleted.update(body.message_ids)


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
