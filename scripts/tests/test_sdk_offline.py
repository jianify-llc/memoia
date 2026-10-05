"""旧 Python SDK 的固定离线序列化、认证和错误回归，不加载 API conftest。"""
import unittest
from uuid import uuid4
import httpx
from pydantic import ValidationError
from memobase import MemoBaseClient
from memobase.core.blob import ChatBlob, DocBlob, BlobType
from memobase.error import ServerError


class OfflineSDK(unittest.TestCase):
    def test_chat_serialization_preserves_messages_and_fields(self):
        request = ChatBlob(messages=[{"role": "user", "content": "fixture"}], fields={"source": "local"}).to_request()
        self.assertEqual(request["blob_type"], BlobType.chat)
        self.assertEqual(request["blob_data"]["messages"][0]["content"], "fixture")
        self.assertEqual(request["fields"], {"source": "local"})

    def test_document_serialization(self):
        self.assertEqual(DocBlob(content="fixture").to_request()["blob_data"], {"content": "fixture"})

    def test_invalid_message_role_is_rejected(self):
        with self.assertRaises(ValidationError):
            ChatBlob(messages=[{"role": "system", "content": "fixture"}])

    def client(self, transport):
        client = MemoBaseClient(project_url="https://fixture.invalid", api_key="fixture-only")
        client.client.close()
        client._client = httpx.Client(base_url=client.base_url,
                                     headers={"Authorization": "Bearer fixture-only"}, transport=transport)
        self.addCleanup(client.client.close)
        return client

    def test_create_user_uses_auth_and_parses_actual_sdk_envelope(self):
        uid = str(uuid4())
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"errno": 0, "errmsg": "", "data": {"id": uid}})
        client = self.client(httpx.MockTransport(respond))
        self.assertEqual(client.add_user(), uid)
        self.assertEqual(requests[0].headers["Authorization"], "Bearer fixture-only")
        self.assertEqual(requests[0].url.path, "/api/v1/users")

    def test_server_error_is_not_success(self):
        client = self.client(httpx.MockTransport(lambda request: httpx.Response(200, json={"errno": 503, "errmsg": "fixture", "data": None})))
        with self.assertRaises(ServerError):
            client.add_user()

    def test_http_error_is_not_success(self):
        client = self.client(httpx.MockTransport(lambda request: httpx.Response(401)))
        with self.assertRaises(httpx.HTTPStatusError):
            client.add_user()
