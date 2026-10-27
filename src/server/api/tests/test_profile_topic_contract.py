"""Default topic/consumer contract; deterministic tools do not prove model semantics."""
import json
from xml.etree import ElementTree

import pytest

from memoia_server.prompts import user_profile_topics, zh_user_profile_topics
from memoia_server.prompts.profile_init_utils import formate_profile_topic
from memoia_server.maintenance_agent import run_loop, MAINTENANCE_INSTRUCTIONS
from tests.test_maintenance_agent import Context, transport, completion
from tests.test_maintenance import source_user, batch
from tests.maintenance_support import maintain
from tests.test_search_bundle import search_users


TOPICS = ["user_profile", "personal_background", "work", "education",
          "interests_preferences", "lifestyle", "goals_values", "relationships"]


def test_default_topic_ids_are_language_independent_and_descriptions_survive_formatting():
    english = user_profile_topics.CANDIDATE_PROFILE_TOPICS
    chinese = zh_user_profile_topics.CANDIDATE_PROFILE_TOPICS
    assert [item.topic for item in english] == [item.topic for item in chinese] == TOPICS
    for en, zh in zip(english, chinese, strict=True):
        assert en.description and zh.description and en.description != zh.description
        assert en.description in formate_profile_topic(en)
        assert zh.description in formate_profile_topic(zh)


@pytest.mark.asyncio
async def test_three_context_topics_are_described_in_actual_runner_request(transport):
    context = Context()
    context.profile_topics = [{"topic": item.topic, "description": item.description, "sub_topics": []}
                             for item in user_profile_topics.CANDIDATE_PROFILE_TOPICS]
    context.allowed_topics = TOPICS
    transport["responses"] = [completion()]
    await run_loop(context)
    request = transport["requests"][0]
    assert len(request["input"][0]["content"]) == 1
    project = json.loads(ElementTree.fromstring(request["input"][0]["content"][0]["text"]).text)
    assert [item["topic"] for item in project["profile_topics"]] == TOPICS
    assert project["profile_topics"] == context.profile_topics
    assert request["instructions"] == MAINTENANCE_INSTRUCTIONS


