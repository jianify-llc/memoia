# Modified for Memoia: relocated from the upstream memobase_server package.
import asyncio
from pydantic import ValidationError
from ..models.database import UserEvent, UserEventGist, UserProfile
from ..models.response import UserEventData, UserEventsData, EventData, EventGistData
from ..models.source import Evidence, memory_facts, memory_blobs, memory_messages, memory_event_facts, memory_deleted_events
from ..models.utils import Promise, CODE
from ..connectors import Session
from ..utils import get_encoded_tokens, event_str_repr, event_embedding_str

from ..llms.embeddings import get_embedding
from datetime import timedelta, datetime, timezone
from dataclasses import dataclass
from uuid import UUID
from sqlalchemy import desc, select, or_, literal_column, literal, union_all, exists, and_, case, cast, String
from sqlalchemy.sql import func
from ..env import TRACE_LOG, CONFIG

QUERY_EMBEDDING_TIMEOUT_SECONDS = 8


def facts_evidence(session, facts):
    from ..temporal import source_observations
    facts = list(facts)
    needed = {}
    for fact in facts:
        owner = (fact["user_id"], fact["project_id"], fact["source_id"])
        needed.setdefault(owner, set()).update(mid for group in fact["support_groups"] for mid in group)
    predicates = [and_(memory_messages.c.user_id == uid, memory_messages.c.project_id == pid,
        memory_messages.c.source_id == sid, memory_messages.c.message_id.in_(mids))
        for (uid, pid, sid), mids in needed.items() if mids]
    observations = {owner: [] for owner in needed}
    if predicates:
        for row in session.execute(select(memory_messages).where(or_(*predicates),
                ~memory_messages.c.deleted)).mappings():
            observations[(row["user_id"], row["project_id"], row["source_id"])].append(row)
    return {fact["id"]: Evidence(fact_id=fact["id"], blob_id=fact["blob_id"], content=fact["content"],
        topic=fact["topic"], sub_topic=fact["sub_topic"], subject=fact["subject"], reporter=fact["reporter"],
        certainty=fact["certainty"], revision=fact["revision"], support_groups=fact["support_groups"],
        event_time=fact["event_time"], source_messages=source_observations(fact["support_groups"],
            observations[(fact["user_id"], fact["project_id"], fact["source_id"])])) for fact in facts}


def fact_evidence(session, fact):
    return facts_evidence(session, [fact])[fact["id"]]


def event_view(session, event):
    data = dict(event.event_data)
    linked = select(memory_event_facts.c.fact_id).where(
        memory_event_facts.c.user_id == event.user_id, memory_event_facts.c.project_id == event.project_id,
        memory_event_facts.c.event_id == event.id)
    rows = session.execute(select(memory_facts, memory_blobs.c.source_id).join(
        memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
        memory_facts.c.user_id == event.user_id, memory_facts.c.project_id == event.project_id,
        memory_facts.c.active, memory_facts.c.id.in_(linked))).mappings().all()
    # Text may be pending maintenance; evidence always comes from current facts.
    if data.get("blob_id") or data.get("memoia_v2") or data.get("evidence"):
        data["evidence"] = [entry.model_dump(mode="json") for entry in facts_evidence(session, rows).values()]
        data["fact_ids"] = [str(row["id"]) for row in rows]
    return data


async def get_user_events(
    user_id: str,
    project_id: str,
    topk: int = 10,
    need_summary: bool = False,
    time_range_in_days: int = 21,
) -> Promise[UserEventsData]:
    with Session() as session:
        query = (
            session.query(UserEvent)
            .filter_by(user_id=user_id, project_id=project_id)
            .filter(
                UserEvent.created_at > (func.now() - timedelta(days=time_range_in_days))
            )
        )
        # Abort this parameter because the summary is moved to gist
        # if need_summary:
        #     query = query.filter(
        #         UserEvent.event_data.contains({"event_tip": None}).is_(False)
        #     ).filter(UserEvent.event_data.has_key("event_tip"))
        user_events = query.order_by(UserEvent.created_at.desc()).limit(topk).all()
        if user_events is None:
            return Promise.resolve(UserEventsData(events=[]))
        results = [
            {
                "id": ue.id,
                "event_data": event_view(session, ue),
                "created_at": ue.created_at,
                "updated_at": ue.updated_at,
            }
            for ue in user_events
        ]
    events = UserEventsData(events=results)
    return Promise.resolve(events)


