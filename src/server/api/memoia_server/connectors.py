# Modified for Memoia: relocated from the upstream memobase_server package.
import os
import asyncio
import redis.exceptions as redis_exceptions
import redis.asyncio as redis
from sqlalchemy import create_engine, text
from sqlalchemy import event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import OperationalError
from uuid import uuid4
from .env import LOG
from .models.database import REG, Project, UserEvent, UserEventGist

DATABASE_URL = os.getenv("DATABASE_URL")
REDIS_URL = os.getenv("REDIS_URL")
PROJECT_ID = os.getenv("PROJECT_ID")
ADMIN_URL = os.getenv("ADMIN_URL")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

if PROJECT_ID is None:
    LOG.warning(f"PROJECT_ID is not set")
    PROJECT_ID = "default"
LOG.info(f"Project ID: {PROJECT_ID}")

# Create an engine
DB_ENGINE = create_engine(
    DATABASE_URL,
    pool_size=int(os.getenv("DATABASE_POOL_SIZE", "8")),
    max_overflow=int(os.getenv("DATABASE_POOL_OVERFLOW", "4")),
    pool_recycle=300,
    pool_pre_ping=True,
    pool_timeout=15,
    pool_reset_on_return="rollback",
    echo_pool=False,  # Set to True for debugging pool issues
    hide_parameters=True,
)
REDIS_POOL = None

Session = sessionmaker(bind=DB_ENGINE)


@event.listens_for(Session, "after_begin")
def serialize_memory_transaction(session, transaction, connection):
    from .controllers.user_lease import CURRENT_LEASE
    lease = CURRENT_LEASE.get()
    if lease is None or session.info.get("memoia_non_memory_commit"):
        return
    from .controllers.source import lock_user_identity
    # Use the already-begun physical transaction, not Session.execute(), which
    # would recursively try to provision the connection during after_begin.
    lock_user_identity(connection, lease.identity[0], lease.identity[1])


@event.listens_for(Session, "after_commit")
def acknowledge_memory_version(session):
    version = session.info.pop("memoia_committed_version", None)
    if version is not None:
        lease, committed_version = version
        lease.version = committed_version


@event.listens_for(Session, "after_rollback")
def discard_uncommitted_memory_version(session):
    session.info.pop("memoia_committed_version", None)


@event.listens_for(Session, "before_commit")
def fence_legacy_commit(session):
    from .controllers.user_lease import CURRENT_LEASE
    lease = CURRENT_LEASE.get()
    if lease is None or session.info.get("memoia_non_memory_commit") or session.info.pop("memoia_fence_done", False):
        return
    lease.assert_owned()
    if lease.generation is not None:
        from .controllers.source import fence_commit
        # Fence before flushing a User DELETE that cascades away its state row.
        with session.no_autoflush:
            fence_commit(session, lease.identity[0], lease.identity[1], lease)
        session.info.pop("memoia_fence_done", None)


def create_pgvector_extension():
    try:
        with Session() as session:
            session.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
            session.commit()
            LOG.info("pgvector extension created or already exists")
    except Exception as e:
        LOG.error(f"Failed to create pgvector extension: {e}")


def create_tables():
    create_pgvector_extension()

    REG.metadata.create_all(DB_ENGINE)
    with Session() as session:
        Project.initialize_root_project(session)
        UserEvent.check_legal_embedding_dim(session)
        UserEventGist.check_legal_embedding_dim(session)
    LOG.info("Database tables created successfully")


# Imports must be usable for OpenAPI and unit tests without touching a database.
# Schema installation/upgrades are an explicit Alembic maintenance operation.


def db_health_check() -> bool:
    try:
        conn = DB_ENGINE.connect()
    except OperationalError as e:
        LOG.error(f"Database connection failed: {e}")
        return False
    else:
        conn.close()
        return True


async def redis_health_check() -> bool:
    try:
        async with get_redis_client() as redis_client:
            await redis_client.ping()
    except redis_exceptions.ConnectionError as e:
        LOG.error(f"Redis connection failed: {e}")
        return False
    else:
        return True


async def close_connection():
    DB_ENGINE.dispose()
    if REDIS_POOL is not None:
        await REDIS_POOL.aclose()
    LOG.info("Connections closed")


def init_redis_pool():
    global REDIS_POOL
    REDIS_POOL = redis.ConnectionPool.from_url(REDIS_URL, decode_responses=True)


def get_redis_client() -> redis.Redis:
    if REDIS_POOL is not None:
        return redis.Redis(connection_pool=REDIS_POOL, decode_responses=True)
    else:
        return redis.Redis.from_url(REDIS_URL, decode_responses=True)


def get_pool_status() -> dict:
    """Get current connection pool status for monitoring."""
    pool = DB_ENGINE.pool
    return {
        "size": pool.size(),
        "checked_in": pool.checkedin(),
        "checked_out": pool.checkedout(),
        "overflow": pool.overflow(),
        "total_capacity": pool.size() + pool.overflow(),
        "utilization_percent": (
            round((pool.checkedout() / (pool.size() + pool.overflow())) * 100, 2)
            if (pool.size() + pool.overflow()) > 0
            else 0
        ),
    }


def log_pool_status(operation: str = "unknown"):
    """Log current pool status for debugging."""
    status = get_pool_status()
    if status["utilization_percent"] > 80:  # Log warning if utilization is high
        LOG.warning(
            f"High DB pool utilization after {operation}: "
            f"{status['checked_out']}/{status['total_capacity']} "
            f"({status['utilization_percent']}%) - "
            f"Available: {status['checked_in']}, Overflow: {status['overflow']}"
        )
    LOG.info(f"[DB pool status] {operation}: {status}")


if __name__ == "__main__":

    async def main():
        try:
            result = await redis_health_check()
            print(result)
        finally:
            await close_connection()

    asyncio.run(main())
