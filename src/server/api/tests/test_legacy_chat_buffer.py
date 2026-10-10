# Modified for Memoia: use the renamed internal server package.
import pytest
from sqlalchemy import select
from memoia_server import controllers
from memoia_server.connectors import Session
from memoia_server.controllers import source
from memoia_server.env import BufferStatus
from memoia_server.models import response as res
from memoia_server.models.database import DEFAULT_PROJECT_ID
from memoia_server.models.blob import BlobType
from memoia_server.models.source import memory_operations, memory_facts
from tests.maintenance_support import maintain


PROFILES = [
    "user likes to play basketball",
    "user is a junior school student",
    "user likes japanese food",
    "user is 23 years old",
]

PROFILE_ATTRS = [
    {"topic": "interest", "sub_topic": "sports"},
    {"topic": "education", "sub_topic": "level"},
    {"topic": "interest", "sub_topic": "foods"},
    {"topic": "basic_info", "sub_topic": "age"},
]

OVER_MAX_PROFILEs = ["Chinese food" for _ in range(20)]
OVER_MAX_PROFILE_ATTRS = [
    {"topic": "interest", "sub_topic": "foods" + str(i)} for i in range(20)
]


def dict_contains(a: dict, b: dict) -> bool:
    return all(a[k] == v for k, v in b.items())


