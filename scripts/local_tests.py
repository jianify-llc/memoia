"""本地旧 SDK 使用真实 ASGI API 与确定的模型边界；缺依赖不能静默跳过。"""
import asyncio
from contextlib import ExitStack
import os
import socket
from urllib.parse import urlsplit
from unittest.mock import AsyncMock, patch

STACK = ExitStack()
CLIENTS = []


def pytest_sessionstart(session):
    allowed = {(urlsplit(os.environ[name]).hostname, urlsplit(os.environ[name]).port)
               for name in ("DATABASE_URL", "REDIS_URL")}
    original_connect = socket.socket.connect
    def connect(sock, address):
        if not isinstance(address, tuple) or address[:2] not in allowed:
            raise RuntimeError("LOCAL_CI_EXTERNAL_NETWORK_FORBIDDEN")
        return original_connect(sock, address)
    STACK.enter_context(patch.object(socket.socket, "connect", connect))
    if os.environ.get("MEMOIA_LOCAL_SDK_TESTS") != "1":
        return
    import httpx
    import numpy as np
    from fastapi.testclient import TestClient
    from api import app
    from memobase import MemoBaseClient, AsyncMemoBaseClient
    from memoia_server.env import CONFIG
    from memoia_server.models.utils import Promise

    CONFIG.profile_strict_mode = False
    CONFIG.minimum_chats_token_size_for_event_summary = 5
    CONFIG.enable_event_embedding = True
    CONFIG.persistent_chat_blobs = True
    responses = {
        "extract": "- basic_info::name::Gus",
        "merge_yolo": "1. UPDATE::Gus",
        "organize": "- name::Gus",
        "event_summary": "- emotion::happy",
        "entry_summary": "Gus introduced himself",
    }
    for name, response in responses.items():
        STACK.enter_context(patch("memoia_server.controllers.modal.chat." + name + ".llm_complete",
                                  AsyncMock(return_value=Promise.resolve(response))))

    async def embeddings(project_id, texts, **kwargs):
        return Promise.resolve(np.full((len(texts), CONFIG.embedding_dim), .1))

    STACK.enter_context(patch("memoia_server.controllers.event.get_embedding", embeddings))
    original_sync = MemoBaseClient.__post_init__
    original_async = AsyncMemoBaseClient.__post_init__

    def sync_client(client):
        original_sync(client)
        client._client.close()
        client._client = TestClient(app, base_url=client.base_url,
                                   headers={"Authorization": "Bearer " + client.api_key})
        CLIENTS.append(client._client)

    def async_client(client):
        original_async(client)
        CLIENTS.append(client._client)
        client._client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=client.base_url,
                                          headers={"Authorization": "Bearer " + client.api_key})
        CLIENTS.append(client._client)

    STACK.enter_context(patch.object(MemoBaseClient, "__post_init__", sync_client))
    STACK.enter_context(patch.object(AsyncMemoBaseClient, "__post_init__", async_client))


def pytest_sessionfinish(session, exitstatus):
    reporter = session.config.pluginmanager.getplugin("terminalreporter")
    if reporter and reporter.stats.get("skipped"):
        session.exitstatus = 1
        print("LOCAL_CI_SKIPPED_TESTS_FORBIDDEN")
    for client in CLIENTS:
        if hasattr(client, "aclose"):
            asyncio.run(client.aclose())
        else:
            client.close()
    CLIENTS.clear()
    STACK.close()
