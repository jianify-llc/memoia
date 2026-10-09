"""Hybrid Fact-first bundles: strict ID exclusion, proof scope and total budget."""
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
import pytest_asyncio
import httpx
from sqlalchemy import delete, insert, update

from memoia_server.connectors import Session
from memoia_server.controllers import event
from memoia_server.env import CONFIG
from memoia_server.models.database import Project, User, UserEvent, UserEventGist, UserProfile
from memoia_server.models.source import (SearchResult, memory_sources, memory_messages,
    memory_blobs, memory_facts, memory_event_facts)
from memoia_server.models.utils import Promise
from memoia_server.utils import get_encoded_tokens


@pytest_asyncio.fixture
async def search_users(db_env, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    uid, other, pid = uuid4(), uuid4(), "bundle-" + uuid4().hex
    with Session.begin() as session:
        session.execute(Project.__table__.insert().values(id=uuid4(), project_id=pid,
            project_secret=uuid4().hex))
        session.execute(User.__table__.insert(), [dict(id=who, project_id=project, additional_fields={})
            for who, project in [(uid, "__root__"), (other, "__root__"), (uid, pid)]])
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app), base_url="http://test", headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]})
    try:
        yield uid, other, pid, client
    finally:
        (await client.aclose())
        with Session.begin() as session:
            session.execute(delete(User).where(User.id.in_([uid, other]), User.project_id == "__root__"))
            session.execute(delete(Project).where(Project.project_id == pid))


def seed_facts(uid, contents, *, pid="__root__", ids=None):
    blob, sid = uuid4(), "source-" + uuid4().hex
    ids = ids or [uuid4() for _ in contents]
    scope = dict(user_id=uid, project_id=pid)
    recorded = datetime(2026, 9, 3, tzinfo=timezone.utc)
    with Session.begin() as session:
        session.execute(insert(memory_sources).values(**scope, source_id=sid))
        session.execute(insert(memory_messages).values(**scope, source_id=sid, message_id="m1", role="user",
            content_hash="no-stored-body", processed=True, occurred_at=recorded, time_zone="Asia/Shanghai"))
        session.execute(insert(memory_blobs).values(**scope, id=blob, source_id=sid, message_ids=["m1"], status="active"))
        session.execute(insert(memory_facts), [dict(scope, id=ident, blob_id=blob, content=text, search_text=text,
            subject="The user", reporter="The user", certainty="asserted", support_groups=[["m1"]], occurred_at=recorded)
            for ident, text in zip(ids, contents, strict=True)])
    return ids


def seed_derived(uid, ids, *, pid="__root__", story_id=None, profile_id=None, content="Sakura story"):
    story_id, profile_id = story_id or uuid4(), profile_id or uuid4()
    scope = dict(user_id=uid, project_id=pid)
    with Session.begin() as session:
        session.execute(UserEvent.__table__.insert().values(**scope, id=story_id, event_data={"memoia_v2": True,
            "event_tip": content, "content": content, "title": "Kyoto visit", "summary": "Stayed at Sakura",
            "keywords": "hotel travel", "time": "2026-09", "location": "Kyoto", "interpretation": None,
            "fact_ids": [str(ident) for ident in ids]}))
        session.execute(insert(memory_event_facts), [dict(scope, event_id=story_id, fact_id=ident) for ident in ids])
        session.execute(UserProfile.__table__.insert().values(**scope, id=profile_id, content="Enjoys Kyoto hotels",
            attributes={"topic": "interest", "sub_topic": "travel", "fact_ids": [str(ident) for ident in ids]}))
    return story_id, profile_id


def token_size(bundle):
    return len(get_encoded_tokens(bundle.model_dump_json()))


