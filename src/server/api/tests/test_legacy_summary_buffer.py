# Modified for Memoia: use the renamed internal server package.
import pytest
from memoia_server import controllers
from memoia_server.models import response as res
from memoia_server.models.database import DEFAULT_PROJECT_ID
from memoia_server.models.blob import BlobType
from tests.maintenance_support import maintain


@pytest.mark.asyncio
async def test_summary_buffer_uses_fact_import_and_flush(
    db_env,
    four_fact_source_model,
):
    p = await controllers.user.create_user(res.UserData(), DEFAULT_PROJECT_ID)
    assert p.ok()
    u_id = p.data().id

    blob1 = res.BlobData(
        blob_type=BlobType.summary,
        blob_data={"summary": "User is a software engineer who works at Memobase...."},
    )
    blob2 = res.BlobData(
        blob_type=BlobType.summary,
        blob_data={"summary": "User is called Gus"},
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
        u_id, DEFAULT_PROJECT_ID, BlobType.summary
    )
    assert p.ok() and p.data() == 2

    flushed = await controllers.buffer.flush_buffer(u_id, DEFAULT_PROJECT_ID, BlobType.summary)
    assert flushed.ok()

    p = await controllers.profile.get_user_profiles(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and p.data().profiles == []
    p = await controllers.event.get_user_events(u_id, DEFAULT_PROJECT_ID)
    assert p.ok() and p.data().events == []
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
        u_id, DEFAULT_PROJECT_ID, BlobType.summary
    )
    assert p.ok() and p.data() == 0

    # persistent_chat_blobs default to True
    p = await controllers.user.get_user_all_blobs(
        u_id, DEFAULT_PROJECT_ID, BlobType.summary
    )
    assert p.ok() and len(p.data().ids) == 2

    p = await controllers.user.delete_user(u_id, DEFAULT_PROJECT_ID)
    assert p.ok()

    four_fact_source_model.assert_awaited_once()