@pytest.mark.asyncio
async def test_three_context_sections_reuse_existing_queries_and_deletion_loop(source_user):
    from sqlalchemy import select, update
    from memoia_server.connectors import Session
    from memoia_server.controllers import source, query
    from memoia_server.models.database import UserProfile
    from memoia_server.models.source import memory_facts, DeleteMessages
    from memoia_server.models.query import ProfileQuery
    from memoia_server.maintenance_agent import ProfileMutation, LoopUsage

    values = {"user_profile": "The user is a software engineer.",
              "interests_preferences": "The user generally prefers concise explanations.",
              "lifestyle": "The user usually walks to work.",
              "work": "The user maintains the payments service."}
    facts = {}
    for version, (topic, content) in enumerate(values.items(), 1):
        _, ident = batch(source_user, version, sid=topic)
        facts[topic] = str(ident)
        with Session.begin() as session:
            session.execute(update(memory_facts).where(memory_facts.c.id == ident).values(content=content))
    _, hobby = batch(source_user, 5, sid="hobby")
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == hobby).values(content="The user likes hiking."))

    async def derive(context):
        await context.read_changes()
        await context.read("facts", ids=[*facts.values(), str(hobby)])
        for topic, content in values.items():
            sub_topic = "interaction_preferences" if topic == "interests_preferences" else "overview"
            await context.stage_profile(ProfileMutation(action="upsert", topic=topic, sub_topic=sub_topic,
                content=content, fact_ids=[facts[topic]]))
        await context.stage_profile(ProfileMutation(action="upsert", topic="interests_preferences",
            sub_topic="hobbies", content="The user likes hiking.", fact_ids=[str(hobby)]))
        return context.get_plan(LoopUsage())

    assert await maintain(source_user, derive)
    async def section(topic):
        return (await query.query_profiles(source_user, "__root__", ProfileQuery(
            topic=topic, max_token_size=1000))).profiles
    for topic, content in values.items():
        found = [row for row in await section(topic) if row.content == content]
        assert len(found) == 1 and found[0].content == content
        assert found[0].topic == topic and list(map(str, found[0].fact_ids)) == [facts[topic]]
    preferences = await section("interests_preferences")
    assert {row.sub_topic for row in preferences} == {"interaction_preferences", "hobbies"}
    with Session() as session:
        before = dict(session.execute(select(UserProfile.id, UserProfile.revision).where(
            UserProfile.user_id == source_user, UserProfile.attributes["sub_topic"].astext != "interaction_preferences")).all())
    deletion = DeleteMessages(idempotency_key="delete-preference", message_ids=["m1"])
    receipt = await source.delete_messages(source_user, "__root__", "interests_preferences", deletion)
    assert receipt.status == "completed"
    pending = [row for row in await section("interests_preferences") if row.sub_topic == "interaction_preferences"]
    assert pending[0].content == values["interests_preferences"] and pending[0].fact_ids == []

    async def review_deletion(context):
        await context.read_changes()
        # All five entries were generated from one read set. Review that conservative
        # scope, retaining the four entries whose actual support still exists.
        for item in (await context.read("profiles"))["items"]:
            if item["fact_ids"]:
                fact_id = item["fact_ids"][0]
                content = next(fact["content"] for fact in item["evidence"] if fact["id"] == fact_id)
                sub_topic = ("hobbies" if fact_id == str(hobby) else
                             "interaction_preferences" if item["topic"] == "interests_preferences" else "overview")
                await context.stage_profile(ProfileMutation(action="upsert", id=item["id"],
                    content=content, topic=item["topic"], sub_topic=sub_topic,
                    fact_ids=item["fact_ids"]))
        return context.get_plan(LoopUsage())
    assert await maintain(source_user, review_deletion)
    remaining = await section("interests_preferences")
    assert len(remaining) == 1 and remaining[0].sub_topic == "hobbies"
    assert remaining[0].content == "The user likes hiking."
    assert (await section("user_profile"))[0].content == values["user_profile"]
    assert (await section("work"))[0].content == values["work"]
    assert (await section("lifestyle"))[0].content == values["lifestyle"]
    assert await source.delete_messages(source_user, "__root__", "interests_preferences", deletion) == receipt
    with Session() as session:
        after = dict(session.execute(select(UserProfile.id, UserProfile.revision).where(
            UserProfile.user_id == source_user)).all())
        assert after == {ident: revision + 2 for ident, revision in before.items()}


@pytest.mark.asyncio
async def test_topic_queries_return_multiple_complete_entries_without_legacy_fallback(search_users):
    from uuid import uuid4
    from memoia_server.connectors import Session
    from memoia_server.models.database import UserProfile

    uid, other, project, client = search_users
    with Session.begin() as session:
        for owner, pid, topic, contents in [
            (uid, "__root__", "user_profile", ["Stable background", "Long-term priority"]),
            (uid, "__root__", "basic_info", ["Legacy detail must not enter the three sections"]),
            (other, "__root__", "user_profile", ["Other user's overview"]),
            (uid, project, "user_profile", ["Other project's overview"]),
        ]:
            for index, content in enumerate(contents):
                session.execute(UserProfile.__table__.insert().values(id=uuid4(), user_id=owner, project_id=pid,
                    content=content, attributes={"topic": topic, "sub_topic": str(index)}))
    found = await client.post(f"/api/users/{uid}/profiles/query", json={
        "topic": "user_profile", "max_token_size": 1000})
    assert found.status_code == 200
    assert {row["content"] for row in found.json()["profiles"]} == {"Stable background", "Long-term priority"}
    missing = await client.post(f"/api/users/{uid}/profiles/query", json={"topic": "interests_preferences"})
    assert missing.status_code == 200 and missing.json()["profiles"] == []