@pytest.mark.asyncio
async def test_bundle_returns_related_objects_once_with_full_fields_and_no_new_revision(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel visit", "Sakura travel plan"])
    eid, profile = seed_derived(uid, ids)
    reply = await event.hybrid_search_user_events(uid, "__root__", "Sakura", max_token_size=4000)
    assert reply.ok()
    bundle = reply.data()
    assert set(bundle.model_dump()) == {"facts", "events", "profiles"}
    assert {fact.id for fact in bundle.facts} == set(ids)
    assert [story.id for story in bundle.events] == [eid] and [item.id for item in bundle.profiles] == [profile]
    assert set(bundle.events[0].fact_ids) == set(ids) == {proof.fact_id for proof in bundle.events[0].evidence}
    assert set(bundle.profiles[0].fact_ids) == set(ids)
    assert bundle.events[0].title == "Kyoto visit" and bundle.events[0].time == "2026-09"
    assert bundle.events[0].location == "Kyoto" and bundle.events[0].keywords == "hotel travel"
    assert token_size(bundle) <= 4000
    assert all("revision" not in item.model_dump() for item in [*bundle.facts, *bundle.events, *bundle.profiles])
    repeated = await event.hybrid_search_user_events(uid, "__root__", "Sakura")
    assert repeated.data().model_dump() == bundle.model_dump()


@pytest.mark.asyncio
async def test_fact_first_budget_counts_the_entire_three_field_json_without_truncation(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel visit"])
    seed_derived(uid, ids)
    full = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    fact_only = SearchResult(facts=full.facts, events=[], profiles=[])
    exact = token_size(fact_only)
    limited = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", max_token_size=exact)).data()
    assert limited.model_dump() == fact_only.model_dump() and token_size(limited) == exact
    below = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", max_token_size=exact - 1)).data()
    assert below.facts == below.events == below.profiles == []
    assert token_size(below) <= exact - 1
    tiny = await event.hybrid_search_user_events(uid, "__root__", "Sakura", max_token_size=1)
    assert not tiny.ok() and tiny.code() == 400


@pytest.mark.asyncio
async def test_too_small_budget_remains_a_controlled_api_input_error(search_users):
    uid, _, _, client = search_users
    response = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura", "max_token_size": 1}))
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_oversized_first_fact_is_skipped_and_a_later_complete_fact_can_fit(search_users):
    uid, _, _, _ = search_users
    base = (uuid4().int >> 16) << 16
    ids = seed_facts(uid, ["Sakura " + "very long description " * 2000, "Sakura short fact"],
        ids=[UUID(int=base + 1), UUID(int=base + 2)])
    result = await event.hybrid_search_user_events(uid, "__root__", "Sakura", limit=1, max_token_size=600)
    assert [fact.id for fact in result.data().facts] == [ids[1]]
    assert result.data().facts[0].content == "Sakura short fact" and token_size(result.data()) <= 600


@pytest.mark.asyncio
async def test_all_three_exclusions_are_applied_before_candidate_limits(search_users):
    uid, _, _, _ = search_users
    base = (uuid4().int >> 16) << 16
    ids = seed_facts(uid, ["Sakura hotel"] * 501, ids=[UUID(int=base + index) for index in range(501)])
    scope = dict(user_id=uid, project_id="__root__")
    eids, pids = [UUID(int=base + 1000 + i) for i in range(501)], [UUID(int=base + 2000 + i) for i in range(501)]
    with Session.begin() as session:
        session.execute(UserEvent.__table__.insert(), [dict(scope, id=ident, event_data={"memoia_v2": True,
            "event_tip": "Sakura hotel", "fact_ids": [str(ids[-1])]}) for ident in eids])
        session.execute(insert(memory_event_facts), [dict(scope, event_id=ident, fact_id=ids[-1]) for ident in eids])
        session.execute(UserProfile.__table__.insert(), [dict(scope, id=ident, content="Sakura hotel",
            attributes={"topic": "interest", "sub_topic": "travel", "fact_ids": [str(ids[-1])]}) for ident in pids])
    result = await event.hybrid_search_user_events(uid, "__root__", "Sakura", limit=1,
        exclude_fact_ids=ids[:500], exclude_event_ids=eids[:500], exclude_profile_ids=pids[:500])
    assert result.ok()
    assert [fact.id for fact in result.data().facts] == ids[-1:]
    assert [story.id for story in result.data().events] == eids[-1:]
    assert [profile.id for profile in result.data().profiles] == pids[-1:]


@pytest.mark.asyncio
async def test_strict_id_exclusion_survives_content_updates_and_does_not_break_story_proof(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura older fact", "Sakura second fact"])
    eid, profile = seed_derived(uid, ids)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == ids[0]).values(content="Sakura updated fact",
            search_text="Sakura updated fact", revision=2))
        session.execute(update(UserEvent).where(UserEvent.id == eid).values(revision=2))
        session.execute(update(UserProfile).where(UserProfile.id == profile).values(revision=2))
    response = await event.hybrid_search_user_events(uid, "__root__", "Sakura", exclude_fact_ids=ids[:1])
    assert [fact.id for fact in response.data().facts] == ids[1:]
    assert set(response.data().events[0].fact_ids) == set(ids)
    excluded = await event.hybrid_search_user_events(uid, "__root__", "Sakura",
        exclude_event_ids=[eid], exclude_profile_ids=[profile])
    assert len(excluded.data().facts) == 2 and excluded.data().events == excluded.data().profiles == []


@pytest.mark.asyncio
async def test_later_derived_memory_remains_reachable_after_fact_was_injected(search_users):
    uid, _, _, client = search_users
    ids = seed_facts(uid, ["Sakura hotel visit"])
    path = f"/api/users/{uid}/search"
    first = (await client.post(path, json={"query": "Sakura"}))
    assert first.status_code == 200
    assert first.json()["events"] == first.json()["profiles"] == []
    eid, pid = seed_derived(uid, ids)
    later = (await client.post(path, json={"query": "Sakura", "exclude_fact_ids": [str(ident) for ident in ids]}))
    assert later.status_code == 200
    bundle = later.json()
    assert bundle["facts"] == []
    assert [entry["id"] for entry in bundle["events"]] == [str(eid)]
    assert [entry["id"] for entry in bundle["profiles"]] == [str(pid)]
    assert [proof["fact_id"] for proof in bundle["events"][0]["evidence"]] == [str(ids[0])]


@pytest.mark.asyncio
@pytest.mark.parametrize("hide", ["events", "profiles", "both"])
async def test_navigation_respects_each_derived_exclusion_independently(search_users, hide):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel visit"])
    eid, pid = seed_derived(uid, ids)
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", exclude_fact_ids=ids,
        exclude_event_ids=[eid] if hide in ("events", "both") else [],
        exclude_profile_ids=[pid] if hide in ("profiles", "both") else [])).data()
    assert bundle.facts == []
    assert [entry.id for entry in bundle.events] == ([eid] if hide == "profiles" else [])
    assert [entry.id for entry in bundle.profiles] == ([pid] if hide == "events" else [])