@pytest.mark.asyncio
async def test_chat_buffer_uses_fact_import_and_flush(
    db_env,
    four_fact_source_model,
):
    p = await controllers.user.create_user(res.UserData(), DEFAULT_PROJECT_ID)
    assert p.ok()
    u_id = p.data().id

    blob1 = res.BlobData(
        blob_type=BlobType.chat,
        blob_data={
            "messages": [
                {"role": "user", "content": "Hello, this is Gus, how are you?"},
                {"role": "assistant", "content": "I am fine, thank you!"},
            ]
        },
    )
    blob2 = res.BlobData(
        blob_type=BlobType.chat,
        blob_data={
            "messages": [
                {"role": "user", "content": "Hi, nice to meet you, I am Gus"},
                {
                    "role": "assistant",
                    "content": "Great! I'm Memobase Assistant, how can I help you?",
                },
                {"role": "user", "content": "I really dig into Chinese food"},
                {"role": "assistant", "content": "Got it, Gus!"},
                {
                    "role": "user",
                    "content": "write me a homework letter about my final exam, high school is really boring.",
                },
            ]
        },
        fields={"from": "happy"},
    )
    p = await controllers.blob.insert_blob(
        u_id,
        DEFAULT_PROJECT_ID,
        blob1,
    )
    assert p.ok()
    b_id = p.data().id
    await controllers.buffer.insert_blob_to_buffer(
        u_id, DEFAULT_PROJECT_ID, b_id, blob1.to_blob()
    )
    p = await controllers.blob.insert_blob(
        u_id,
        DEFAULT_PROJECT_ID,
        blob2,
    )
    assert p.ok()
    b_id2 = p.data().id
    await controllers.buffer.insert_blob_to_buffer(
        u_id, DEFAULT_PROJECT_ID, b_id2, blob2.to_blob()
    )

    p = await controllers.buffer.get_buffer_capacity(
        u_id, DEFAULT_PROJECT_ID, BlobType.chat
    )
    assert p.ok() and p.data() == 2

    flushed = await controllers.buffer.flush_buffer(u_id, DEFAULT_PROJECT_ID, BlobType.chat)
    assert flushed.ok()

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and p.data().profiles == []
    p = await controllers.event.get_user_events(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and p.data().events == []
    p = await controllers.user.get_user_all_blobs(u_id, DEFAULT_PROJECT_ID, BlobType.chat)
    assert p.ok() and p.data().ids == []
    assert await maintain(u_id)

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()
    assert len(p.data().profiles) == 4

    p = await controllers.profile.truncate_profiles(p.data(), topk=2)
    assert p.ok()
    assert len(p.data().profiles) == 2

    p = await controllers.event.get_user_events(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()
    assert len(p.data().events) == 4

    p = await controllers.buffer.get_buffer_capacity(
        u_id, DEFAULT_PROJECT_ID, BlobType.chat
    )
    assert p.ok() and p.data() == 0

    # Successful processing erases chat input even under the old persistence flag.
    p = await controllers.user.get_user_all_blobs(
        u_id, DEFAULT_PROJECT_ID, BlobType.chat
    )
    assert p.ok() and len(p.data().ids) == 0

    p = await controllers.user.delete_user(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()

    four_fact_source_model.assert_awaited_once()


@pytest.mark.asyncio
async def test_chat_buffer_maintenance_preserves_manual_profiles(
    db_env,
    four_fact_source_model,
):
    p = await controllers.user.create_user(res.UserData(), DEFAULT_PROJECT_ID)
    assert p.ok()
    u_id = p.data().id

    blob1 = res.BlobData(
        blob_type=BlobType.chat,
        blob_data={
            "messages": [
                {"role": "user", "content": "Hello, this is Gus, how are you?"},
                {"role": "assistant", "content": "I am fine, thank you!"},
                {"role": "user", "content": "I'm 25 now, how time flies!"},
            ]
        },
    )
    blob2 = res.BlobData(
        blob_type=BlobType.chat,
        blob_data={
            "messages": [
                {"role": "user", "content": "I really dig into Chinese food"},
                {"role": "assistant", "content": "Got it, Gus!"},
                {
                    "role": "user",
                    "content": "write me a homework letter about my final exam, high school is really boring.",
                },
            ]
        },
        fields={"from": "happy"},
    )
    p = await controllers.blob.insert_blob(
        u_id,
        DEFAULT_PROJECT_ID,
        blob1,
    )
    assert p.ok()
    b_id = p.data().id
    await controllers.buffer.insert_blob_to_buffer(
        u_id, DEFAULT_PROJECT_ID, b_id, blob1.to_blob()
    )
    p = await controllers.blob.insert_blob(
        u_id,
        DEFAULT_PROJECT_ID,
        blob2,
    )
    assert p.ok()
    b_id2 = p.data().id
    await controllers.buffer.insert_blob_to_buffer(
        u_id, DEFAULT_PROJECT_ID, b_id2, blob2.to_blob()
    )

    p = await controllers.profile.add_user_profiles(
        u_id, DEFAULT_PROJECT_ID, PROFILES, PROFILE_ATTRS
    )
    assert p.ok()
    flushed = await controllers.buffer.flush_buffer(u_id, DEFAULT_PROJECT_ID, BlobType.chat)
    assert flushed.ok()

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and sorted(profile.content for profile in p.data().profiles) == sorted(PROFILES)
    assert await maintain(u_id)

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and len(p.data().profiles) == len(PROFILES) + 4
    profiles = p.data().profiles
    profiles = sorted(profiles, key=lambda x: x.content)

    assert dict_contains(
        profiles[-1].attributes, {"topic": "interest", "sub_topic": "sports"}
    )
    assert profiles[-1].content == "user likes to play basketball"
    assert dict_contains(
        profiles[-2].attributes, {"topic": "interest", "sub_topic": "foods"}
    )
    assert profiles[-2].content == "user likes japanese food"
    assert all(original in [p.content for p in profiles] for original in PROFILES)

    p = await controllers.user.delete_user(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()

    four_fact_source_model.assert_awaited_once()


@pytest.mark.asyncio
async def test_chat_buffer_import_preserves_large_manual_profile_set(
    db_env,
    four_fact_source_model,
):
    p = await controllers.user.create_user(res.UserData(), DEFAULT_PROJECT_ID)
    assert p.ok()
    u_id = p.data().id

    blob1 = res.BlobData(
        blob_type=BlobType.chat,
        blob_data={
            "messages": [
                {"role": "user", "content": "Hello, this is Gus, how are you?"},
                {"role": "assistant", "content": "I am fine, thank you!"},
                {"role": "user", "content": "I'm 25 now, how time flies!"},
            ]
        },
    )

    p = await controllers.blob.insert_blob(
        u_id,
        DEFAULT_PROJECT_ID,
        blob1,
    )
    assert p.ok()
    b_id = p.data().id
    await controllers.buffer.insert_blob_to_buffer(
        u_id, DEFAULT_PROJECT_ID, b_id, blob1.to_blob()
    )
    p = await controllers.profile.add_user_profiles(
        u_id, DEFAULT_PROJECT_ID, OVER_MAX_PROFILEs, OVER_MAX_PROFILE_ATTRS
    )
    assert p.ok()

    flushed = await controllers.buffer.flush_buffer(u_id, DEFAULT_PROJECT_ID, BlobType.chat)
    assert flushed.ok()

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()
    assert sorted(profile.content for profile in p.data().profiles) == sorted(OVER_MAX_PROFILEs)
    assert len(p.data().profiles) == len(OVER_MAX_PROFILE_ATTRS)

    p = await controllers.user.delete_user(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()
    four_fact_source_model.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_chat_buffer_recovers_original_operation_without_duplicate_facts(db_env, bounded_source_model):
    created = await controllers.user.create_user(res.UserData(), DEFAULT_PROJECT_ID)
    assert created.ok()
    user_id = created.data().id
    blob = res.BlobData(blob_type=BlobType.chat, blob_data={"messages": [{"role": "user", "content": "I am Gus"}]})
    inserted = await controllers.blob.insert_blob(user_id, DEFAULT_PROJECT_ID, blob)
    assert inserted.ok()
    assert (await controllers.buffer.insert_blob_to_buffer(user_id, DEFAULT_PROJECT_ID, inserted.data().id, blob.to_blob())).ok()
    extractor = bounded_source_model.side_effect
    bounded_source_model.side_effect = source.SourceError("model_unavailable", "Temporary model failure", 503, True)

    failed = await controllers.buffer.flush_buffer(user_id, DEFAULT_PROJECT_ID, BlobType.chat)
    assert not failed.ok()
    with Session() as session:
        accepted = session.execute(select(memory_operations).where(memory_operations.c.user_id == user_id,
            memory_operations.c.project_id == DEFAULT_PROJECT_ID, memory_operations.c.kind == "import")).mappings().one()
        operation_id = accepted["id"]
        assert accepted["status"] == "failed"
        assert session.execute(select(memory_facts.c.id).where(memory_facts.c.user_id == user_id)).all() == []
    pending = await controllers.buffer.get_unprocessed_buffer_ids(user_id, DEFAULT_PROJECT_ID, BlobType.chat,
        select_status=BufferStatus.failed)
    assert pending.ok() and len(pending.data().ids) == 1
    bounded_source_model.side_effect = extractor
    recovered = await controllers.buffer.flush_buffer_by_ids(user_id, DEFAULT_PROJECT_ID, BlobType.chat,
        pending.data().ids, select_status=BufferStatus.failed)
    assert recovered.ok()
    repeated = await controllers.buffer.flush_buffer_by_ids(user_id, DEFAULT_PROJECT_ID, BlobType.chat,
        pending.data().ids, select_status=BufferStatus.failed)
    assert repeated.ok()
    with Session() as session:
        accepted = session.execute(select(memory_operations).where(memory_operations.c.user_id == user_id,
            memory_operations.c.project_id == DEFAULT_PROJECT_ID, memory_operations.c.kind == "import")).mappings().one()
        assert accepted["id"] == operation_id and accepted["status"] == "completed"
        assert "messages" not in accepted["request"]
        assert len(session.execute(select(memory_facts.c.id).where(memory_facts.c.user_id == user_id)).all()) == 1
    bounded_source_model.assert_awaited()
    assert bounded_source_model.await_count == 2
    assert (await controllers.user.get_user_all_blobs(user_id, DEFAULT_PROJECT_ID, BlobType.chat)).data().ids == []
    assert (await controllers.user.delete_user(user_id, DEFAULT_PROJECT_ID)).ok()
