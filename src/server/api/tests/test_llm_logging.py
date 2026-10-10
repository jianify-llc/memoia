"""Both supported logger implementations must preserve redacted failure semantics."""
import logging
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
from unittest.mock import AsyncMock

import httpx
from openai import AuthenticationError
import pytest
import structlog

from memoia_server import llms
from memoia_server.env import CONFIG
from memoia_server.llms import embeddings
from memoia_server.models.response import CODE


def test_standalone_api_debug_never_logs_model_body_before_loop_import(tmp_path):
    # A fresh process prevents pytest's AgentLoop imports from masking an API leak.
    child = textwrap.dedent("""
        import asyncio, io, logging, socket, sys
        def no_network(*args, **kwargs):
            raise AssertionError("External network is forbidden")
        socket.socket.connect = no_network
        import api
        assert "memoia_server.maintenance_agent" not in sys.modules
        import httpx
        from openai import AsyncOpenAI
        from memoia_server.llms import openai_model_llm
        marker = "SYNTHETIC_PRIVATE_MEMORY_BODY"
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logging.getLogger().addHandler(handler)
        requests = []
        def respond(request):
            requests.append(request)
            assert marker.encode() in request.content
            return httpx.Response(200, json={"id": "chatcmpl-local", "object": "chat.completion",
                "created": 0, "model": "gpt-6-luna", "choices": [{"index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": marker}}]})
        async def run():
            client = AsyncOpenAI(api_key="fixture-only", base_url="https://example.invalid/v1",
                max_retries=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
            openai_model_llm.get_openai_async_client_instance = lambda: client
            try:
                assert await openai_model_llm.openai_complete("gpt-6-luna", marker,
                    system_prompt=marker, cache_fixed_prompt=True) == marker
                assert len(requests) == 1
                assert marker not in output.getvalue()
            finally:
                await client.close()
        asyncio.run(run())
    """)
    result = subprocess.run([sys.executable, "-c", child], cwd=tmp_path,
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]),
             "TMPDIR": tempfile.gettempdir(),
             "PYTHON_DOTENV_DISABLED": "1", "OPENAI_LOG": "debug",
             "DATABASE_URL": "postgresql://fixture:fixture@127.0.0.1:1/offline",
             "REDIS_URL": "redis://127.0.0.1:1", "ACCESS_TOKEN": "fixture-only",
             "MEMOBASE_LLM_API_KEY": "fixture-only", "PROJECT_ID": "fixture-only"},
        capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert "SYNTHETIC_PRIVATE_MEMORY_BODY" not in result.stdout + result.stderr


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
    monkeypatch.setattr(llms, "openai_complete", AsyncMock(side_effect=ValueError(private)))
    result = await llms.llm_complete("__root__", "input")
    assert not result.ok() and result.code() == CODE.SERVICE_UNAVAILABLE
    assert result.msg().endswith("LLM completion failed") and private not in result.msg()
    assert len(error_logs) == 1 and "ValueError" in error_logs[0]
    assert private not in error_logs[0]


@pytest.mark.asyncio
async def test_accounting_failure_does_not_discard_completion_for_both_loggers(error_logs, monkeypatch):
    private = "private-database-connection-string"
    async def complete(*args, on_usage, **kwargs):
        await on_usage(10, 5, 1)
        return "OK"
    monkeypatch.setattr(llms, "openai_complete", complete)
    monkeypatch.setattr(llms, "project_cost_token_billing", AsyncMock(side_effect=RuntimeError(private)))
    result = await llms.llm_complete("__root__", "input")
    assert result.ok() and result.data() == "OK"
    assert len(error_logs) == 2 and "RuntimeError" in error_logs[0]
    assert "LLM usage:" in error_logs[1]
    assert all(private not in entry for entry in error_logs)


@pytest.mark.asyncio
@pytest.mark.parametrize("permanent", [False, True])
async def test_embedding_failure_is_rejected_and_redacted_for_both_loggers(error_logs, monkeypatch, permanent):
    private = "private-embedding-token-and-input"
    error = RuntimeError(private)
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
