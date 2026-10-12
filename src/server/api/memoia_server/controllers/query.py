"""Independent, pre-filtered read pools. No writes, mixed-bundle slicing or model routing."""
import asyncio
from uuid import UUID
from sqlalchemy import select, func, literal_column, or_, exists, and_
from ..connectors import Session
from ..env import CONFIG
from ..models.database import UserEvent, UserProfile
from ..models.source import memory_facts as facts, memory_blobs as blobs, memory_event_facts as edges, SearchFact, SearchProfile
from ..models.query import QueriedFacts, QueriedEvents, QueriedProfiles, QueriedEvent
from ..utils import get_encoded_tokens
from .event import get_embedding, QUERY_EMBEDDING_TIMEOUT_SECONDS, facts_evidence, event_views
from .source import SourceError


def _period(column, body):
    conditions = []
    if body.event_after is not None:
        conditions.append(column["end"].astext >= body.event_after.isoformat())
    if body.event_before is not None:
        conditions.append(column["start"].astext <= body.event_before.isoformat())
    return conditions


def _identity(column, body):
    conditions = [column.notin_(body.exclude_ids)]
    if body.ids:
        conditions.append(column.in_(body.ids))
    return conditions


async def _rank(statement, identifier, content, timestamp, embedding_column, project_id, body):
    # The caller constructs a scoped, fully filtered pool before this bounded ranking.
    candidates = min(500, max(50, body.limit * 5))
    def read_ids(query):
        with Session() as session:
            return list(session.scalars(query))
    if body.query is None:
        ids = await asyncio.to_thread(read_ids, statement.order_by(timestamp.desc(), identifier).limit(candidates))
        return [(ident, 0.0) for ident in ids]
    vector = func.to_tsvector(literal_column("'simple'"), content)
    terms = func.websearch_to_tsquery(literal_column("'simple'"), body.query)
    lexical = statement.where(or_(vector.op("@@")(terms), func.lower(content).contains(body.query.lower(), autoescape=True)))

    def read_lexical():
        with Session() as session:
            return list(session.scalars(lexical.order_by(func.ts_rank_cd(vector, terms).desc(), identifier).limit(candidates)))

    async def read_vector():
        if embedding_column is None or not CONFIG.enable_event_embedding:
            return None
        try:
            result = await asyncio.wait_for(get_embedding(project_id, [body.query], phase="query", model=CONFIG.embedding_model),
                                            timeout=QUERY_EMBEDDING_TIMEOUT_SECONDS)
        except TimeoutError:
            return None
        if result.ok():
            values = result.data()
            return values[0] if values is not None else None
        if result.code() not in {429, 500, 502, 503, 504}:
            raise SourceError("query_configuration", "Query provider configuration rejected", 422)
        return None

    lexical_ids, query_vector = await asyncio.gather(asyncio.to_thread(read_lexical), read_vector())
    semantic = []
    if query_vector is not None:
        similarity = 1 - embedding_column.cosine_distance(query_vector)
        semantic = await asyncio.to_thread(read_ids, statement.where(embedding_column.isnot(None), similarity > .2)
                .order_by(similarity.desc(), identifier).limit(candidates))
    scores = {}
    for ranking in [lexical_ids, semantic]:
        for position, ident in enumerate(ranking, 1):
            scores[ident] = scores.get(ident, 0) + 1 / (60 + position)
    return sorted(scores.items(), key=lambda item: (-item[1], str(item[0])))


def _complete_response(model, field, candidates, body):
    result = model(**{field: []})
    if len(get_encoded_tokens(result.model_dump_json())) > body.max_token_size:
        raise SourceError("query_budget_too_small", "Query budget cannot fit an empty result", 422)
    for entry in candidates:
        proposed = result.model_copy(update={field: [*getattr(result, field), entry]})
        if len(get_encoded_tokens(proposed.model_dump_json())) > body.max_token_size:
            continue
        result = proposed
        if len(getattr(result, field)) >= body.limit:
            break
    return result


async def query_facts(user_id, project_id, body):
    pool = select(facts.c.id).join(blobs, facts.c.blob_id == blobs.c.id).where(facts.c.user_id == user_id,
        facts.c.project_id == project_id, facts.c.active, *_identity(facts.c.id, body), *_period(facts.c.event_time, body))
    if body.source_ids:
        pool = pool.where(blobs.c.source_id.in_(body.source_ids))
    if body.recorded_after is not None:
        pool = pool.where(facts.c.occurred_at >= body.recorded_after)
    if body.recorded_before is not None:
        pool = pool.where(facts.c.occurred_at <= body.recorded_before)
    ranking = await _rank(pool, facts.c.id, func.coalesce(facts.c.search_text, facts.c.content),
                          facts.c.occurred_at, facts.c.embedding, project_id, body)
    with Session() as session:
        rows = {row["id"]: row for row in session.execute(select(facts, blobs.c.source_id)
            .join(blobs, facts.c.blob_id == blobs.c.id).where(facts.c.id.in_(pool.where(facts.c.id.in_([ident for ident, _ in ranking]))),
                facts.c.user_id == user_id, facts.c.project_id == project_id, facts.c.active)).mappings()}
        evidence = facts_evidence(session, rows.values())
        candidates = [SearchFact(id=ident, content=rows[ident]["content"], source_id=rows[ident]["source_id"],
            blob_id=rows[ident]["blob_id"], score=score, occurred_at=rows[ident]["occurred_at"], evidence=evidence[ident])
            for ident, score in ranking if ident in rows]
    return _complete_response(QueriedFacts, "facts", candidates, body)