async def truncate_events(
    events: UserEventsData,
    max_token_size: int | None,
) -> Promise[UserEventsData]:
    if max_token_size is None:
        return Promise.resolve(events)
    c_tokens = 0
    truncated_results = []
    for r in events.events:
        c_tokens += len(get_encoded_tokens(event_str_repr(r)))
        if c_tokens > max_token_size:
            break
        truncated_results.append(r)
    events.events = truncated_results
    return Promise.resolve(events)


async def append_user_event(
    user_id: str, project_id: str, event_data: dict
) -> Promise[str]:
    try:
        validated_event = EventData(**event_data)
    except ValidationError as e:
        TRACE_LOG.error(
            project_id,
            user_id,
            f"Invalid event data: {str(e)}",
        )
        return Promise.reject(
            CODE.INTERNAL_SERVER_ERROR,
            f"Invalid event data: {str(e)}",
        )

    if CONFIG.enable_event_embedding:
        event_data_str = event_embedding_str(validated_event)
        embedding = await get_embedding(
            project_id,
            [event_data_str],
            phase="document",
            model=CONFIG.embedding_model,
        )
        if not embedding.ok():
            TRACE_LOG.error(
                project_id,
                user_id,
                f"Failed to get embeddings: {embedding.msg()}",
            )
            embedding = [None]
        else:
            embedding = embedding.data()
            embedding_dim_current = embedding.shape[-1]
            if embedding_dim_current != CONFIG.embedding_dim:
                TRACE_LOG.error(
                    project_id,
                    user_id,
                    f"Embedding dimension mismatch! Expected {CONFIG.embedding_dim}, got {embedding_dim_current}.",
                )
                embedding = [None]
    else:
        embedding = [None]

    event_gist_dbs = []
    if validated_event.event_tip is not None:
        event_gists = validated_event.event_tip.split("\n")
        event_gists = [l.strip() for l in event_gists if l.strip().startswith("-")]
        TRACE_LOG.info(
            project_id, user_id, f"Processing {len(event_gists)} event gists"
        )
        if CONFIG.enable_event_embedding and len(event_gists) > 0:
            event_gists_embedding = await get_embedding(
                project_id,
                event_gists,
                phase="document",
                model=CONFIG.embedding_model,
            )
            if not event_gists_embedding.ok():
                TRACE_LOG.error(
                    project_id,
                    user_id,
                    f"Failed to get embeddings: {event_gists_embedding.msg()}",
                )
                event_gists_embedding = [None] * len(event_gists)
            else:
                event_gists_embedding = event_gists_embedding.data()
        else:
            event_gists_embedding = [None] * len(event_gists)
        for event_gist, event_gist_embedding in zip(event_gists, event_gists_embedding):
            event_gist_dbs.append(
                {
                    "gist_data": {"content": event_gist},
                    "embedding": event_gist_embedding,
                }
            )
    with Session() as session:
        user_event = UserEvent(
            user_id=user_id,
            project_id=project_id,
            event_data=validated_event.model_dump(),
            embedding=embedding[0],
        )
        session.add(user_event)
        for event_gist_data in event_gist_dbs:
            session.add(
                UserEventGist(
                    user_id=user_id,
                    project_id=project_id,
                    event_id=user_event.id,
                    gist_data=event_gist_data["gist_data"],
                    embedding=event_gist_data["embedding"],
                )
            )
        session.commit()
        eid = user_event.id
    return Promise.resolve(eid)


async def delete_user_event(
    user_id: str, project_id: str, event_id: str
) -> Promise[None]:
    with Session() as session:
        user_event = (
            session.query(UserEvent)
            .filter_by(user_id=user_id, project_id=project_id, id=event_id)
            .first()
        )
        if user_event is None:
            return Promise.reject(
                CODE.NOT_FOUND,
                f"User event {event_id} not found",
            )
        from ..models.source import memory_blobs
        from sqlalchemy import update
        session.execute(update(memory_blobs).where(
            memory_blobs.c.user_id == user_id, memory_blobs.c.project_id == project_id,
            memory_blobs.c.event_id == event_id,
        ).values(event_deleted=True))
        from sqlalchemy.dialects.postgresql import insert
        session.execute(insert(memory_deleted_events).values(id=event_id, user_id=user_id, project_id=project_id)
            .on_conflict_do_nothing())
        session.delete(user_event)
        session.commit()
    return Promise.resolve(None)


