"""Both supported logger implementations must preserve redacted failure semantics."""
import logging
from unittest.mock import AsyncMock

import httpx
from openai import AuthenticationError
import pytest
import structlog

from memoia_server import llms
from memoia_server.env import CONFIG
from memoia_server.llms import embeddings
from memoia_server.models.response import CODE


@pytest.fixture(params=["plain", "json"])
def error_logs(request, monkeypatch):
    messages = []

    class Capture(logging.Handler):
        def emit(self, record):
            messages.append(record.getMessage())

    logger = logging.Logger("llm-error-contract", level=logging.INFO)
    logger.addHandler(Capture())
    if request.param == "json":
        logger = structlog.wrap_logger(
            logger,
            processors=[structlog.stdlib.PositionalArgumentsFormatter(), structlog.processors.JSONRenderer()],
            wrapper_class=structlog.stdlib.BoundLogger,
        )
    monkeypatch.setattr(llms, "LOG", logger)
    monkeypatch.setattr(embeddings, "LOG", logger)
    return messages


@pytest.mark.asyncio
async def test_completion_failure_is_rejected_and_redacted_for_both_loggers(error_logs, monkeypatch):
    private = "private-provider-token-and-prompt"
    monkeypatch.setitem(llms.FACTORIES, CONFIG.llm_style, AsyncMock(side_effect=ValueError(private)))
    result = await llms.llm_complete("__root__", "input")
    assert not result.ok() and result.code() == CODE.SERVICE_UNAVAILABLE
    assert result.msg().endswith("LLM completion failed") and private not in result.msg()
    assert len(error_logs) == 1 and "ValueError" in error_logs[0]
    assert private not in error_logs[0]


@pytest.mark.asyncio
async def test_accounting_failure_does_not_discard_completion_for_both_loggers(error_logs, monkeypatch):
    private = "private-database-connection-string"
    monkeypatch.setitem(llms.FACTORIES, CONFIG.llm_style, AsyncMock(return_value="OK"))
    monkeypatch.setattr(llms, "project_cost_token_billing", AsyncMock(side_effect=RuntimeError(private)))
    result = await llms.llm_complete("__root__", "input")
    assert result.ok() and result.data() == "OK"
    assert len(error_logs) == 1 and "RuntimeError" in error_logs[0]
    assert private not in error_logs[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("permanent", [False, True])
async def test_embedding_failure_is_rejected_and_redacted_for_both_loggers(error_logs, monkeypatch, permanent):
    private = "private-embedding-token-and-input"
    error = ValueError(private)
    expected = CODE.SERVICE_UNAVAILABLE
    if permanent:
        response = httpx.Response(401, request=httpx.Request("POST", "https://example.invalid/embeddings"))
        error = AuthenticationError(private, response=response, body={"message": private})
        expected = CODE.UNPROCESSABLE_ENTITY
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, AsyncMock(side_effect=error))
    result = await embeddings.get_embedding("__root__", ["input"])
    assert not result.ok() and result.code() == expected
    assert len(error_logs) == 1 and type(error).__name__ in error_logs[0]
    assert private not in error_logs[0] and private not in result.msg()