@pytest.mark.asyncio
@pytest.mark.parametrize("has_unseen_links", [False, True])
async def test_seen_fact_candidates_cannot_starve_an_unseen_fact(search_users, has_unseen_links):
    uid, _, _, _ = search_users
    base = (uuid4().int >> 16) << 16
    ids = seed_facts(uid, ["Sakura hotel"] * 501, ids=[UUID(int=base + i) for i in range(501)])
    if has_unseen_links:
        seed_derived(uid, ids[:500])
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", limit=1,
        exclude_fact_ids=ids[:500])).data()
    assert [fact.id for fact in bundle.facts] == ids[-1:]
    assert token_size(bundle) <= 4000


@pytest.mark.asyncio
async def test_seen_fact_without_allowed_links_is_removed_before_ranking(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel visit"])
    seed_derived(uid, ids)
    result = await event.retrieve_user_facts(uid, "__root__", "Sakura", exclude_fact_ids=ids,
        separate_legacy=True, navigate_seen_facts=True, include_events=False, exclude_profile_topics=["interest"])
    assert result.ok() and result.data() == []


@pytest.mark.asyncio
async def test_deleted_navigation_anchor_does_not_return_stale_derived_evidence(search_users, monkeypatch):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura hotel visit"])
    seed_derived(uid, ids)
    retrieve = event.retrieve_user_facts

    async def retrieve_then_delete(*args, **kwargs):
        result = await retrieve(*args, **kwargs)
        with Session.begin() as session:
            session.execute(delete(memory_facts).where(memory_facts.c.id == ids[0]))
        return result

    monkeypatch.setattr(event, "retrieve_user_facts", retrieve_then_delete)
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", exclude_fact_ids=ids)).data()
    assert bundle.facts == bundle.events == bundle.profiles == []


@pytest.mark.asyncio
async def test_project_and_user_scope_filter_derived_links_even_for_corrupt_profile_metadata(search_users):
    uid, other, pid, _ = search_users
    own = seed_facts(uid, ["Sakura own fact"])
    foreign = seed_facts(other, ["Sakura private user fact"])
    project = seed_facts(uid, ["Sakura private project fact"], pid=pid)
    own_event, own_profile = seed_derived(uid, own)
    seed_derived(other, foreign)
    seed_derived(uid, project, pid=pid)
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == own_profile, UserProfile.project_id == "__root__")
            .values(attributes={"topic": "interest", "sub_topic": "travel", "fact_ids": [str(i) for i in own + foreign + project]}))
        session.execute(UserProfile.__table__.insert().values(id=uuid4(), user_id=other, project_id="__root__",
            content="Foreign profile matching own Fact", attributes={"fact_ids": [str(own[0])]}))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert [fact.id for fact in bundle.facts] == own and [story.id for story in bundle.events] == [own_event]
    assert [profile.id for profile in bundle.profiles] == [own_profile] and bundle.profiles[0].fact_ids == own
    assert "private" not in bundle.model_dump_json()


