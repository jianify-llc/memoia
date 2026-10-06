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


@pytest.mark.asyncio
@pytest.mark.parametrize("vectors", [[[1]], [[float("nan"), 1]]])
async def test_invalid_vector_contract_is_not_a_temporary_outage(monkeypatch, vectors):
    monkeypatch.setattr(CONFIG, "embedding_dim", 2)
    factory = AsyncMock(return_value=vectors)
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, factory)
    result = await embeddings.get_embedding("__root__", ["query"], phase="query")
    assert not result.ok() and result.code() == 422


@pytest.mark.asyncio
async def test_invalid_batch_configuration_rejects_before_io(monkeypatch):
    monkeypatch.setattr(CONFIG, "embedding_batch_size", 0)
    factory = AsyncMock()
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, factory)
    result = await embeddings.get_embedding("__root__", ["query"], phase="query")
    assert not result.ok() and result.code() == 422
    factory.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["jina", "lmstudio", "ollama"])
@pytest.mark.parametrize("status,expected", [(400, 422), (401, 422), (403, 422), (404, 422), (422, 422), (429, 503), (503, 503)])
async def test_http_embedding_provider_preserves_failure_category(monkeypatch, provider, status, expected):
    import httpx
    module = importlib.import_module(f"memoia_server.llms.embeddings.{provider}_embedding")
    client = SimpleNamespace(post=AsyncMock(return_value=httpx.Response(status, text="private upstream text")))
    monkeypatch.setattr(module, f"get_{provider}_async_client_instance", lambda: client)
    monkeypatch.setattr(CONFIG, "embedding_provider", provider)
    rejected = await embeddings.get_embedding("__root__", ["query"], phase="query")
    assert not rejected.ok() and rejected.code() == expected
    assert "private" not in rejected.msg()
    assert client.post.call_args.kwargs["timeout"] == 10
