"""Correction proof invariants at the real PostgreSQL transaction boundary."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from memoia_server.connectors import Session
from memoia_server.controllers import source
from memoia_server.models.database import User
from memoia_server.models.source import (
    DeleteMessages, memory_blobs, memory_fact_corrections, memory_facts,
    memory_messages, memory_operations, memory_sources,
)
from tests.test_source_groups import body, models, uid


@pytest.fixture
def correction(db_env):
    user_id, origin_id, target_id = uuid4(), uuid4(), uuid4()
    origin_blob, target_blob = uuid4(), uuid4()
    recorded = datetime(2026, 1, 1, tzinfo=timezone.utc)
    owner = {"user_id": user_id, "project_id": "__root__"}
    with Session.begin() as session:
        session.execute(insert(User.__table__).values(id=user_id, project_id="__root__", additional_fields={}))
        session.execute(insert(memory_sources), [{**owner, "source_id": value} for value in ["origin", "older"]])
        session.execute(insert(memory_messages), [{**owner, "source_id": "origin", "message_id": mid,
            "role": "assistant" if mid == "assistant" else "user", "content_hash": "x",
            "occurred_at": recorded, "deleted": mid == "deleted"}
            for mid in ["m1", "m2", "m3", "assistant", "spare", "deleted"]])
        session.execute(insert(memory_messages), [{**owner, "source_id": "older", "message_id": mid,
            "role": "user", "content_hash": "x", "occurred_at": recorded} for mid in ["old", "foreign"]])
        session.execute(insert(memory_blobs), [
            {**owner, "id": origin_blob, "source_id": "origin", "status": "active",
             "message_ids": ["m1", "m2", "m3", "assistant", "spare", "deleted"]},
            {**owner, "id": target_blob, "source_id": "older", "status": "active", "message_ids": ["old", "foreign"]},
        ])
        session.execute(insert(memory_facts), [
            {**owner, "id": origin_id, "blob_id": origin_blob, "content": "Current assertion",
             "occurred_at": recorded, "support_groups": [["m1", "assistant"], ["m2"], ["m3"]]},
            {**owner, "id": target_id, "blob_id": target_blob, "content": "Previous assertion",
             "occurred_at": recorded, "support_groups": [["old"]]},
        ])
    yield {**owner, "fact_id": origin_id, "corrected_fact_id": target_id}
    with Session.begin() as session:
        session.execute(delete(User).where(User.id == user_id, User.project_id == "__root__"))


def assert_check_violation(error):
    assert error.value.orig.pgcode == "23514"


@pytest.mark.parametrize("groups", [
    None, {}, "invalid", [], [[]], [None], [[1]], [[""]],
    [["m1", "m1"]], [["m1"], ["m1"]], [["m1", "m2"], ["m2", "m1"]],
    [["unknown"]], [["foreign"]], [["spare"]], [["deleted"]], [["assistant"]],
])
def test_database_rejects_invalid_correction_support_on_insert(correction, groups):
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=groups))
    assert_check_violation(error)
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_fact_corrections).where(
            memory_fact_corrections.c.fact_id == correction["fact_id"])) == 0


def test_database_rejects_invalid_update_and_origin_evidence_change(correction):
    with Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=[["m1"]]))
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        session.execute(update(memory_fact_corrections).where(memory_fact_corrections.c.fact_id == correction["fact_id"])
                        .values(support_groups=[["spare"]]))
    assert_check_violation(error)
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == correction["fact_id"])
                        .values(support_groups=[["m2"]]))
    assert_check_violation(error)
    with Session() as session:
        assert session.scalar(select(memory_fact_corrections.c.support_groups).where(
            memory_fact_corrections.c.fact_id == correction["fact_id"])) == [["m1"]]
        assert session.scalar(select(memory_facts.c.support_groups).where(
            memory_facts.c.id == correction["fact_id"])) == [["m1", "assistant"], ["m2"], ["m3"]]


def test_database_rechecks_origin_blob_source_in_final_transaction(correction):
    with Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=[["m1"]]))
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        target_blob = session.scalar(select(memory_facts.c.blob_id).where(memory_facts.c.id == correction["corrected_fact_id"]))
        session.execute(update(memory_facts).where(memory_facts.c.id == correction["fact_id"])
                        .values(blob_id=target_blob, support_groups=[["old"]]))
    assert_check_violation(error)


def test_database_rechecks_direct_blob_move_without_a_fact_update(correction):
    owner = {"user_id": correction["user_id"], "project_id": correction["project_id"]}
    with Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=[["m1"]]))
        session.execute(insert(memory_sources).values(**owner, source_id="assistant-source"))
        session.execute(insert(memory_messages), [{**owner, "source_id": "assistant-source", "message_id": mid,
            "role": "assistant" if mid == "m1" else "user", "content_hash": "x",
            "occurred_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}
            for mid in ["m1", "m2", "m3", "assistant", "spare", "deleted"]])
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        # The destination contains the same source-local IDs; Blob and Fact
        # membership alone cannot prove the correction still has user evidence.
        session.execute(update(memory_blobs).where(memory_blobs.c.user_id == correction["user_id"],
            memory_blobs.c.source_id == "origin").values(source_id="assistant-source"))
    assert_check_violation(error)
    with Session() as session:
        assert session.scalar(select(memory_blobs.c.source_id).join(memory_facts,
            memory_facts.c.blob_id == memory_blobs.c.id).where(memory_facts.c.id == correction["fact_id"])) == "origin"


@pytest.mark.parametrize("physical", [False, True], ids=["tombstone", "remove-ledger"])
def test_message_delete_cannot_leave_correction_proof(correction, physical):
    with Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=[["m1"]]))
    # Both the old Fact and Blob constraints are satisfied in the final state;
    # only the abandoned correction proof is invalid.
    with pytest.raises(IntegrityError) as error, Session.begin() as session:
        scope = (memory_messages.c.user_id == correction["user_id"],
                 memory_messages.c.project_id == correction["project_id"],
                 memory_messages.c.source_id == "origin", memory_messages.c.message_id == "m1")
        if physical:
            session.execute(delete(memory_messages).where(*scope))
            session.execute(update(memory_blobs).where(memory_blobs.c.user_id == correction["user_id"],
                memory_blobs.c.source_id == "origin").values(message_ids=["m2", "m3", "assistant", "spare", "deleted"]))
        else:
            session.execute(update(memory_messages).where(*scope).values(deleted=True))
        session.execute(update(memory_facts).where(memory_facts.c.id == correction["fact_id"])
                        .values(support_groups=[["m2"], ["m3"]]))
    assert_check_violation(error)
    with Session() as session:
        assert not session.scalar(select(memory_messages.c.deleted).where(
            memory_messages.c.user_id == correction["user_id"], memory_messages.c.source_id == "origin",
            memory_messages.c.message_id == "m1"))


@pytest.mark.parametrize("edge_action", ["update", "delete", "cascade"])
def test_final_state_allows_message_first_then_proof_cleanup(correction, edge_action):
    with Session.begin() as session:
        session.execute(insert(memory_fact_corrections).values(**correction, support_groups=[["m1"], ["m2"]]))
    with Session.begin() as session:
        session.execute(update(memory_messages).where(memory_messages.c.user_id == correction["user_id"],
            memory_messages.c.source_id == "origin", memory_messages.c.message_id == "m1").values(deleted=True))
        if edge_action == "cascade":
            session.execute(delete(memory_facts).where(memory_facts.c.id == correction["fact_id"]))
        else:
            session.execute(update(memory_facts).where(memory_facts.c.id == correction["fact_id"])
                            .values(support_groups=[["m2"], ["m3"]]))
            statement = update(memory_fact_corrections).values(support_groups=[["m2"]]) if edge_action == "update" else delete(memory_fact_corrections)
            session.execute(statement.where(memory_fact_corrections.c.fact_id == correction["fact_id"]))
    with Session() as session:
        groups = session.scalar(select(memory_fact_corrections.c.support_groups).where(
            memory_fact_corrections.c.fact_id == correction["fact_id"]))
        assert groups == ([["m2"]] if edge_action == "update" else None)
        assert session.scalar(select(memory_messages.c.deleted).where(memory_messages.c.user_id == correction["user_id"],
            memory_messages.c.source_id == "origin", memory_messages.c.message_id == "m1"))


def test_correction_constraint_triggers_are_deferred(db_env):
    with Session() as session:
        triggers = session.execute(text("""SELECT tgname,tgdeferrable,tginitdeferred FROM pg_trigger
            WHERE tgname IN ('memory_correction_evidence','memory_correction_origin_evidence',
                'memory_correction_message_evidence','memory_correction_blob_evidence')
            ORDER BY tgname""")).all()
    assert len(triggers) == 4
    assert all(deferrable and deferred for _, deferrable, deferred in triggers)


@pytest.mark.asyncio
async def test_joint_correction_group_is_removed_whole_and_independent_group_survives(uid, models, monkeypatch):
    async def extract(request, **kwargs):
        if request.idempotency_key == "old":
            return source.ExtractedSource([dict(id=uuid4(), content="User lives in Beijing", subject="user",
                reporter="user", certainty="asserted", corrects=[], support_groups=[["1"]])])
        old_id = kwargs["rules"]["related_facts"][0]["id"]
        return source.ExtractedSource([dict(id=uuid4(), content="User lives in Shanghai", subject="user",
            reporter="user", certainty="asserted", support_groups=[["2", "3"], ["4"]],
            corrects=[{"fact_id": old_id, "support_groups": [["2", "3"], ["4"]]}])])
    monkeypatch.setattr(source, "extract_source", extract)
    old = await source.import_source(uid, "__root__", body("old", "1"))
    newer = await source.import_source(uid, "__root__", body("new", "2", "3", "4"))
    old_id, new_id = old.result.fact_ids[0], newer.result.fact_ids[0]
    removed = await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="remove-joint", message_ids=["2"]))
    assert removed.status == "completed" and removed.result.memory_version > newer.result.memory_version
    with Session() as session:
        assert not session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == old_id))
        assert session.scalar(select(memory_facts.c.support_groups).where(memory_facts.c.id == new_id)) == [["4"]]
        assert session.scalar(select(memory_fact_corrections.c.support_groups).where(
            memory_fact_corrections.c.fact_id == new_id)) == [["4"]]
        assert all("messages" not in request for request in session.scalars(select(memory_operations.c.request).where(
            memory_operations.c.user_id == uid)))
    await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="remove-independent", message_ids=["4"]))
    with Session() as session:
        assert session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == old_id))
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == new_id)) is None
        assert session.scalar(select(func.count()).select_from(memory_fact_corrections).where(
            memory_fact_corrections.c.user_id == uid)) == 0
