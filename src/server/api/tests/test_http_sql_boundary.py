"""HTTP SQL runs as complete thread-local sessions, including auth and receipts."""
import asyncio
import os
import threading
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, select, event as sql_event

from memoia_server.api_layer.middleware import AuthMiddleware
from memoia_server.connectors import DB_ENGINE, Session
from memoia_server.controllers import billing, event, profile
from memoia_server.models.database import Billing, Project, ProjectBilling, UserProfile
from tests.test_search_bundle import search_users, seed_facts, seed_derived


@pytest.mark.asyncio
async def test_event_list_hydrates_current_evidence_in_one_batch(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel"])
    for _ in range(5):
        seed_derived(uid, ids)
    statements = []
    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    sql_event.listen(DB_ENGINE, "before_cursor_execute", record)
    try:
        result = await event.get_user_events(uid, "__root__", topk=10)
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", record)
    assert result.ok() and len(result.data().events) == 5
    assert len(statements) == 3  # Events, current Facts, message evidence; not per Event.


@pytest.mark.asyncio
async def test_unlinked_profiles_do_not_scan_user_fact_history(search_users):
    uid, _, _, _ = search_users
    seed_facts(uid, ["Unrelated historical fact"] * 30)
    with Session.begin() as session:
        session.add(UserProfile(user_id=uid, project_id="__root__", content="Manual profile",
            attributes={"topic": "basic_info", "sub_topic": "name"}))
    statements = []
    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    sql_event.listen(DB_ENGINE, "before_cursor_execute", record)
    try:
        result = await profile.get_user_profiles(uid, "__root__")
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", record)
    assert result.ok() and len(result.data().profiles) == 1
    assert len(statements) == 1 and "memory_facts" not in statements[0]


@pytest.mark.asyncio
async def test_http_management_auth_query_and_receipts_never_execute_sql_on_loop(db_env, monkeypatch):
    from memoia_server.env import CONFIG
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    main_thread = threading.get_ident()
    executions = []
    def record(conn, cursor, statement, parameters, context, executemany):
        executions.append((threading.get_ident(), statement))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app),
        base_url="http://test", headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]})
    project_id = "thread-boundary-" + uuid4().hex
    sql_event.listen(DB_ENGINE, "before_cursor_execute", record)
    try:
        assert (await client.get("/api/healthcheck")).status_code == 200
        assert (await client.post("/api/projects", json={"project_id": project_id})).status_code == 201
        assert (await client.get("/api/projects")).status_code == 200
        token = (await client.post(f"/api/projects/{project_id}/legacy-token/rotate")).json()["token"]
        client.headers["Authorization"] = "Bearer " + token
        executions.clear()
        assert (await client.get("/api/project/identity")).status_code == 200
        assert len(executions) == 1  # Legacy secret and status share one fresh read.
        created = await client.post("/api/users", json={})
        assert created.status_code == 201
        uid = created.json()["id"]
        assert (await client.get(f"/api/users/{uid}")).status_code == 200
        assert (await client.get("/api/users")).status_code == 200
        profile_id = (await client.post(f"/api/users/{uid}/profiles", json={
            "content": "Manual", "topic": "basic_info", "sub_topic": "name"})).json()["id"]
        for suffix in ["profiles", "events", "sources", "history", "maintenance", "operations"]:
            assert (await client.get(f"/api/users/{uid}/{suffix}")).status_code == 200
        for kind in ["facts", "events", "profiles"]:
            assert (await client.post(f"/api/users/{uid}/{kind}/query", json={})).status_code == 200
        assert (await client.post(f"/api/users/{uid}/context", json={})).status_code == 200
        assert (await client.post(f"/api/users/{uid}/search", json={"query": "Manual"})).status_code == 200
        receipt = (await client.post(f"/api/users/{uid}/flush", json={"idempotency_key": "thread-test"})).json()
        assert (await client.get(f"/api/users/{uid}/operations/{receipt['operation_id']}")).status_code == 200
        assert (await client.get(f"/api/users/{uid}/operations/by-key/thread-test")).status_code == 200
        assert (await client.get("/api/project/config")).status_code == 200
        assert (await client.get(f"/api/projects/{project_id}/keys")).status_code == 200
        key = (await client.post(f"/api/projects/{project_id}/keys", json={"name": "reader", "scopes": ["read"]})).json()
        client.headers["Authorization"] = "Bearer " + key["token"]
        assert (await client.get("/api/project/identity")).status_code == 200
        client.headers["Authorization"] = "Bearer " + token
        assert (await client.delete(f"/api/projects/{project_id}/keys/{key['key_id']}")).status_code == 204
        assert (await client.delete(f"/api/users/{uid}/profiles/{profile_id}")).status_code == 204
        assert (await client.delete(f"/api/users/{uid}")).status_code == 200
        assert executions and all(thread != main_thread for thread, _ in executions)
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", record)
        await client.aclose()
        with Session.begin() as session:
            session.execute(delete(Project).where(Project.project_id == project_id))


