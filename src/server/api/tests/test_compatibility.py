"""Memoia compatibility contracts; integration tests require disposable DB/Redis."""

import os
from pathlib import Path

from api import app
from fastapi.testclient import TestClient
from memoia_server.connectors import PROJECT_ID
from memoia_server.env import Config
from memoia_server.controllers.buffer_background import (
    get_user_buffer_queue_key,
    get_user_lock_key,
)
from memoia_server.telemetry.open_telemetry import (
    CounterMetricName,
    GaugeMetricName,
    HistogramMetricName,
)


def test_image_license_matches_preserved_upstream_license():
    repository = Path(__file__).resolve().parents[4]
    assert (repository / "LICENSE").read_bytes().rstrip() == (
        repository / "src/server/api/LICENSE"
    ).read_bytes().rstrip()


def test_model_configuration_log_omits_keys(monkeypatch):
    messages = []

    class CaptureLog:
        def info(self, message):
            messages.append(str(message))

        def warning(self, message):
            messages.append(str(message))

    monkeypatch.setattr("memoia_server.env.LOG", CaptureLog())
    monkeypatch.setenv("MEMOBASE_LLM_API_KEY", "test-private-model-key")
    monkeypatch.setenv("MEMOBASE_EMBEDDING_API_KEY", "test-private-embedding-key")
    config = Config.load_config()
    assert config.llm_api_key == "test-private-model-key"
    assert config.embedding_api_key == "test-private-embedding-key"
    assert all("test-private" not in message for message in messages)


def test_persistent_and_monitoring_names_remain_upstream_compatible():
    scope = "flush_buffer_background_chat"
    suffix = f"{PROJECT_ID}:{scope}:project:user"
    assert get_user_lock_key("user", "project", scope) == f"memobase:user_lock:{suffix}"
    assert (
        get_user_buffer_queue_key("user", "project", scope)
        == f"memobase:user_buffer_queue:{suffix}"
    )
    assert CounterMetricName.REQUEST.get_metric_name() == "memobase_server_requests_total"
    assert (
        HistogramMetricName.REQUEST_LATENCY_MS.get_metric_name()
        == "memobase_server_request_latency"
    )
    assert (
        GaugeMetricName.INPUT_TOKEN_COUNT.get_metric_name()
        == "memobase_server_input_token_count_per_call"
    )


def test_bearer_auth_and_response_envelope_are_unchanged(db_env):
    client = TestClient(app)
    health = client.get("/api/v1/healthcheck")
    assert health.status_code == 200
    assert health.json()["errno"] == 0
    assert {"errno", "errmsg", "data"}.issubset(health.json())
    for headers in (
        {},
        {"Authorization": "Basic invalid"},
        {"Authorization": "Bearer invalid"},
    ):
        denied = client.post("/api/v1/users", json={}, headers=headers)
        assert denied.status_code == 401
        assert denied.json()["errno"] == 401
        assert {"errno", "errmsg", "data"}.issubset(denied.json())


def test_existing_python_sdk_uses_renamed_server_without_changes(db_env, monkeypatch):
    # Only the network transport is local; SDK serialization/parsing and API handlers are real.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3] / "client"))
    from memobase import MemoBaseClient

    sdk = MemoBaseClient(
        project_url="http://testserver", api_key=os.environ["ACCESS_TOKEN"]
    )
    sdk.client.close()
    sdk._client = TestClient(
        app,
        base_url=sdk.base_url,
        headers={"Authorization": f"Bearer {sdk.api_key}"},
    )
    user_id = None
    try:
        assert sdk.ping()
        user_id = sdk.add_user(data={"compatibility": "memoia"})
        user = sdk.get_user(user_id)
        assert user.user_id == user_id
        profile_id = user.add_profile("Memoia", "basic_info", "name")
        assert any(profile.content == "Memoia" for profile in user.profile())
        assert "Memoia" in user.context()
        assert user.event() == []
        assert user.flush(sync=True)
        assert user.delete_profile(profile_id)
        assert user.profile() == []
    finally:
        if user_id is not None:
            assert sdk.delete_user(user_id)
        sdk.client.close()


def test_empty_buffer_is_distinct_from_background_acknowledgement(db_env):
    client = TestClient(
        app, headers={"Authorization": f"Bearer {os.environ['ACCESS_TOKEN']}"}
    )
    user_id = client.post("/api/v1/users", json={}).json()["data"]["id"]
    try:
        for wait_process in ("true", "false"):
            result = client.post(
                f"/api/v1/users/buffer/{user_id}/chat?wait_process={wait_process}"
            )
            assert result.status_code == 200
            assert result.json()["errno"] == 0
            assert result.json()["data"] == []
    finally:
        assert client.delete(f"/api/v1/users/{user_id}").json()["errno"] == 0
        client.close()
