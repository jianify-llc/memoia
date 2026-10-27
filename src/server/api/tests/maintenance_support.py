"""Explicit deterministic flush maintenance; no fixture silently derives memory."""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import and_, select
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance
from memoia_server.models.database import User
from memoia_server.maintenance_agent import ProfileMutation, EventMutation, LoopUsage


async def stage_derived(context, *, latest=False, queries=(), kinds=("profile", "event")):
    """Stage fixture decisions; callers finalize only after all collections are handled."""
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
    # Default Fact reads are incremental. Resolve actual support before deciding
    # whether a previously derived entry should survive this fixture run.
    missing = {fid for entries in all_entries.values() for entry in entries.values()
               for fid in entry["fact_ids"]} - facts.keys()
    if missing:
        facts.update({row["id"]: row for row in (await context.read("facts", ids=sorted(missing)))["items"]})
    slots = {}
    for row in facts.values():
        slot = f"{row.get('topic') or 'legacy'}::{row.get('sub_topic') or 'value'}"
        if slot not in slots or row["occurred_at"] > slots[slot]["occurred_at"]:
            slots[slot] = row
    selected = list(slots.values()) if latest else list(facts.values())
    selected_ids = {row["id"] for row in selected}
    for kind, collection in (("profile", "profiles"), ("event", "events")):
        if kind not in kinds:
            continue
        entries, used = all_entries[collection], set()
        for row in selected:
            slot = f"{row.get('topic') or 'legacy'}::{row.get('sub_topic') or 'value'}"
            existing = next((entry for entry in entries.values()
                             if row["id"] in [*entry["fact_ids"], *entry.get("invalid_fact_ids", [])]), None)
            if kind == "profile" and existing is None:
                existing = next((entry for entry in entries.values() if entry.get("sub_topic") == slot), None)
            ident = existing["id"] if existing else None
            if ident:
                used.add(ident)
            if kind == "profile":
                topic = row.get("topic")
                if topic not in context.allowed_topics:
                    topic = context.allowed_topics[0]
                unchanged = (existing is not None and not existing.get("review_required")
                             and existing["content"] == row["content"]
                             and existing["topic"] == topic and existing["sub_topic"] == slot
                             and existing["fact_ids"] == [row["id"]] and not existing.get("invalid_fact_ids"))
                change = ProfileMutation(action="keep", id=ident) if unchanged else ProfileMutation(
                    action="upsert", id=ident, content=row["content"], topic=topic,
                    sub_topic=slot, fact_ids=[row["id"]])
                await context.stage_profile(change)
            else:
                await context.stage_event(EventMutation(action="upsert", id=ident, title=row["content"],
                    content=row["content"], event_time=datetime.fromisoformat(row["occurred_at"]).isoformat(),
                    fact_ids=[row["id"]]))
        for entry in entries.values():
            if entry["id"] in used:
                continue
            supported = [facts[fid] for fid in entry["fact_ids"] if fid in facts]
            replaced = latest and all(row["id"] not in selected_ids for row in supported)
            action = "keep" if supported and not replaced and not entry.get("invalid_fact_ids") else "remove"
            change = {"action": action, "id": entry["id"]}
            if supported and not replaced and entry.get("review_required"):
                change.update(action="upsert", content=" ".join(row["content"] for row in supported),
                              fact_ids=[row["id"] for row in supported])
                if kind == "profile":
                    change.update(topic=context.allowed_topics[0], sub_topic="fixture")
            if kind == "profile":
                await context.stage_profile(ProfileMutation(**change))
            else:
                await context.stage_event(EventMutation(**change))


def derive(*, latest=False, queries=(), kinds=("profile", "event")):
    async def runner(context):
        await stage_derived(context, latest=latest, queries=queries, kinds=kinds)
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