async def update_user_event(
    user_id: str, project_id: str, event_id: str, event_data: dict
) -> Promise[None]:
    try:
        EventData(**event_data)
    except ValidationError as e:
        return Promise.reject(
            CODE.INTERNAL_SERVER_ERROR,
            f"Invalid event data: {str(e)}",
        )
    need_to_update = {k: v for k, v in event_data.items() if v is not None}
    with Session() as session:
        original = session.query(UserEvent).filter_by(user_id=user_id, project_id=project_id, id=event_id).one_or_none()
        if original is None:
            return Promise.reject(CODE.NOT_FOUND, "User event not found")
        previous = dict(original.event_data)
        previous_updated_at = original.updated_at
    new_events = {**previous, **need_to_update}
    content = new_events.get("event_tip") or ""
    gists = [line.strip().removeprefix("-").strip() for line in content.splitlines() if line.strip()]
    if CONFIG.enable_event_embedding and content:
        result = await get_embedding(project_id, [content, *gists])
        if not result.ok():
            return result
        vectors = list(result.data())
    else:
        vectors = [None] * (len(gists) + 1)
    with Session() as session:
        user_event = (
            session.query(UserEvent)
            .filter_by(user_id=user_id, project_id=project_id, id=event_id)
            .first()
        )
        if user_event is None:
            return Promise.reject(
                CODE.NOT_FOUND,
                f"User event {event_id} not found",
            )
        if user_event.updated_at != previous_updated_at:
            return Promise.reject(CODE.CONFLICT, "Event changed while indexes were calculated")
        user_event.event_data = new_events
        user_event.revision += 1
        user_event.embedding = vectors[0]
        session.query(UserEventGist).filter_by(user_id=user_id, project_id=project_id, event_id=event_id).delete(synchronize_session=False)
        for gist, vector in zip(gists, vectors[1:], strict=True):
            session.add(UserEventGist(user_id=user_id, project_id=project_id, event_id=event_id,
                                     gist_data={"content": gist}, embedding=vector))
        session.commit()
    return Promise.resolve(None)


@dataclass(frozen=True)
class RetrievedFact:
    """One ranked fact and its complete evidence; event identity is only an association."""
    event_id: UUID | None
    occurred_at: datetime
    score: float
    gist: EventGistData
    evidence: Evidence | None = None


