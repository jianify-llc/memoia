"""Embedding transport never accepts partial, misindexed or malformed vectors."""
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest
from memoia_server.env import CONFIG
from memoia_server.llms import embeddings

transport = importlib.import_module("memoia_server.llms.embeddings.openai_embedding")


@pytest.mark.asyncio
@pytest.mark.parametrize("rows", [
    [(0, [1, 2])], [(0, [1, 2]), (0, [1, 2])], [(1, [1, 2]), (2, [1, 2])],
    [(0, [1]), (1, [1, 2])], [(0, [float('nan'), 2]), (1, [1, 2])],
    [(0, [float('inf'), 2]), (1, [1, 2])],
])
async def test_openai_rejects_invalid_response(monkeypatch, rows):
    monkeypatch.setattr(CONFIG, "embedding_dim", 2)
    response = SimpleNamespace(data=[SimpleNamespace(index=index, embedding=vector) for index, vector in rows], usage=SimpleNamespace())
    client = SimpleNamespace(embeddings=SimpleNamespace(create=AsyncMock(return_value=response)))
    monkeypatch.setattr(transport, "get_openai_async_client_instance", lambda: client)
    with pytest.raises(ValueError):
        await transport.openai_embedding("embedding-model", ["first", "second"])


@pytest.mark.asyncio
async def test_openai_restores_index_order(monkeypatch):
    monkeypatch.setattr(CONFIG, "embedding_dim", 2)
    response = SimpleNamespace(data=[SimpleNamespace(index=1, embedding=[3, 4]), SimpleNamespace(index=0, embedding=[1, 2])], usage=SimpleNamespace())
    client = SimpleNamespace(embeddings=SimpleNamespace(create=AsyncMock(return_value=response)))
    monkeypatch.setattr(transport, "get_openai_async_client_instance", lambda: client)
    assert (await transport.openai_embedding("model", ["a", "b"])).tolist() == [[1, 2], [3, 4]]


@pytest.mark.asyncio
async def test_batched_embedding_is_complete_and_oversized_text_not_truncated(monkeypatch):
    monkeypatch.setattr(CONFIG, "embedding_dim", 2)
    monkeypatch.setattr(CONFIG, "embedding_batch_size", 2)
    factory = AsyncMock(side_effect=lambda model, batch, phase: np.full((len(batch), 2), len(batch)))
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, factory)
    result = await embeddings.get_embedding("__root__", ["a", "b", "c", "d", "e"])
    assert result.ok() and result.data().shape == (5, 2) and factory.await_count == 3
    monkeypatch.setattr(CONFIG, "embedding_max_token_size", 1)
    rejected = await embeddings.get_embedding("__root__", ["many distinct words exceed a single token"])
    assert not rejected.ok() and rejected.code() == 400 and factory.await_count == 3
