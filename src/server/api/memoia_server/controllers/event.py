# Modified for Memoia: relocated from the upstream memobase_server package.
import asyncio
from ..models.database import UserEvent, UserProfile
from ..models.response import UserEventsData, RetrievedContent
from ..models.source import Evidence, memory_facts, memory_blobs, memory_messages, memory_event_facts, memory_deleted_events
from ..models.utils import Promise, CODE
from ..connectors import Session, run_sql
from ..utils import get_encoded_tokens

from ..llms.embeddings import get_embedding
from datetime import timedelta, datetime, timezone
from dataclasses import dataclass
from uuid import UUID
from sqlalchemy import select, or_, literal_column, literal, union_all, exists, and_, case, cast, String
from sqlalchemy.sql import func
from ..env import TRACE_LOG, CONFIG
from .derived_impact import public_data

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
        created_at=fact["created_at"], updated_at=fact["updated_at"],
        fact_time=fact["fact_time"], source_messages=source_observations(fact["support_groups"],
            observations[(fact["user_id"], fact["project_id"], fact["source_id"])])) for fact in facts}


def event_view(session, event):
    return event_views(session, [event], user_id=event.user_id, project_id=event.project_id)[event.id]


def event_views(session, events, *, user_id, project_id):
    """Batch current evidence; delayed story text never validates stale support."""
    data = {}
    for event in events:
        if str(event.user_id) != str(user_id) or event.project_id != project_id:
            raise ValueError("Event owner mismatch")
        data[event.id] = public_data(event.event_data)
    if not data:
        return data
    from .maintenance import pending_derived_fact_ids
    linked_ids = select(cast(memory_event_facts.c.fact_id, String)).where(
        memory_event_facts.c.user_id == user_id, memory_event_facts.c.project_id == project_id,
        memory_event_facts.c.event_id.in_(data)).correlate(None)
    rows = session.execute(select(memory_facts, memory_blobs.c.source_id,
        memory_event_facts.c.event_id.label("linked_event_id")).join(
        memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).join(memory_event_facts, and_(
        memory_event_facts.c.fact_id == memory_facts.c.id,
        memory_event_facts.c.user_id == memory_facts.c.user_id,
        memory_event_facts.c.project_id == memory_facts.c.project_id)).where(
        memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id,
        memory_event_facts.c.event_id.in_(data),
        cast(memory_facts.c.id, String).notin_(pending_derived_fact_ids(user_id, project_id, linked_ids)))
        .order_by(memory_facts.c.id)).mappings().all()
    evidence = facts_evidence(session, {row["id"]: row for row in rows}.values())
    for entry in data.values():
        entry["evidence"], entry["fact_ids"] = [], []
    for row in rows:
        entry = data[row["linked_event_id"]]
        entry["evidence"].append(evidence[row["id"]].model_dump(mode="json"))
        entry["fact_ids"].append(str(row["id"]))
    return data


async def get_user_events(
    user_id: str,
    project_id: str,
    topk: int = 10,
    time_range_in_days: int = 21,
) -> Promise[UserEventsData]:
    def execute():
        with Session() as session:
            # Derived text, flush state and proof must describe one committed view.
            session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            query = (
                session.query(UserEvent)
                .filter_by(user_id=user_id, project_id=project_id)
                .filter(
                    UserEvent.created_at > (func.now() - timedelta(days=time_range_in_days))
                )
            )
            user_events = query.order_by(UserEvent.created_at.desc()).limit(topk).all()
            views = event_views(session, user_events, user_id=user_id, project_id=project_id)
            results = [
                {
                    "id": ue.id,
                    "event_data": views[ue.id],
                    "created_at": ue.created_at,
                    "updated_at": ue.updated_at,
                }
                for ue in user_events
            ]
        events = UserEventsData(events=results)
        return Promise.resolve(events)
    return await run_sql(execute)


async def delete_user_event(
    user_id: str, project_id: str, event_id: str
) -> Promise[None]:
    def execute():
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
    return await run_sql(execute)


