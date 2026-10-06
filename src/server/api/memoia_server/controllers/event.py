# Modified for Memoia: relocated from the upstream memobase_server package.
import asyncio
from pydantic import ValidationError
from ..models.database import UserEvent, UserEventGist
from ..models.response import UserEventData, UserEventsData, EventData, EventGistData
from ..models.source import Evidence
from ..models.utils import Promise, CODE
from ..connectors import Session
from ..utils import get_encoded_tokens, event_str_repr, event_embedding_str

from ..llms.embeddings import get_embedding
from datetime import timedelta, datetime
from dataclasses import dataclass
from uuid import UUID
from sqlalchemy import desc, select, or_, literal_column, literal, union_all, exists
from sqlalchemy.sql import func
from ..env import TRACE_LOG, CONFIG

QUERY_EMBEDDING_TIMEOUT_SECONDS = 8


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
                "event_data": ue.event_data,
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
    event_id: UUID
    occurred_at: datetime
    score: float
    gist: EventGistData
    evidence: Evidence | None = None


async def retrieve_user_facts(
    user_id: str, project_id: str, query: str, limit: int = 50,
) -> Promise[list[RetrievedFact]]:
    # 事实正文保持原样；新索引文本由写入者统一派生，旧 gist 直接读原正文。
    gist_text = func.coalesce(
        UserEventGist.gist_data["search_text"].astext,
        UserEventGist.gist_data["content"].astext, "",
    )
    gist_docs = select(
        UserEventGist.id.label("id"), UserEventGist.event_id.label("event_id"),
        literal("gist").label("kind"), gist_text.label("text"),
        UserEventGist.embedding.label("embedding"),
    ).where(UserEventGist.user_id == user_id, UserEventGist.project_id == project_id)
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
    ).where(UserEvent.user_id == user_id, UserEvent.project_id == project_id, ~has_gists)
    documents = union_all(gist_docs, old_docs).subquery()
    candidates = min(500, max(50, limit * 5))
    vector = func.to_tsvector(literal_column("'simple'"), documents.c.text)
    terms = func.websearch_to_tsquery(literal_column("'simple'"), query)
    identifiers = (documents.c.id, documents.c.event_id, documents.c.kind)
    lexical_statement = select(*identifiers).where(or_(
        vector.op("@@")(terms),
        func.lower(documents.c.text).contains(query.lower(), autoescape=True),
    )).order_by(func.ts_rank_cd(vector, terms).desc(), documents.c.id).limit(candidates)
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
            semantic = session.execute(
                select(*identifiers).where(documents.c.embedding.isnot(None), similarity > .2)
                .order_by(similarity.desc(), documents.c.id).limit(candidates)
            ).mappings().all()
        scores, rows = {}, {}
        for ranking in (lexical, semantic):
            for rank, row in enumerate(ranking, 1):
                rows[row["id"]] = row
                scores[row["id"]] = scores.get(row["id"], 0) + 1 / (60 + rank)
        ordered = sorted(scores, key=lambda key: (-scores[key], str(key)))[:limit]
        event_ids = {rows[key]["event_id"] for key in ordered}
        events = {row.id: row for row in session.scalars(select(UserEvent).where(
            UserEvent.id.in_(event_ids), UserEvent.user_id == user_id,
            UserEvent.project_id == project_id,
        ))}
        gist_ids = [key for key in ordered if rows[key]["kind"] == "gist"]
        gists = {row.id: row for row in session.scalars(select(UserEventGist).where(
            UserEventGist.id.in_(gist_ids), UserEventGist.user_id == user_id,
            UserEventGist.project_id == project_id,
        ))}
        result = []
        for key in ordered:
            parent = events.get(rows[key]["event_id"])
            if parent is None:
                continue  # 删除／隐藏后的事件不能通过旧候选恢复。
            evidence = None
            if rows[key]["kind"] == "gist":
                row = gists.get(key)
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


async def hybrid_search_user_events(user_id, project_id, query, limit=10):
    from ..models.source import SearchEvent, SearchResult
    from ..temporal import render_search_fact
    result = await retrieve_user_facts(user_id, project_id, query, limit)
    if not result.ok():
        return result
    # search 保留事件关联；context 直接使用同一有序事实，不经过事件分组再展开。
    groups = {}
    for fact in result.data():
        if fact.event_id not in groups:
            groups[fact.event_id] = SearchEvent(
                id=fact.event_id, content="", score=fact.score,
                source_id=fact.gist.source_id, blob_id=fact.gist.blob_id,
                occurred_at=fact.occurred_at, evidence=[],
            )
        row = groups[fact.event_id]
        text = render_search_fact(fact.gist.content, fact.gist.event_time)
        row.content = "\n".join(filter(None, [row.content, text]))
        if fact.evidence is not None:
            row.evidence.append(fact.evidence)
    return Promise.resolve(SearchResult(events=list(groups.values())))


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
                "event_data": ue.event_data,
                "created_at": ue.created_at,
                "updated_at": ue.updated_at,
            }
            for ue in user_events
        ]

    events = UserEventsData(events=results)
    return Promise.resolve(events)