@pytest.mark.asyncio
async def test_delayed_old_derived_text_never_returns_inactive_fact_as_valid_proof(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura still valid", "Sakura corrected conclusion"])
    eid, profile = seed_derived(uid, ids, content="Old story temporarily awaits maintenance")
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == ids[1]).values(active=False, revision=2))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert [fact.id for fact in bundle.facts] == ids[:1]
    assert [story.id for story in bundle.events] == [eid] and bundle.events[0].content.startswith("Old story")
    assert bundle.events[0].fact_ids == ids[:1] and [proof.fact_id for proof in bundle.events[0].evidence] == ids[:1]
    assert [item.id for item in bundle.profiles] == [profile] and bundle.profiles[0].fact_ids == ids[:1]


@pytest.mark.asyncio
async def test_fact_deleted_between_retrieval_and_association_reads_is_not_returned(search_users, monkeypatch):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura fact"])
    seed_derived(uid, ids)
    retrieve = event.retrieve_user_facts

    async def retrieve_then_delete(*args, **kwargs):
        result = await retrieve(*args, **kwargs)
        with Session.begin() as session:
            session.execute(delete(memory_facts).where(memory_facts.c.id == ids[0]))
        return result

    monkeypatch.setattr(event, "retrieve_user_facts", retrieve_then_delete)
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert bundle.facts == bundle.events == bundle.profiles == []


@pytest.mark.asyncio
async def test_event_delete_keeps_independent_fact_searchable(search_users):
    uid, _, _, client = search_users
    ids = seed_facts(uid, ["Sakura fact"])
    eid, profile = seed_derived(uid, ids)
    assert (await client.delete(f"/api/users/{uid}/events/{eid}")).status_code == 204
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert [fact.id for fact in bundle.facts] == ids and bundle.events == []
    assert [item.id for item in bundle.profiles] == [profile]


@pytest.mark.asyncio
async def test_legacy_events_have_a_separate_pool_and_never_become_pseudo_facts(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura independent fact"])
    base = (uuid4().int >> 16) << 16
    legacy_ids = [UUID(int=base + i) for i in range(60)]
    with Session.begin() as session:
        session.execute(UserEvent.__table__.insert(), [dict(id=ident, user_id=uid, project_id="__root__",
            event_data={"event_tip": "Sakura legacy " * 4}) for ident in legacy_ids])
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", limit=1)).data()
    assert [fact.id for fact in bundle.facts] == ids
    assert len(bundle.events) == 1 and bundle.events[0].id in legacy_ids
    assert bundle.events[0].evidence == bundle.events[0].fact_ids == []
    assert bundle.profiles == []


@pytest.mark.asyncio
async def test_legacy_event_exclusion_is_applied_to_gist_and_whole_event_candidates(search_users):
    uid, _, _, _ = search_users
    with Session.begin() as session:
        parent = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Sakura old story"})
        session.add(parent)
        session.flush()
        eid = parent.id
        session.add(UserEventGist(user_id=uid, project_id="__root__", event_id=eid, gist_data={"content": "Sakura old fact"}))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", exclude_event_ids=[eid])).data()
    assert bundle.facts == bundle.events == bundle.profiles == []


@pytest.mark.asyncio
async def test_vector_candidate_exclusion_and_explicit_event_subbudget_preserve_facts(search_users, monkeypatch):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["A Japanese inn", "Another Japanese inn"])
    seed_derived(uid, ids)
    vector = np.zeros(CONFIG.embedding_dim)
    vector[0] = 1
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id.in_(ids)).values(embedding=vector))
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.resolve(np.array([vector]))))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura", exclude_fact_ids=ids[:1],
        event_max_tokens=1)).data()
    assert [fact.id for fact in bundle.facts] == ids[1:] and bundle.events == []
    assert len(bundle.profiles) == 1