@dataclass(frozen=True)
class RetrievedFact:
    """One ranked fact and its complete evidence; event identity is only an association."""
    event_id: UUID | None
    occurred_at: datetime
    score: float
    content: RetrievedContent
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
        memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id,
        eligible)
    if through_version is not None:
        fact_docs = fact_docs.where(memory_facts.c.created_version <= through_version)
    old_docs = select(
        UserEvent.id.label("id"), UserEvent.id.label("event_id"), literal("event").label("kind"),
        func.coalesce(UserEvent.event_data["event_tip"].astext, "").label("text"),
        UserEvent.embedding.label("embedding"),
    ).where(UserEvent.user_id == user_id, UserEvent.project_id == project_id,
        UserEvent.id.notin_(exclude_event_ids),
        UserEvent.event_data["blob_id"].astext.is_(None), ~UserEvent.event_data.has_key("memoia_v2"))
    documents = (union_all(fact_docs, old_docs) if include_events else fact_docs).subquery()
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
    lexical, embedding = await asyncio.gather(run_sql(read_lexical), read_query_vector())
    query_vector = None
    if embedding.ok():
        vectors = embedding.data()
        if vectors is not None:
            query_vector = vectors[0]
    elif embedding.code() not in {429, 500, 502, 503, 504}:
        return embedding
    else:
        TRACE_LOG.warning(project_id, user_id, "Search degraded to lexical retrieval")
    def read_ranked():
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
            event_ids = {rows[key]["event_id"] for key in ordered if rows[key]["event_id"] is not None}
            events = {row.id: row for row in session.scalars(select(UserEvent).where(
                UserEvent.id.in_(event_ids), UserEvent.user_id == user_id,
                UserEvent.project_id == project_id,
            ))} if event_ids else {}
            result = []
            fact_ids = [rows[key]["id"] for key in ordered if rows[key]["kind"] == "fact"]
            direct = {row["id"]: dict(row) for row in session.execute(select(memory_facts, memory_blobs.c.source_id)
                .join(memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
                memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id,
                memory_facts.c.id.in_(fact_ids))).mappings()} if fact_ids else {}
            direct_evidence = facts_evidence(session, direct.values())
            for key in ordered:
                if rows[key]["kind"] == "fact":
                    ident = rows[key]["id"]
                    row = direct.get(ident)
                    if row is None:
                        continue
                    evidence = direct_evidence[ident]
                    content = RetrievedContent(content=row["content"], fact_time=row["fact_time"],
                        source_id=row["source_id"], blob_id=row["blob_id"], fact_id=ident,
                        created_at=row["created_at"], updated_at=row["updated_at"],
                        source_messages=evidence.source_messages)
                    result.append(RetrievedFact(None, row["occurred_at"], scores[key], content, evidence))
                    continue
                parent = events.get(rows[key]["event_id"])
                if parent is None:
                    continue  # 删除／隐藏后的事件不能通过旧候选恢复。
                content = RetrievedContent(content=parent.event_data.get("event_tip", ""))
                result.append(RetrievedFact(parent.id, parent.created_at, scores[key], content))
            return Promise.resolve(result)
    return await run_sql(read_ranked)


