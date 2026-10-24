# Modified for Memoia: relocated from the upstream memobase_server package.
from pydantic import ValidationError
from ..models.utils import Promise
from ..models.database import UserProfile
from ..models.response import CODE, IdsData, UserProfilesData, ProfileAttributes
from ..connectors import Session, run_sql
from ..env import TRACE_LOG
from .derived_impact import IMPACT_KEY, public_data


def _profile_attributes(supplied, previous=None):
    reserved = {"memoia_v2", "fact_ids", "source_ids", IMPACT_KEY}
    attributes = {key: value for key, value in supplied.items() if key not in reserved}
    if previous and previous.get("memoia_v2"):
        attributes.update({key: previous[key] for key in reserved if key in previous})
    if previous is None:
        attributes[IMPACT_KEY] = []  # A new, purely manual entry has no inferred influence.
    elif IMPACT_KEY in previous:
        attributes[IMPACT_KEY] = previous[IMPACT_KEY]
    return attributes


async def get_user_profiles(user_id: str, project_id: str) -> Promise[UserProfilesData]:
    def execute():
        from sqlalchemy import select, cast, String
        from ..models.source import memory_facts, memory_blobs
        from .maintenance import pending_derived_fact_ids
        with Session() as session:
            session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            user_profiles = (
                session.query(UserProfile)
                .filter_by(user_id=user_id, project_id=project_id)
                .order_by(UserProfile.updated_at.desc(), UserProfile.id)
                .all()
            )
            # Validate only evidence referenced by these profiles, not all user facts.
            from uuid import UUID
            referenced = set()
            for row in user_profiles:
                for value in (row.attributes or {}).get("fact_ids", []):
                    try:
                        referenced.add(UUID(value))
                    except (ValueError, TypeError, AttributeError):
                        continue
            valid_facts = {str(fid): sid for fid, sid in session.execute(select(
                memory_facts.c.id, memory_blobs.c.source_id).join(
                memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
                memory_facts.c.id.in_(referenced), memory_facts.c.user_id == user_id,
                memory_facts.c.project_id == project_id,
                cast(memory_facts.c.id, String).notin_(pending_derived_fact_ids(
                    user_id, project_id, list(map(str, referenced))))))} if referenced else {}
            results = []
            for up in user_profiles:
                attributes = public_data(up.attributes)
                if "fact_ids" in attributes:
                    # Pending derived text remains visible by contract; invalid Fact
                    # references are not returned as evidence for that old text.
                    attributes["fact_ids"] = [fid for fid in attributes.get("fact_ids", []) if fid in valid_facts]
                    attributes["source_ids"] = sorted({valid_facts[fid] for fid in attributes["fact_ids"]})
                results.append(
                    {
                        "id": up.id,
                        "content": up.content,
                        "attributes": attributes,
                        "created_at": up.created_at,
                        "updated_at": up.updated_at,
                    }
                )
        return Promise.resolve(UserProfilesData(profiles=results))
    return await run_sql(execute)


async def add_user_profiles(
    user_id: str,
    project_id: str,
    profiles: list[str],
    attributes: list[dict],
) -> Promise[IdsData]:
    def execute():
        assert len(profiles) == len(
            attributes
        ), "Length of profiles, attributes must be equal"
        for attr in attributes:
            try:
                ProfileAttributes.model_validate(attr)
            except ValidationError as e:
                return Promise.reject(
                    CODE.SERVER_PARSE_ERROR, f"Invalid profile attributes: {e}"
                )
        with Session() as session:
            db_profiles = [
                UserProfile(
                    user_id=user_id, project_id=project_id, content=content, attributes=_profile_attributes(attr)
                )
                for content, attr in zip(profiles, attributes)
            ]
            session.add_all(db_profiles)
            session.commit()
            profile_ids = [profile.id for profile in db_profiles]
        return Promise.resolve(IdsData(ids=profile_ids))
    return await run_sql(execute)


async def update_user_profiles(
    user_id: str,
    project_id: str,
    profile_ids: list[str],
    contents: list[str],
    attributes: list[dict | None],
) -> Promise[IdsData]:
    def execute():
        assert len(profile_ids) == len(
            contents
        ), "Length of profile_ids, contents must be equal"
        assert len(profile_ids) == len(
            attributes
        ), "Length of profile_ids, attributes must be equal"
        with Session() as session:
            db_profiles = []
            existing = {str(row.id): row for row in session.query(UserProfile).filter(
                UserProfile.id.in_(profile_ids), UserProfile.user_id == user_id,
                UserProfile.project_id == project_id).order_by(UserProfile.id).with_for_update()}
            for profile_id, content, attribute in zip(profile_ids, contents, attributes):
                db_profile = existing.get(str(profile_id))
                if db_profile is None:
                    TRACE_LOG.error(
                        project_id,
                        user_id,
                        f"Profile {profile_id} not found",
                    )
                    continue
                db_profile.content = content
                db_profile.revision += 1
                if attribute is not None:
                    # Client edits cannot strip the evidence needed by a later withdrawal.
                    db_profile.attributes = _profile_attributes(attribute, db_profile.attributes or {})
                db_profiles.append(profile_id)
            session.commit()
        return Promise.resolve(IdsData(ids=db_profiles))
    return await run_sql(execute)


async def delete_user_profile(
    user_id: str, project_id: str, profile_id: str
) -> Promise[None]:
    def execute():
        with Session() as session:
            db_profile = (
                session.query(UserProfile)
                .filter_by(id=profile_id, user_id=user_id, project_id=project_id)
                .one_or_none()
            )
            if db_profile is None:
                return Promise.reject(
                    CODE.NOT_FOUND, f"Profile {profile_id} not found for user {user_id}"
                )
            session.delete(db_profile)
            session.commit()
        return Promise.resolve(None)
    return await run_sql(execute)