@pytest.mark.asyncio
async def test_bundle_bulk_proof_query_count_does_not_grow_with_selected_facts(search_users):
    from sqlalchemy import event as sql_event
    from memoia_server.connectors import DB_ENGINE
    uid, _, _, _ = search_users
    ids = seed_facts(uid, [f"Sakura note {index}" for index in range(12)])
    seed_derived(uid, ids)
    statements = []

    def capture(_connection, _cursor, statement, *_):
        if statement.lstrip().startswith("SELECT"):
            statements.append(statement)

    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    try:
        counts = []
        for limit in (1, 12):
            statements.clear()
            reply = await event.hybrid_search_user_events(uid, "__root__", "Sakura", limit=limit, max_token_size=10000)
            assert reply.ok() and len(reply.data().facts) == limit
            assert len(reply.data().events) == len(reply.data().profiles) == 1
            assert sum("FROM memory_messages" in sql for sql in statements) == 2
            counts.append(len(statements))
        assert counts[0] == counts[1]
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)


@pytest.mark.asyncio
async def test_profile_topic_exclusion_precedes_topk_and_does_not_remove_fact_or_event(search_users):
    uid, _, _, client = search_users
    ids = seed_facts(uid, ["Sakura fact"])
    eid, profile = seed_derived(uid, ids)
    base = (uuid4().int >> 16) << 16
    with Session.begin() as session:
        session.execute(UserProfile.__table__.insert(), [dict(id=UUID(int=base + index), user_id=uid,
            project_id="__root__", content="Earlier excluded profile", attributes={"topic": "basic_info",
            "sub_topic": "name", "fact_ids": [str(ids[0])]}) for index in range(60)])
    request = dict(query="Sakura", limit=1, exclude_profile_topics=["basic_info"])
    response = (await client.post(f"/api/users/{uid}/search", json=request))
    assert response.status_code == 200
    bundle = SearchResult.model_validate(response.json())
    assert [fact.id for fact in bundle.facts] == ids and [story.id for story in bundle.events] == [eid]
    assert [item.id for item in bundle.profiles] == [profile]
    excluded = (await event.hybrid_search_user_events(uid, "__root__", "Sakura",
        exclude_profile_topics=["basic_info", "interest"])).data()
    assert [fact.id for fact in excluded.facts] == ids and [story.id for story in excluded.events] == [eid]
    assert excluded.profiles == []


@pytest.mark.asyncio
async def test_cross_table_same_uuid_does_not_collapse_fact_and_legacy_event_identity(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Sakura independent fact"])
    with Session.begin() as session:
        session.execute(UserEvent.__table__.insert().values(id=ids[0], user_id=uid, project_id="__root__",
            event_data={"event_tip": "Sakura legacy story", "source_id": "legacy-source"}))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert [fact.id for fact in bundle.facts] == ids == [story.id for story in bundle.events]
    assert bundle.facts[0].source_id != bundle.events[0].source_id == "legacy-source"
    assert bundle.events[0].fact_ids == []


@pytest.mark.asyncio
async def test_legacy_gist_preserves_explicit_source_metadata_without_fabricating_proof(search_users):
    uid, _, _, _ = search_users
    with Session.begin() as session:
        parent = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Legacy story"})
        session.add(parent)
        session.flush()
        session.add(UserEventGist(user_id=uid, project_id="__root__", event_id=parent.id,
            gist_data={"content": "Sakura hotel", "source_id": "known-source"}))
    bundle = (await event.hybrid_search_user_events(uid, "__root__", "Sakura")).data()
    assert bundle.facts == [] and len(bundle.events) == 1 and bundle.events[0].source_id == "known-source"
    assert bundle.events[0].fact_ids == bundle.events[0].evidence == []