def recent_user_facts(user_id, project_id, limit=100):
    with Session() as session:
        since = datetime.now(timezone.utc) - timedelta(days=360)
        rows = session.execute(select(memory_facts, memory_blobs.c.source_id).join(
            memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(
            memory_facts.c.user_id == user_id, memory_facts.c.project_id == project_id,
            memory_facts.c.occurred_at >= since)
            .order_by(memory_facts.c.occurred_at.desc(), memory_facts.c.id).limit(limit)).mappings().all()
        evidence = facts_evidence(session, rows)
        recent = [(row["occurred_at"], str(row["id"]), RetrievedContent(content=row["content"], fact_time=row["fact_time"],
            source_id=row["source_id"], blob_id=row["blob_id"], fact_id=row["id"],
            created_at=row["created_at"], updated_at=row["updated_at"],
            source_messages=evidence[row["id"]].source_messages)) for row in rows]
        # Preserve non-source legacy reads without letting pending V2 stories stand
        # in for valid Facts, exactly as the ranked retrieval fallback does.
        legacy = session.scalars(select(UserEvent).where(UserEvent.user_id == user_id,
            UserEvent.project_id == project_id, UserEvent.created_at >= since,
            UserEvent.event_data["blob_id"].astext.is_(None), ~UserEvent.event_data.has_key("memoia_v2"))
            .order_by(UserEvent.created_at.desc(), UserEvent.id).limit(limit))
        recent.extend((row.created_at, str(row.id), RetrievedContent(content=row.event_data.get("event_tip", "")))
                      for row in legacy)
        return [entry for _, _, entry in sorted(recent, key=lambda item: (-item[0].timestamp(), item[1]))[:limit]]


async def hybrid_search_user_events(user_id, project_id, query, limit=10, *, max_token_size=4000,
                                   exclude_fact_ids=(), exclude_event_ids=(), exclude_profile_ids=(),
                                   exclude_profile_topics=(), include_events=True, event_max_tokens=None,
                                   through_version=None, include_pending_derived=False):
    from ..models.source import SearchEvent, SearchFact, SearchProfile, SearchResult
    candidate_limit = min(500, max(50, limit * 5))
    result = await retrieve_user_facts(user_id, project_id, query, candidate_limit,
        exclude_fact_ids=exclude_fact_ids, exclude_event_ids=exclude_event_ids, separate_legacy=True,
        navigate_seen_facts=True, exclude_profile_ids=exclude_profile_ids,
        exclude_profile_topics=exclude_profile_topics, include_events=include_events, through_version=through_version)
    if not result.ok():
        return result
    def read_bundle():
        bundle = SearchResult(facts=[], events=[], profiles=[])

        def fits(candidate):
            return len(get_encoded_tokens(candidate.model_dump_json())) <= max_token_size

        if not fits(bundle):
            return Promise.reject(CODE.BAD_REQUEST, "Search budget is smaller than the empty response")
        legacy, scores = {}, {}
        for fact in result.data():
            if fact.content.fact_id is not None:
                if fact.content.fact_id in exclude_fact_ids:
                    scores[fact.content.fact_id] = fact.score
                    continue
                if len(bundle.facts) >= limit:
                    continue
                found = SearchFact(id=fact.content.fact_id, content=fact.content.content,
                    source_id=fact.content.source_id, blob_id=fact.content.blob_id, score=fact.score,
                    created_at=fact.content.created_at, updated_at=fact.content.updated_at,
                    occurred_at=fact.occurred_at, evidence=fact.evidence)
                if fits(bundle.model_copy(update={"facts": [*bundle.facts, found]})):
                    bundle.facts.append(found)
                    scores[found.id] = found.score
                continue
            legacy[fact.event_id] = fact.score
        related_profiles, related_events = [], []
        with Session() as session:
            # A flush may finish between reads; keep its text and proof atomic here.
            session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
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
            from .maintenance import pending_derived_fact_ids
            current_support = (literal(True) if include_pending_derived else
                cast(memory_facts.c.id, String).notin_(
                    pending_derived_fact_ids(user_id, project_id, list(map(str, needed)))))
            valid_statement = select(memory_facts, memory_blobs.c.source_id,
                current_support.label("derived_support_current")).join(
                memory_blobs, memory_facts.c.blob_id == memory_blobs.c.id).where(memory_facts.c.user_id == user_id,
                memory_facts.c.project_id == project_id, memory_facts.c.id.in_(needed))
            if through_version is not None:
                valid_statement = valid_statement.where(memory_facts.c.created_version <= through_version)
            valid = {row["id"]: dict(row) for row in session.execute(valid_statement).mappings()} if needed else {}
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
                    blob_id=row["blob_id"], score=found.score, occurred_at=row["occurred_at"],
                    created_at=row["created_at"], updated_at=row["updated_at"], evidence=evidence[found.id])
                if fits(bundle.model_copy(update={"facts": [*bundle.facts, current]})):
                    bundle.facts.append(current)
                    scores[current.id] = current.score
            event_refs = {}
            for event_id, fact_id in edges:
                if fact_id in valid and valid[fact_id]["derived_support_current"]:
                    event_refs.setdefault(event_id, set()).add(fact_id)
            candidates = []
            for row, score in related_profiles:
                refs = sorted((ident for ident in profile_refs[row.id] if ident in valid
                    and valid[ident]["derived_support_current"]), key=str)
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
                    title=data.get("title"), summary=data.get("summary"), keywords=data.get("keywords"), event_time=data.get("event_time"),
                    location=data.get("location"), interpretation=data.get("interpretation"), fact_ids=refs,
                    source_id=next(iter(sources)) if len(sources) == 1 else None,
                    blob_id=next(iter(blobs)) if len(blobs) == 1 else None, score=score, occurred_at=row.created_at,
                    evidence=[evidence[ident] for ident in refs])))
            if include_events and legacy:
                for row in session.scalars(select(UserEvent).where(UserEvent.user_id == user_id,
                        UserEvent.project_id == project_id, UserEvent.id.in_(legacy), UserEvent.id.notin_(exclude_event_ids))):
                    data, score = row.event_data, legacy[row.id]
                    candidates.append(("events", SearchEvent(id=row.id, content=data.get("event_tip") or "",
                        title=data.get("title"), summary=data.get("summary"), keywords=data.get("keywords"),
                        event_time=data.get("event_time"), location=data.get("location"), interpretation=data.get("interpretation"),
                        source_id=data.get("source_id"),
                        blob_id=data.get("blob_id"),
                        score=score, occurred_at=row.created_at, fact_ids=[], evidence=[])))
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
    return await run_sql(read_bundle)
