"""Explicit, bounded repair of missing Event vectors; never replay a model Loop."""


async def backfill(project_id, user_id, *, limit=100, after=None, apply=False):
    from sqlalchemy import select, update
    from .connectors import Session
    from .env import CONFIG
    from .models.database import UserEvent
    from .models.response import EventData
    from .llms.embeddings import get_embedding
    from .utils import event_embedding_str
    from .controllers.source import SourceError, lock_user_identity

    if not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    if apply and not CONFIG.enable_event_embedding:
        raise ValueError("Event embedding is disabled")
    with Session() as session:
        statement = select(UserEvent).where(UserEvent.project_id == project_id,
            UserEvent.user_id == user_id, UserEvent.embedding.is_(None))
        if after is not None:
            statement = statement.where(UserEvent.id > after)
        rows = list(session.scalars(statement.order_by(UserEvent.id).limit(limit)))
        pending = [(row.id, row.revision, row.updated_at, event_embedding_str(EventData(**row.event_data)))
                   for row in rows]
    result = {"scanned": len(rows), "updated": 0, "skipped": 0,
              "last_id": str(rows[-1].id) if rows else None}
    if not apply or not pending:
        return result
    nonempty = [entry for entry in pending if entry[3].strip()]
    result["skipped"] = len(pending) - len(nonempty)
    vectors = await get_embedding(project_id, [entry[3] for entry in nonempty], phase="document")
    if not vectors.ok():
        raise SourceError("event_embedding_failed", "Event index generation failed", vectors.code())
    with Session.begin() as session:
        lock_user_identity(session, user_id, project_id)
        for (ident, revision, updated_at, _), vector in zip(nonempty, vectors.data(), strict=True):
            # Index-only repair does not change content, timestamps or revision.
            # Concurrent edit/delete wins; this command never inserts a row.
            result["updated"] += session.execute(update(UserEvent).where(
                UserEvent.id == ident, UserEvent.user_id == user_id, UserEvent.project_id == project_id,
                UserEvent.revision == revision, UserEvent.updated_at == updated_at,
                UserEvent.embedding.is_(None)).values(embedding=vector, updated_at=updated_at)).rowcount
    result["skipped"] += len(nonempty) - result["updated"]
    return result


def main():
    import argparse
    import asyncio
    import json
    from uuid import UUID

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--user-id", type=UUID, required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--after", type=UUID)
    parser.add_argument("--apply", action="store_true", help="Generate and write vectors; default only counts candidates")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(backfill(args.project_id, args.user_id,
        limit=args.limit, after=args.after, apply=args.apply))))


if __name__ == "__main__":
    main()
