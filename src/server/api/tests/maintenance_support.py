"""Explicit deterministic flush maintenance; no fixture silently derives memory."""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import and_, select
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance
from memoia_server.models.database import User
from memoia_server.maintenance_agent import ProfileMutation, EventMutation, LoopUsage


def derive(*, latest=False, queries=(), kinds=("profile", "event")):
    async def runner(context):
        cursor = None
        while True:
            page = await context.read_changes(cursor=cursor)
            cursor = page["next_cursor"]
            if cursor is None:
                break
        facts = {row["id"]: row for row in (await context.read("facts"))["items"]}
        all_entries = {}
        for collection in ("profiles", "events"):
            entries = {row["id"]: row for row in (await context.read(collection))["items"]}
            for query in queries:
                for row in (await context.read("facts", query=query))["items"]:
                    facts[row["id"]] = row
                for row in (await context.read(collection, query=query))["items"]:
                    entries[row["id"]] = row
            all_entries[collection] = entries
        slots = {}
        for row in facts.values():
            slot = f"{row.get('topic') or 'legacy'}::{row.get('sub_topic') or 'value'}"
            if slot not in slots or row["occurred_at"] > slots[slot]["occurred_at"]:
                slots[slot] = row
        selected = list(slots.values()) if latest else list(facts.values())
        for kind, collection in (("profile", "profiles"), ("event", "events")):
            if kind not in kinds:
                continue
            entries, used = all_entries[collection], set()
            for row in selected:
                slot = f"{row.get('topic') or 'legacy'}::{row.get('sub_topic') or 'value'}"
                existing = next((entry for entry in entries.values() if (
                    entry.get("sub_topic") == slot if kind == "profile" else
                    row["id"] in [*entry["fact_ids"], *entry.get("invalid_fact_ids", [])])), None)
                ident = existing["id"] if existing else None
                if ident:
                    used.add(ident)
                if kind == "profile":
                    topic = row.get("topic")
                    if topic not in context.allowed_topics:
                        topic = context.allowed_topics[0]
                    await context.stage_profile(ProfileMutation(action="upsert", id=ident, content=row["content"],
                        topic=topic, sub_topic=slot, fact_ids=[row["id"]]))
                else:
                    await context.stage_event(EventMutation(action="upsert", id=ident, title=row["content"],
                        content=row["content"], time=datetime.fromisoformat(row["occurred_at"]).isoformat(),
                        fact_ids=[row["id"]]))
            for entry in entries.values():
                if entry["id"] in used:
                    continue
                change = {"action": "remove", "id": entry["id"]}
                if kind == "profile":
                    await context.stage_profile(ProfileMutation(**change))
                else:
                    await context.stage_event(EventMutation(**change))
        return context.get_plan(LoopUsage())
    return runner


def claim_for(user_id, *, project_id="__root__"):
    maintenance.reap_expired()
    with Session.begin() as session:
        identity = and_(User.id == user_id, User.project_id == project_id)
        session.execute(select(User.id).where(~identity).with_for_update()).all()
        claim = maintenance.claim_next()
    if claim is not None:
        assert str(claim.user_id) == str(user_id) and claim.project_id == project_id
    return claim


async def maintain(user_id, runner=None, *, project_id="__root__"):
    maintenance.flush(user_id, project_id, f"fixture-flush:{uuid4()}")
    claim = claim_for(user_id, project_id=project_id)
    assert claim is not None
    return await maintenance.execute_claim(claim, runner=runner or derive())


def status(user_id, project_id="__root__"):
    """Fixture convenience only: production exposes each original flush explicitly."""
    state = maintenance.get_status(user_id, project_id)
    failed = next((row for row in state["flushes"] if row["status"] == "failed" or row["error"]), None)
    pending = next((row for row in state["flushes"] if row["status"] != "completed"), None)
    row = failed or pending or (state["flushes"][0] if state["flushes"] else None)
    return {"status": "pending" if state["pending_blob_count"] and not pending and not failed else row["status"] if row else "completed",
            "error": row["error"] if row else None, "operation_id": row["operation_id"] if row else None,
            "attempts": row["attempts"] if row else 0}