async def query_events(user_id, project_id, body):
    pool = select(UserEvent.id).where(UserEvent.user_id == user_id, UserEvent.project_id == project_id,
                                     *_identity(UserEvent.id, body))
    if body.created_after is not None:
        pool = pool.where(UserEvent.created_at >= body.created_after)
    if body.created_before is not None:
        pool = pool.where(UserEvent.created_at <= body.created_before)
    if body.fact_ids or body.event_after is not None or body.event_before is not None:
        related = select(edges.c.fact_id).join(facts, and_(edges.c.fact_id == facts.c.id,
            edges.c.user_id == facts.c.user_id, edges.c.project_id == facts.c.project_id)).where(
            edges.c.event_id == UserEvent.id, edges.c.user_id == user_id, edges.c.project_id == project_id,
            facts.c.active, *_period(facts.c.event_time, body))
        if body.fact_ids:
            related = related.where(facts.c.id.in_(body.fact_ids))
        pool = pool.where(exists(related))
    content = func.concat_ws(" ", *(UserEvent.event_data[key].astext for key in ["title", "summary", "keywords", "content", "event_tip"]))
    ranking = await _rank(pool, UserEvent.id, content, UserEvent.created_at, UserEvent.embedding, project_id, body)
    def read():
        with Session() as session:
            def candidates():
                # Hydrate only small ranked pages. The budget consumer stops the
                # generator when full, or skips an oversized *complete* entry.
                for start in range(0, len(ranking), 20):
                    page = ranking[start:start + 20]
                    rows = {row.id: row for row in session.scalars(select(UserEvent).where(
                        UserEvent.id.in_(pool.where(UserEvent.id.in_([ident for ident, _ in page]))),
                        UserEvent.user_id == user_id, UserEvent.project_id == project_id))}
                    views = event_views(session, rows.values(), user_id=user_id, project_id=project_id,
                                        include_fact_links=True)
                    for ident, score in page:
                        if ident in rows:
                            row = rows[ident]
                            yield QueriedEvent(id=ident, score=score, created_at=row.created_at,
                                updated_at=row.updated_at, event_data=views[ident])
            return _complete_response(QueriedEvents, "events", candidates(), body)
    return await asyncio.to_thread(read)


async def query_profiles(user_id, project_id, body):
    pool = select(UserProfile.id).where(UserProfile.user_id == user_id, UserProfile.project_id == project_id,
                                       *_identity(UserProfile.id, body))
    if body.topic is not None:
        pool = pool.where(UserProfile.attributes["topic"].astext == body.topic)
    if body.sub_topic is not None:
        pool = pool.where(UserProfile.attributes["sub_topic"].astext == body.sub_topic)
    content = func.concat_ws(" ", UserProfile.content, UserProfile.attributes["topic"].astext, UserProfile.attributes["sub_topic"].astext)
    ranking = await _rank(pool, UserProfile.id, content, UserProfile.updated_at, None, project_id, body)
    def read():
        with Session() as session:
            def candidates():
                for start in range(0, len(ranking), 20):
                    page = ranking[start:start + 20]
                    rows = {row.id: row for row in session.scalars(select(UserProfile).where(
                        UserProfile.id.in_(pool.where(UserProfile.id.in_([ident for ident, _ in page]))),
                        UserProfile.user_id == user_id, UserProfile.project_id == project_id))}
                    refs = {}
                    for ident, row in rows.items():
                        refs[ident] = set()
                        for value in (row.attributes or {}).get("fact_ids", []):
                            try:
                                refs[ident].add(UUID(value))
                            except (ValueError, TypeError, AttributeError):
                                continue
                    all_refs = set().union(*refs.values())
                    valid = dict(session.execute(select(facts.c.id, blobs.c.source_id).join(blobs, facts.c.blob_id == blobs.c.id)
                        .where(facts.c.id.in_(all_refs), facts.c.active, facts.c.user_id == user_id,
                               facts.c.project_id == project_id)).all()) if all_refs else {}
                    for ident, score in page:
                        if ident not in rows:
                            continue
                        row = rows[ident]
                        attributes = row.attributes or {}
                        fact_ids = sorted(refs[ident].intersection(valid), key=str)
                        yield SearchProfile(id=ident, content=row.content, topic=attributes.get("topic") or "",
                            sub_topic=attributes.get("sub_topic") or "", fact_ids=fact_ids,
                            source_ids=sorted({valid[fid] for fid in fact_ids}), score=score,
                            created_at=row.created_at, updated_at=row.updated_at)
            return _complete_response(QueriedProfiles, "profiles", candidates(), body)
    return await asyncio.to_thread(read)
