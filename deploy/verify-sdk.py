"""真实 SDK 业务验收；token 从 stdin 读取，未知写入保留 receipt，绝不自动重放。"""
import json
import os
from pathlib import Path
import sys
import time
import tempfile
from uuid import UUID, uuid4
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/client"))
from memobase import ChatBlob, MemoBaseClient  # noqa: E402
from memobase.network import unpack_response  # noqa: E402


def ids(results):
    if not isinstance(results, list) or not results:
        raise ValueError("Missing synchronous completion results")
    result = []
    for item in results:
        if not isinstance(item, dict) or "event_id" not in item:
            raise ValueError("Invalid synchronous completion result")
        event_id = item["event_id"]
        if event_id is not None:
            event_id = str(UUID(event_id))
            if event_id not in result:
                result.append(event_id)
    return result


def main():
    operation, origin, receipt_name = sys.argv[1:]
    if not origin.startswith("https://") or origin.rstrip("/") != origin:
        raise ValueError("Use an HTTPS origin, without API suffix")
    os.umask(0o077)
    receipt_file = Path(receipt_name)
    token = sys.stdin.read().strip()
    if not token:
        raise ValueError("No protected test Bearer credential")
    client = MemoBaseClient(api_key=token, project_url=origin)
    if operation == "verify-auth":
        for headers in ({}, {"Authorization": "Bearer deliberately-invalid"}):
            response = httpx.post(origin + "/api/v1/users", headers=headers, json={}, timeout=20)
            if response.status_code != 401:
                raise ValueError("Missing or incorrect Bearer was not rejected")
        if not client.ping():
            raise ValueError("Health check failed")
        print("Bearer negative checks and public health passed")
        return
    if operation in ("create", "no-event"):
        if receipt_file.exists():
            raise ValueError("Existing receipt cannot be replayed")
        receipt = {"user_id": str(uuid4()), "origin": origin, "event_ids": [], "status": "pending-create"}
    else:
        receipt = json.loads(receipt_file.read_text())
        cleanup_statuses = ("accepted", "completed-greeting", "reconciled")
        permitted = receipt["status"] == "accepted" or operation == "inspect" or (operation == "cleanup" and receipt["status"] in cleanup_statuses)
        if receipt["origin"] != origin or not permitted:
            raise ValueError("Unknown execution or mismatched origin requires manual review")

    def save(status):
        receipt["status"] = status
        # 原子替换，避免中断时截断上一次已知 ID；receipt 是验证工具的唯一执行记录。
        with tempfile.NamedTemporaryFile(mode="w", dir=receipt_file.parent, prefix=".sdk-receipt-", delete=False) as file:
            json.dump(receipt, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
            temporary = file.name
        os.replace(temporary, receipt_file)

    if operation == "inspect":
        user = client.get_user(receipt["user_id"])
        print(json.dumps({"user_id": user.user_id, "receipt_status": receipt["status"],
                          "event_ids": [str(event.id) for event in user.event(topk=100)],
                          "buffers": {status: user.buffer("chat", status=status)
                                      for status in ("idle", "processing", "failed", "done")}}))
        return

    if operation == "no-event":
        save("pending-create")
        client.add_user(id=receipt["user_id"], data={"memoia_sdk_probe": True})
        save("pending-insert")
        blob = ChatBlob(messages=[{"role": "user", "content": "Hello!"}])
        inserted = unpack_response(client.client.post(f"/blobs/insert/{receipt['user_id']}?wait_process=true",
                                                     json=blob.to_request(), timeout=90)).data
        if not isinstance(inserted, dict) or inserted.get("chat_results") != []:
            raise ValueError("Greeting insert did not follow the small-buffer contract")
        save("pending-flush")
        results = unpack_response(client.client.post(f"/users/buffer/{receipt['user_id']}/chat?wait_process=true", timeout=90)).data
        receipt["completion_results"] = results
        save("response-received-greeting")
        receipt["event_ids"] = ids(results)
        save("completed-greeting")
        if receipt["event_ids"]:
            raise ValueError("Greeting unexpectedly produced an event")
        save("pending-delete")
        user = client.get_user(receipt["user_id"])
        if user.event():
            raise ValueError("No-event greeting has queryable events")
        client.delete_user(user.user_id)
        response = client.client.get(f"/users/{user.user_id}")
        if response.status_code != 404 and response.json().get("errno") != 404:
            raise ValueError("Deleted greeting user is still queryable")
        save("deleted")
        print("Legal synchronous event_id:null and SDK account deletion passed")
        return

    if operation == "cleanup":
        user = client.get_user(receipt["user_id"])
        if not user.fields.get("data", {}).get("memoia_sdk_probe"):
            raise ValueError("Refusing cleanup of an unowned user")
        known_events = {str(event.id) for event in user.event(topk=100)}
        if not set(receipt["event_ids"]).issubset(known_events):
            raise ValueError("Tracked event identity changed; inspect before cleanup")
        save("pending-delete")
        for event_id in receipt["event_ids"]:
            user.delete_event(event_id)
        if {str(event.id) for event in user.event(topk=100)} & set(receipt["event_ids"]):
            raise ValueError("Deleted events remain queryable")
        client.delete_user(user.user_id)
        response = client.client.get(f"/users/{user.user_id}")
        if response.status_code != 404 and response.json().get("errno") != 404:
            raise ValueError("Deleted user is still queryable")
        save("deleted")
        print(json.dumps({"operation": "cleanup", "user_id": user.user_id, "deleted_event_ids": receipt["event_ids"]}))
        return

    if operation == "create":
        save("pending-create")
        client.add_user(id=receipt["user_id"], data={"memoia_sdk_probe": True})
        user = client.get_user(receipt["user_id"])
        # 小批量在 256~1024 token 之间，足以生成事件，尚未达到自动处理阈值。
        detail = (
            "I am a fictional verification user named Avery. I live in Tokyo and work as a software engineer. "
            "This week I joined a beginner Japanese class that meets every Tuesday and Thursday evening. "
            "I prefer quiet libraries to crowded cafes when studying, and I plan to practice reading for thirty minutes after dinner. "
            "I enjoy cycling along the river on weekends and preparing vegetarian meals at home. "
            "Today I visited the local library, borrowed a book about Japanese cooking, and planned a cycling trip with my friend Morgan. "
            "My long term goal is to read simple Japanese novels independently, and my current concern is making time for lessons while working full time. "
            "I have scheduled practice sessions in my calendar, and I intend to review new vocabulary every morning before work. "
        )
        for label, text in (("small", detail * 2), ("large", detail * 12)):
            blob = ChatBlob(messages=[{"role": "user", "content": text},
                                     {"role": "assistant", "content": "Your class and library plans sound clear. Keep your study schedule manageable."}])
            save("pending-insert-" + label)
            started = time.monotonic()
            inserted = unpack_response(client.client.post(f"/blobs/insert/{user.user_id}?wait_process=true",
                                                         json=blob.to_request(), timeout=90)).data
            if not isinstance(inserted, dict) or not isinstance(inserted.get("chat_results"), list):
                raise ValueError("Invalid insert response")
            receipt[label + "_blob_id"] = str(UUID(inserted["id"]))
            results = inserted["chat_results"]
            receipt[label + "_automatic"] = bool(results)
            save("insert-confirmed-" + label)
            if not results:
                save("pending-flush-" + label)
                results = unpack_response(client.client.post(f"/users/buffer/{user.user_id}/chat?wait_process=true", timeout=90)).data
            receipt[label + "_completion_results"] = results
            save("response-received-" + label)
            for event_id in ids(results):
                if event_id not in receipt["event_ids"]:
                    receipt["event_ids"].append(event_id)
            receipt[label + "_seconds"] = round(time.monotonic() - started, 2)
            save("completed-" + label)
        if receipt["small_automatic"] or not receipt["large_automatic"] or not receipt["event_ids"]:
            raise ValueError("Small flush/large automatic processing acceptance failed")
        save("accepted")
    user = client.get_user(receipt["user_id"])
    events = user.event(topk=100, need_summary=True)
    event_ids = {str(event.id) for event in events}
    if not set(receipt["event_ids"]).issubset(event_ids):
        raise ValueError("Final event IDs were not found in queries")
    profiles = user.profile(max_token_size=10000)
    if not profiles:
        raise ValueError("Profile extraction did not produce data")
    # 搜索触发真实 query embedding，不能只用启动探针代替向量业务验证。
    search = user.search_event("Japanese classes and library reading", similarity_threshold=0)
    if not search:
        raise ValueError("Embedding search returned no probe events")
    if operation not in ("create", "verify"):
        raise ValueError("Unknown verification operation")
    print(json.dumps({"operation": operation, "user_id": receipt["user_id"], "event_ids": receipt["event_ids"],
                      "profiles": len(profiles), "search_results": len(search),
                      "small_seconds": receipt.get("small_seconds"), "large_seconds": receipt.get("large_seconds")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"SDK acceptance stopped ({type(error).__name__}); inspect the protected receipt, do not replay writes.", file=sys.stderr)
        sys.exit(1)