@pytest.mark.asyncio
async def test_operation_lookup_key_is_redacted_from_metrics_and_access_logs(search_users):
    uid, _, _, client = search_users
    secret = "business-operation-private-key"
    path = f"/api/users/{uid}/operations/by-key/{secret}"
    assert AuthMiddleware(None).normalize_path(path) == "/api/users/{id}/operations/by-key/{id}"
    with patch("memoia_server.api_layer.middleware.LOG.error") as log:
        assert (await client.get(path)).status_code == 404
        assert secret not in str(log.call_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("has_billing", [True, False])
async def test_billing_sql_is_off_loop_and_never_holds_session_while_reading_counters(search_users, monkeypatch, has_billing):
    _, _, pid, _ = search_users
    if has_billing:
        with Session.begin() as session:
            row = Billing(usage_left=100)
            session.add(row)
            session.flush()
            session.add(ProjectBilling(project_id=pid, billing_id=row.id))
    monkeypatch.setattr(billing, "ADMIN_URL", None)
    reads = []
    async def counter(name, project_id, **kwargs):
        assert DB_ENGINE.pool.checkedout() == 0
        assert project_id == pid
        reads.append(name)
        return 7 if len(reads) == 1 else 3
    monkeypatch.setattr(billing, "get_int_key", counter)
    monkeypatch.setattr(billing, "capture_int_keys", AsyncMock(return_value=True))
    main_thread, executed = threading.get_ident(), []
    def record(*_):
        executed.append(threading.get_ident())
    sql_event.listen(DB_ENGINE, "before_cursor_execute", record)
    try:
        result = await billing.get_project_billing(pid)
        assert result.ok() and result.data().project_token_cost_month == 10
        assert len(reads) == 2  # Missing billing reuses these counters for its fallback.
        if has_billing:
            assert result.data().token_left == 100
            assert (await billing.project_cost_token_billing(pid, 7, 3)).ok()
        assert executed and all(thread != main_thread for thread in executed)
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", record)
    if has_billing:
        with Session() as session:
            assert session.query(ProjectBilling).filter_by(project_id=pid).one().billing.usage_left == 90


@pytest.mark.asyncio
@pytest.mark.parametrize("balance, expected", [(100, 80), (None, None)])
async def test_concurrent_billing_debits_are_atomic(search_users, monkeypatch, balance, expected):
    _, _, pid, _ = search_users
    with Session.begin() as session:
        row = Billing(usage_left=balance)
        session.add(row)
        session.flush()
        billing_id = row.id
        session.add(ProjectBilling(project_id=pid, billing_id=billing_id))
    monkeypatch.setattr(billing, "ADMIN_URL", None)
    monkeypatch.setattr(billing, "capture_int_keys", AsyncMock(return_value=True))
    ready = threading.Barrier(2)

    def simultaneous_updates(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("UPDATE billings"):
            ready.wait(timeout=2)

    sql_event.listen(DB_ENGINE, "before_cursor_execute", simultaneous_updates)
    try:
        results = await asyncio.gather(
            billing.project_cost_token_billing(pid, 7, 3),
            billing.project_cost_token_billing(pid, 7, 3),
        )
        assert all(result.ok() for result in results)
        with Session() as session:
            assert session.scalar(select(Billing.usage_left).where(Billing.id == billing_id)) == expected
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", simultaneous_updates)
        with Session.begin() as session:
            session.execute(delete(Billing).where(Billing.id == billing_id))


@pytest.mark.asyncio
async def test_delayed_refill_cannot_overwrite_debit_after_another_refill(search_users, monkeypatch):
    _, _, pid, _ = search_users
    with Session.begin() as session:
        row = Billing(usage_left=10, next_refill_at=datetime.now(timezone.utc) - timedelta(days=1))
        session.add(row)
        session.flush()
        billing_id = row.id
        session.add(ProjectBilling(project_id=pid, billing_id=billing_id))
    monkeypatch.setattr(billing, "ADMIN_URL", None)
    monkeypatch.setitem(billing.BILLING_REFILL_AMOUNT_MAP, billing.BillingStatus.free, 100)
    monkeypatch.setattr(billing, "get_int_key", AsyncMock(return_value=0))
    monkeypatch.setattr(billing, "capture_int_keys", AsyncMock(return_value=True))
    entered, release = threading.Event(), threading.Event()

    def delay_first_refill(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("UPDATE billings") and "next_refill_at" in statement and not entered.is_set():
            entered.set()
            assert release.wait(timeout=3), "Test did not release delayed refill"

    sql_event.listen(DB_ENGINE, "before_cursor_execute", delay_first_refill)
    pending = asyncio.create_task(billing.get_project_billing(pid))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await billing.get_project_billing(pid)).data().token_left == 100
        assert (await billing.project_cost_token_billing(pid, 7, 3)).ok()
        release.set()
        result = await pending
        assert result.ok() and result.data().token_left == 90
        assert result.data().next_refill_at > datetime.now(timezone.utc)
        with Session() as session:
            assert session.scalar(select(Billing.usage_left).where(Billing.id == billing_id)) == 90
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
        sql_event.remove(DB_ENGINE, "before_cursor_execute", delay_first_refill)
        with Session.begin() as session:
            session.execute(delete(Billing).where(Billing.id == billing_id))