async def retrieve_user_facts(
    user_id: str, project_id: str, query: str, limit: int = 50,
    *, exclude_fact_ids=(), exclude_event_ids=(), separate_legacy=False,
    navigate_seen_facts=False, exclude_profile_ids=(), exclude_profile_topics=(), include_events=True,
    through_version=None,
) -> Promise[list[RetrievedFact]]:
    # Direct fact indexes do not depend on a parent Event. Legacy non-source
    # events retain their old retrieval contract, never duplicated as V2 facts.
    eligible = memory_facts.c.id.notin_(exclude_fact_ids)
    if navigate_seen_facts and exclude_fact_ids:
        profile_link = exists(select(UserProfile.id).where(
            UserProfile.user_id == user_id, UserProfile.project_id == project_id,
            UserProfile.id.notin_(exclude_profile_ids),
            or_(UserProfile.attributes["topic"].astext.is_(None),
                UserProfile.attributes["topic"].astext.notin_(exclude_profile_topics)),
            UserProfile.attributes["fact_ids"].contains(func.jsonb_build_array(cast(memory_facts.c.id, String)))))
        links = [profile_link]
        if include_events:
            links.append(exists(select(memory_event_facts.c.event_id).join(UserEvent, and_(
                UserEvent.id == memory_event_facts.c.event_id,
                UserEvent.user_id == memory_event_facts.c.user_id,
                UserEvent.project_id == memory_event_facts.c.project_id)).where(
                memory_event_facts.c.user_id == user_id, memory_event_facts.c.project_id == project_id,
                memory_event_facts.c.fact_id == memory_facts.c.id,
                UserEvent.id.notin_(exclude_event_ids))))
        # A seen Fact is only a navigation anchor when it can reveal unseen memory.
        # Apply this before ranking; inert seen Facts cannot consume candidate slots.
        eligible = or_(eligible, or_(*links))
    fact_docs = select(memory_facts.c.id.label("id"),
        literal(None).cast(UserEvent.id.type).label("event_id"), literal("fact").label("kind"),
        func.coalesce(memory_facts.c.search_text, memory_facts.c.content).label("text"),
        memory_facts.c.embedding.label("embedding")).where(
        memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id, memory_facts.c.active,
        eligible)
    if through_version is not None:
        fact_docs = fact_docs.where(memory_facts.c.created_version <= through_version)
    gist_text = func.coalesce(
        UserEventGist.gist_data["search_text"].astext,
        UserEventGist.gist_data["content"].astext, "",
    )
    gist_docs = select(
        UserEventGist.id.label("id"), UserEventGist.event_id.label("event_id"),
        literal("gist").label("kind"), gist_text.label("text"),
        UserEventGist.embedding.label("embedding"),
    ).join(UserEvent, and_(UserEventGist.event_id == UserEvent.id, UserEventGist.project_id == UserEvent.project_id))
    gist_docs = gist_docs.where(UserEventGist.user_id == user_id, UserEventGist.project_id == project_id,
        UserEvent.user_id == user_id, UserEvent.project_id == project_id, UserEvent.id.notin_(exclude_event_ids),
        UserEventGist.gist_data["fact_id"].astext.is_(None), UserEvent.event_data["blob_id"].astext.is_(None),
        ~UserEvent.event_data.has_key("memoia_v2"))
    # 只有没有事实索引的旧事件使用整体文本；同一事件不混用两种粒度贡献排名。
    has_gists = exists(select(UserEventGist.id).where(
        UserEventGist.event_id == UserEvent.id,
        UserEventGist.project_id == UserEvent.project_id,
        UserEventGist.user_id == UserEvent.user_id,
    ))
    old_docs = select(
        UserEvent.id.label("id"), UserEvent.id.label("event_id"), literal("event").label("kind"),
        func.coalesce(UserEvent.event_data["event_tip"].astext, "").label("text"),
        UserEvent.embedding.label("embedding"),
    ).where(UserEvent.user_id == user_id, UserEvent.project_id == project_id, ~has_gists,
        UserEvent.id.notin_(exclude_event_ids),
        UserEvent.event_data["blob_id"].astext.is_(None), ~UserEvent.event_data.has_key("memoia_v2"))
    documents = union_all(fact_docs, gist_docs, old_docs).subquery()
    candidates = min(500, max(50, limit * 5))
    vector = func.to_tsvector(literal_column("'simple'"), documents.c.text)
    terms = func.websearch_to_tsquery(literal_column("'simple'"), query)
    identifiers = (documents.c.id, documents.c.event_id, documents.c.kind)
    lexical_statement = select(*identifiers).where(or_(
        vector.op("@@")(terms),
        func.lower(documents.c.text).contains(query.lower(), autoescape=True),
    ))

    def bounded_ranking(statement, score):
        if separate_legacy:
            pools = [statement.where(documents.c.kind == "fact", documents.c.id.notin_(exclude_fact_ids)),
                     statement.where(documents.c.kind != "fact")]
            if navigate_seen_facts and exclude_fact_ids:
                pools.append(statement.where(documents.c.kind == "fact", documents.c.id.in_(exclude_fact_ids)))
            # Navigation anchors and legacy stories never displace unseen Facts.
            return union_all(*(pool.order_by(score.desc(), documents.c.id).limit(candidates) for pool in pools))
        return statement.order_by(score.desc(), documents.c.id).limit(candidates)

    lexical_statement = bounded_ranking(lexical_statement, func.ts_rank_cd(vector, terms))
    def read_lexical():
        # Session 只在工作线程内存活；跨线程传递普通候选，不传 ORM 实体。
        with Session() as session:
            return [dict(row) for row in session.execute(lexical_statement).mappings().all()]

    async def read_query_vector():
        if not CONFIG.enable_event_embedding:
            return Promise.resolve(None)
        try:
            return await asyncio.wait_for(
                get_embedding(project_id, [query], phase="query", model=CONFIG.embedding_model),
                timeout=QUERY_EMBEDDING_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return Promise.reject(503, "Query embedding deadline exceeded")

    # 词法 SQL 与异步 HTTP 独立并行，不让模型等待挡住可用的词法证据。
    lexical, embedding = await asyncio.gather(asyncio.to_thread(read_lexical), read_query_vector())
    query_vector = None
    if embedding.ok():
        vectors = embedding.data()
        if vectors is not None:
            query_vector = vectors[0]
    elif embedding.code() not in {429, 500, 502, 503, 504}:
        return embedding
    else:
        TRACE_LOG.warning(project_id, user_id, "Search degraded to lexical retrieval")
    with Session() as session:
        semantic = []
        if query_vector is not None:
            similarity = 1 - documents.c.embedding.cosine_distance(query_vector)
            semantic = session.execute(bounded_ranking(
                select(*identifiers).where(documents.c.embedding.isnot(None), similarity > .2), similarity)).mappings().all()
        scores, rows = {}, {}
        for ranking in (lexical, semantic):
            ranks = {"fact": 0, "navigation": 0, "legacy": 0, "combined": 0}
            for row in ranking:
                pool = ("fact" if row["kind"] == "fact" else "legacy") if separate_legacy else "combined"
                if pool == "fact" and row["id"] in exclude_fact_ids:
                    pool = "navigation"
                ranks[pool] += 1
                key = (row["kind"], row["id"])
                rows[key] = row
                scores[key] = scores.get(key, 0) + 1 / (60 + ranks[pool])
        ordered = sorted(scores, key=lambda key: (-scores[key], str(key[1]), key[0]))
        if separate_legacy:
            ordered = ([key for key in ordered if rows[key]["kind"] == "fact" and key[1] not in exclude_fact_ids][:limit]
                + [key for key in ordered if rows[key]["kind"] == "fact" and key[1] in exclude_fact_ids][:limit]
                + [key for key in ordered if rows[key]["kind"] != "fact"][:limit])
        else:
            ordered = ordered[:limit]
        event_ids = {rows[key]["event_id"] for key in ordered}
        events = {row.id: row for row in session.scalars(select(UserEvent).where(
            UserEvent.id.in_(event_ids), UserEvent.user_id == user_id,
            UserEvent.project_id == project_id,
        ))}
        gist_ids = [rows[key]["id"] for key in ordered if rows[key]["kind"] == "gist"]
        gists = {row.id: row for row in session.scalars(select(UserEventGist).where(
            UserEventGist.id.in_(gist_ids), UserEventGist.user_id == user_id,
            UserEventGist.project_id == project_id,
        ))}
        result = []
        direct = {row["id"]: dict(row) for row in session.execute(select(memory_facts, memory_blobs.c.source_id)
            .join(memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
            memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id, memory_facts.c.active,
            memory_facts.c.id.in_([rows[key]["id"] for key in ordered if rows[key]["kind"] == "fact"]))).mappings()}
        direct_evidence = facts_evidence(session, direct.values())
        for key in ordered:
            if rows[key]["kind"] == "fact":
                ident = rows[key]["id"]
                row = direct.get(ident)
                if row is None:
                    continue
                evidence = direct_evidence[ident]
                gist = EventGistData(content=row["content"], event_time=row["event_time"],
                    source_id=row["source_id"], blob_id=row["blob_id"], fact_id=ident,
                    source_messages=evidence.source_messages)
                result.append(RetrievedFact(None, row["occurred_at"], scores[key], gist, evidence))
                continue
            parent = events.get(rows[key]["event_id"])
            if parent is None:
                continue  # 删除／隐藏后的事件不能通过旧候选恢复。
            evidence = None
            if rows[key]["kind"] == "gist":
                row = gists.get(rows[key]["id"])
                if row is None:
                    continue
                gist = EventGistData.model_validate(row.gist_data)
                fact_id = row.gist_data.get("fact_id")
                if fact_id is not None:
                    evidence = next((
                        Evidence.model_validate(f) for f in parent.event_data.get("evidence", [])
                        if str(f["fact_id"]) == str(fact_id)
                    ), None)
            else:
                gist = EventGistData(content=parent.event_data.get("event_tip", ""))
            result.append(RetrievedFact(parent.id, parent.created_at, scores[key], gist, evidence))
        return Promise.resolve(result)


def recent_user_facts(user_id, project_id, limit=100):
    with Session() as session:
        since = datetime.now(timezone.utc) - timedelta(days=360)
        rows = session.execute(select(memory_facts, memory_blobs.c.source_id).join(
            memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
            memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id, memory_facts.c.active,
            memory_facts.c.occurred_at >= since)
            .order_by(memory_facts.c.occurred_at.desc(), memory_facts.c.id).limit(limit)).mappings().all()
        evidence = facts_evidence(session, rows)
        recent = [(row["occurred_at"], str(row["id"]), EventGistData(content=row["content"], event_time=row["event_time"],
            source_id=row["source_id"], blob_id=row["blob_id"], fact_id=row["id"],
            source_messages=evidence[row["id"]].source_messages)) for row in rows]
        # Preserve non-source legacy reads without letting pending V2 stories stand
        # in for valid Facts, exactly as the ranked retrieval fallback does.
        legacy = session.scalars(select(UserEvent).where(UserEvent.user_id == user_id,
            UserEvent.project_id == project_id, UserEvent.created_at >= since,
            UserEvent.event_data["blob_id"].astext.is_(None), ~UserEvent.event_data.has_key("memoia_v2"))
            .order_by(UserEvent.created_at.desc(), UserEvent.id).limit(limit))
        recent.extend((row.created_at, str(row.id), EventGistData(content=row.event_data.get("event_tip", "")))
                      for row in legacy)
        return [entry for _, _, entry in sorted(recent, key=lambda item: (-item[0].timestamp(), item[1]))[:limit]]


async def hybrid_search_user_events(user_id, project_id, query, limit=10, *, max_token_size=4000,
                                   exclude_fact_ids=(), exclude_event_ids=(), exclude_profile_ids=(),
                                   exclude_profile_topics=(), include_events=True, event_max_tokens=None,
                                   through_version=None):
    from ..models.source import SearchEvent, SearchFact, SearchProfile, SearchResult
    from ..temporal import render_search_fact
    candidate_limit = min(500, max(50, limit * 5))
    result = await retrieve_user_facts(user_id, project_id, query, candidate_limit,
        exclude_fact_ids=exclude_fact_ids, exclude_event_ids=exclude_event_ids, separate_legacy=True,
        navigate_seen_facts=True, exclude_profile_ids=exclude_profile_ids,
        exclude_profile_topics=exclude_profile_topics, include_events=include_events, through_version=through_version)
    if not result.ok():
        return result
    bundle = SearchResult(facts=[], events=[], profiles=[])

    def fits(candidate):
        return len(get_encoded_tokens(candidate.model_dump_json())) <= max_token_size

    if not fits(bundle):
        return Promise.reject(CODE.BAD_REQUEST, "Search budget is smaller than the empty response")
    legacy, scores = {}, {}
    for fact in result.data():
        if fact.gist.fact_id is not None:
            if fact.gist.fact_id in exclude_fact_ids:
                scores[fact.gist.fact_id] = fact.score
                continue
            if len(bundle.facts) >= limit:
                continue
            found = SearchFact(id=fact.gist.fact_id, content=fact.gist.content,
                source_id=fact.gist.source_id, blob_id=fact.gist.blob_id, score=fact.score,
                occurred_at=fact.occurred_at, evidence=fact.evidence)
            if fits(bundle.model_copy(update={"facts": [*bundle.facts, found]})):
                bundle.facts.append(found)
                scores[found.id] = found.score
            continue
        group = legacy.setdefault(fact.event_id, {"score": fact.score, "content": [], "sources": set(), "blobs": set()})
        group["content"].append(render_search_fact(fact.gist.content, fact.gist.event_time))
        if fact.gist.source_id is not None:
            group["sources"].add(fact.gist.source_id)
        if fact.gist.blob_id is not None:
            group["blobs"].add(fact.gist.blob_id)
    related_profiles, related_events = [], []
    with Session() as session:
        if scores:
            profile_matches = [(UserProfile.attributes.contains({"fact_ids": [str(ident)]}), score)
                               for ident, score in scores.items()]
            profile_score = func.greatest(*(case((condition, score), else_=0) for condition, score in profile_matches))
            related_profiles = session.execute(select(UserProfile, profile_score.label("score")).where(
                UserProfile.user_id == user_id, UserProfile.project_id == project_id,
                UserProfile.id.notin_(exclude_profile_ids),
                or_(UserProfile.attributes["topic"].astext.is_(None),
                    UserProfile.attributes["topic"].astext.notin_(exclude_profile_topics)),
                or_(*(condition for condition, _ in profile_matches))
                )
                .order_by(profile_score.desc(), UserProfile.id).limit(candidate_limit)).all()
            if include_events:
                ranking = (select(memory_event_facts.c.event_id,
                    func.max(case(*[(memory_event_facts.c.fact_id == ident, score) for ident, score in scores.items()],
                                  else_=0)).label("score")).where(
                    memory_event_facts.c.user_id == user_id, memory_event_facts.c.project_id == project_id,
                    memory_event_facts.c.fact_id.in_(scores), memory_event_facts.c.event_id.notin_(exclude_event_ids))
                    .group_by(memory_event_facts.c.event_id).subquery())
                related_events = session.execute(select(UserEvent, ranking.c.score).join(
                    ranking, UserEvent.id == ranking.c.event_id).where(UserEvent.user_id == user_id,
                    UserEvent.project_id == project_id).order_by(ranking.c.score.desc(), UserEvent.id)
                    .limit(candidate_limit)).all()
        event_ids = [row.id for row, _ in related_events]
        edges = session.execute(select(memory_event_facts.c.event_id, memory_event_facts.c.fact_id).where(
            memory_event_facts.c.user_id == user_id, memory_event_facts.c.project_id == project_id,
            memory_event_facts.c.event_id.in_(event_ids))).all() if event_ids else []
        profile_refs = {}
        for row, _ in related_profiles:
            refs = set()
            for value in (row.attributes or {}).get("fact_ids", []):
                try:
                    refs.add(UUID(str(value)))
                except (ValueError, TypeError, AttributeError):
                    continue
            profile_refs[row.id] = refs
        needed = set(scores) | {ident for _, ident in edges} | {ident for refs in profile_refs.values() for ident in refs}
        valid_statement = select(memory_facts, memory_blobs.c.source_id).join(
            memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(memory_facts.c.user_id == user_id,
            memory_facts.c.project_id == project_id, memory_facts.c.active, memory_facts.c.id.in_(needed))
        if through_version is not None:
            valid_statement = valid_statement.where(memory_facts.c.created_version <= through_version)
        valid = {row["id"]: dict(row) for row in session.execute(valid_statement).mappings()}
        evidence = facts_evidence(session, valid.values())
        # Retrieval and association reads use short transactions. Recheck selected
        # Facts here so a deletion/correction between them cannot return old proof.
        selected = bundle.facts
        bundle.facts = []
        scores = {ident: score for ident, score in scores.items() if ident in exclude_fact_ids and ident in valid}
        for found in selected:
            row = valid.get(found.id)
            if row is None:
                continue
            current = SearchFact(id=found.id, content=row["content"], source_id=row["source_id"],
                blob_id=row["blob_id"], score=found.score, occurred_at=row["occurred_at"], evidence=evidence[found.id])
            if fits(bundle.model_copy(update={"facts": [*bundle.facts, current]})):
                bundle.facts.append(current)
                scores[current.id] = current.score
        event_refs = {}
        for event_id, fact_id in edges:
            if fact_id in valid:
                event_refs.setdefault(event_id, set()).add(fact_id)
        candidates = []
        for row, score in related_profiles:
            refs = sorted(profile_refs[row.id] & valid.keys(), key=str)
            if not refs or not scores.keys() & set(refs):
                continue
            attributes = row.attributes or {}
            candidates.append(("profiles", SearchProfile(id=row.id, content=row.content,
                topic=attributes.get("topic", ""), sub_topic=attributes.get("sub_topic", ""), fact_ids=refs,
                source_ids=sorted({valid[ident]["source_id"] for ident in refs}), score=score,
                created_at=row.created_at, updated_at=row.updated_at)))
        for row, score in related_events:
            refs = sorted(event_refs.get(row.id, set()), key=str)
            if not refs or not scores.keys() & set(refs):
                continue
            data = row.event_data
            sources = {valid[ident]["source_id"] for ident in refs}
            blobs = {valid[ident]["blob_id"] for ident in refs}
            candidates.append(("events", SearchEvent(id=row.id, content=data.get("content") or data.get("event_tip") or "",
                title=data.get("title"), summary=data.get("summary"), keywords=data.get("keywords"), time=data.get("time"),
                location=data.get("location"), interpretation=data.get("interpretation"), fact_ids=refs,
                source_id=next(iter(sources)) if len(sources) == 1 else None,
                blob_id=next(iter(blobs)) if len(blobs) == 1 else None, score=score, occurred_at=row.created_at,
                evidence=[evidence[ident] for ident in refs])))
        if legacy:
            for row in session.scalars(select(UserEvent).where(UserEvent.user_id == user_id,
                    UserEvent.project_id == project_id, UserEvent.id.in_(legacy), UserEvent.id.notin_(exclude_event_ids))):
                data, group = row.event_data, legacy[row.id]
                candidates.append(("events", SearchEvent(id=row.id, content="\n".join(group["content"]),
                    title=data.get("title"), summary=data.get("summary"), keywords=data.get("keywords"),
                    time=data.get("time"), location=data.get("location"), interpretation=data.get("interpretation"),
                    source_id=data.get("source_id") or (next(iter(group["sources"])) if len(group["sources"]) == 1 else None),
                    blob_id=data.get("blob_id") or (next(iter(group["blobs"])) if len(group["blobs"]) == 1 else None),
                    score=group["score"], occurred_at=row.created_at, fact_ids=[], evidence=[])))
    # Fact priority is fixed. Associated objects share the remainder, ordered by
    # their strongest selected Fact (legacy has its independent retrieval score).
    event_tokens = 0
    for collection, entry in sorted(candidates, key=lambda item: (-item[1].score, item[0], str(item[1].id))):
        existing = getattr(bundle, collection)
        if len(existing) >= limit or any(item.id == entry.id for item in existing):
            continue
        size = len(get_encoded_tokens(entry.model_dump_json()))
        if collection == "events" and event_max_tokens is not None and event_tokens + size > event_max_tokens:
            continue
        if fits(bundle.model_copy(update={collection: [*existing, entry]})):
            existing.append(entry)
            if collection == "events":
                event_tokens += size
    return Promise.resolve(bundle)


async def filter_user_events(
    user_id: str,
    project_id: str,
    has_event_tag: list[str] = None,
    event_tag_equal: dict[str, str] = None,
    topk: int = 10,
) -> Promise[UserEventsData]:
    """
    Filter user events based on event tags.

    Args:
        user_id: User ID
        project_id: Project ID
        has_event_tag: List of tag names that must exist in the event (regardless of value)
        event_tag_equal: Dict of tag_name: tag_value pairs that must match exactly
        topk: Maximum number of events to return

    Returns:
        Promise containing filtered UserEventsData
    """
    with Session() as session:
        query = session.query(UserEvent).filter_by(
            user_id=user_id, project_id=project_id
        )

        # Apply tag filters if provided
        if has_event_tag or event_tag_equal:
            # Build filter conditions for events that have event_tags
            query = query.filter(UserEvent.event_data.has_key("event_tags"))
            query = query.filter(UserEvent.event_data["event_tags"].isnot(None))

            # Filter by tag existence (has_event_tag)
            if has_event_tag:
                for tag_name in has_event_tag:
                    # Check if any event_tag in the array has the specified tag name
                    query = query.filter(
                        UserEvent.event_data["event_tags"].op("@>")(
                            f'[{{"tag": "{tag_name}"}}]'
                        )
                    )

            # Filter by exact tag-value pairs (event_tag_equal)
            if event_tag_equal:
                for tag_name, tag_value in event_tag_equal.items():
                    # Check if any event_tag in the array has both the tag name and value
                    query = query.filter(
                        UserEvent.event_data["event_tags"].op("@>")(
                            f'[{{"tag": "{tag_name}", "value": "{tag_value}"}}]'
                        )
                    )

        user_events = query.order_by(UserEvent.created_at.desc()).limit(topk).all()

        if user_events is None:
            return Promise.resolve(UserEventsData(events=[]))

        results = [
            {
                "id": ue.id,
                "event_data": event_view(session, ue),
                "created_at": ue.created_at,
                "updated_at": ue.updated_at,
            }
            for ue in user_events
        ]

    events = UserEventsData(events=results)
    return Promise.resolve(events)
