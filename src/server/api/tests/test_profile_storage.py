"""Profile storage reads committed PostgreSQL state without a Redis dependency."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from redis.exceptions import ConnectionError

from memoia_server.connectors import Session, get_redis_client
from memoia_server.controllers import profile, user
from memoia_server.env import Config
from memoia_server.models.database import DEFAULT_PROJECT_ID, User, UserProfile
from memoia_server.models.response import UserData


ATTRIBUTES = {"topic": "basic_info", "sub_topic": "name"}


def test_obsolete_profile_cache_setting_does_not_prevent_startup(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MEMOBASE_LLM_API_KEY", "profile-config-test-key")
    monkeypatch.setenv("MEMOBASE_CACHE_USER_PROFILES_TTL", "invalid-unused-ttl")
    (tmp_path / "config.yaml").write_text("language: zh\ncache_user_profiles_ttl: 1200\n")

    config = Config.load_config()
    assert config.language == "zh"
    assert not hasattr(config, "cache_user_profiles_ttl")
    assert "cache_user_profiles_ttl" not in Config._process_env_vars({})


@pytest_asyncio.fixture
async def profile_user(db_env):
    created = await user.create_user(UserData(), DEFAULT_PROJECT_ID)
    assert created.ok()
    user_id = str(created.data().id)
    try:
        yield user_id
    finally:
        with Session() as session:
            stored = (
                session.query(User)
                .filter_by(id=user_id, project_id=DEFAULT_PROJECT_ID)
                .one_or_none()
            )
            if stored is not None:
                session.delete(stored)
                session.commit()


@pytest.mark.asyncio
async def test_profile_read_ignores_stale_redis_and_preserves_contract(profile_user):
    added = await profile.add_user_profiles(
        profile_user, DEFAULT_PROJECT_ID, ["old", "second"], [ATTRIBUTES] * 2
    )
    assert added.ok()
    original = await profile.get_user_profiles(profile_user, DEFAULT_PROJECT_ID)
    cache_key = f"user_profiles::{DEFAULT_PROJECT_ID}::{profile_user}"
    stale_json = original.data().model_dump_json()
    redis = get_redis_client()
    await redis.set(cache_key, stale_json, ex=60)
    try:
        now = datetime.now(timezone.utc)
        with Session() as session:
            for index, profile_id in enumerate(added.data().ids):
                stored = session.query(UserProfile).filter_by(id=str(profile_id)).one()
                stored.content = f"committed-{index}"
                stored.updated_at = now + timedelta(seconds=index)
            session.commit()

        result = await profile.get_user_profiles(profile_user, DEFAULT_PROJECT_ID)
        assert result.ok()
        assert [p.content for p in result.data().profiles] == ["committed-1", "committed-0"]
        assert [str(p.id) for p in result.data().profiles] == [
            str(p) for p in reversed(added.data().ids)
        ]
        assert all(p.attributes == ATTRIBUTES for p in result.data().profiles)
        assert all(p.created_at and p.updated_at for p in result.data().profiles)
        other_project = await profile.get_user_profiles(profile_user, "other-project")
        other_user = await profile.get_user_profiles(str(uuid4()), DEFAULT_PROJECT_ID)
        assert other_project.ok() and not other_project.data().profiles
        assert other_user.ok() and not other_user.data().profiles
        assert await redis.get(cache_key) == stale_json
    finally:
        await redis.delete(cache_key)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation", ["read", "add", "update", "delete", "delete_many", "merge", "delete_user"]
)
async def test_profile_read_and_mutations_do_not_require_redis(
    profile_user, monkeypatch, operation
):
    added = await profile.add_user_profiles(
        profile_user, DEFAULT_PROJECT_ID, ["first", "second"], [ATTRIBUTES] * 2
    )
    assert added.ok()
    first, second = [str(p) for p in added.data().ids]
    unavailable = AsyncMock(side_effect=ConnectionError("Redis unavailable"))
    monkeypatch.setattr(Redis, "execute_command", unavailable)

    if operation == "read":
        result = await profile.get_user_profiles(profile_user, DEFAULT_PROJECT_ID)
        expected = {"first", "second"}
    elif operation == "add":
        result = await profile.add_user_profiles(
            profile_user, DEFAULT_PROJECT_ID, ["third"], [ATTRIBUTES]
        )
        expected = {"first", "second", "third"}
    elif operation == "update":
        result = await profile.update_user_profiles(
            profile_user, DEFAULT_PROJECT_ID, [first], ["updated"], [None]
        )
        expected = {"updated", "second"}
    elif operation == "delete":
        result = await profile.delete_user_profile(profile_user, DEFAULT_PROJECT_ID, first)
        expected = {"second"}
    elif operation == "delete_many":
        result = await profile.delete_user_profiles(
            profile_user, DEFAULT_PROJECT_ID, [first, second]
        )
        expected = set()
    elif operation == "merge":
        result = await profile.add_update_delete_user_profiles(
            profile_user,
            DEFAULT_PROJECT_ID,
            ["third"],
            [ATTRIBUTES],
            [first],
            ["updated"],
            [None],
            [second],
        )
        expected = {"updated", "third"}
    else:
        result = await user.delete_user(profile_user, DEFAULT_PROJECT_ID)
        expected = set()

    assert result.ok()
    current = await profile.get_user_profiles(profile_user, DEFAULT_PROJECT_ID)
    assert current.ok()
    assert {p.content for p in current.data().profiles} == expected
    unavailable.assert_not_awaited()
