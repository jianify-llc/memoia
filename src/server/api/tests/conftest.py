# Modified for Memoia: use the renamed internal server package.
import pytest
import pytest_asyncio
from api import app
from memoia_server.env import CONFIG
from fastapi.testclient import TestClient

PREFIX = "/api/v1"
CONFIG.profile_strict_mode = False
CONFIG.minimum_chats_token_size_for_event_summary = 5
CONFIG.event_tags = [
    {"name": "emotion", "description": "Record the current emotion of user"},
    {"name": "goal", "description": "Record the current goal of user"},
]
CONFIG.enable_event_embedding = True
CONFIG.persistent_chat_blobs = True
CONFIG.llm_api_key = None
# @pytest.fixture(scope="session")
# def event_loop():
#     try:
#         loop = asyncio.get_running_loop()
#     except RuntimeError:
#         loop = asyncio.new_event_loop()
#     yield loop
#     loop.close()


@pytest_asyncio.fixture(scope="function")
async def db_env():
    client = TestClient(app)
    response = client.get(f"{PREFIX}/healthcheck")
    d = response.json()
    if response.status_code == 200 and d["errno"] == 0:
        yield
    else:
        pytest.fail("Database not available: integration tests must not silently skip")


@pytest.fixture
def bounded_source_model(monkeypatch):
    """Mock the current extraction contract, not the retired text-parser call graph."""
    from uuid import uuid4
    from unittest.mock import AsyncMock
    import numpy as np
    from memoia_server.controllers import source
    from memoia_server.models.utils import Promise

    async def extract(body, **kwargs):
        message = next(m for m in body.messages if m.role == "user")
        return source.ExtractedSource([{"id": uuid4(), "content": "Gus", "topic": "basic_info", "sub_topic": "name",
                 "support_groups": [[message.message_id]], "occurred_at": message.occurred_at}], [{"tag": "emotion", "value": "happy"}])

    async def reconcile(facts, **kwargs):
        return source.Reconciliation(decisions=[source.FactDecision(fact_id=f["id"], include=True) for f in facts],
            profiles=[source.DerivedProfile(content=f["content"], topic=f["topic"], sub_topic=f["sub_topic"], fact_ids=[f["id"]]) for f in facts])

    async def embedding(_, texts, **kwargs):
        return Promise.resolve(np.full((len(texts), CONFIG.embedding_dim), .1))

    extraction = AsyncMock(side_effect=extract)
    monkeypatch.setattr(source, "extract_source", extraction)
    monkeypatch.setattr(source, "reconcile_facts", AsyncMock(side_effect=reconcile))
    monkeypatch.setattr(source, "get_embedding", AsyncMock(side_effect=embedding))
    return extraction


@pytest.fixture
def four_fact_source_model(bounded_source_model):
    from uuid import uuid4
    from memoia_server.controllers import source
    async def extract(body, **kwargs):
        message = next(m for m in body.messages if m.role == "user")
        return source.ExtractedSource([{"id": uuid4(), "content": content, "topic": topic, "sub_topic": sub,
                 "support_groups": [[message.message_id]], "occurred_at": message.occurred_at}
                for topic, sub, content in [("basic_info", "name", "Gus"), ("interest", "foods", "Chinese food"),
                                           ("education", "level", "High School"), ("psychological", "emotional_state", "Feels bored with high school")]], [])
    bounded_source_model.side_effect = extract
    return bounded_source_model
