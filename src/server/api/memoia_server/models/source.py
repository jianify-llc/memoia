"""V2 protocol: explicit identities and bounded complete messages."""
from datetime import date, datetime
import calendar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Table, Column, String, BigInteger, Boolean, ForeignKeyConstraint, Index, UniqueConstraint, PrimaryKeyConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID, TIMESTAMP
from pgvector.sqlalchemy import Vector
from ..env import CONFIG

from .database import REG


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceMessage(StrictModel):
    message_id: str = Field(min_length=1, max_length=255)
    role: Literal["user", "assistant", "system", "tool"]
    content: str = Field(min_length=1, max_length=262144)
    occurred_at: datetime
    # Wire name retained for compatibility: this is the message recording time.
    time_zone: str | None = Field(default=None, max_length=100)

    @field_validator("time_zone")
    @classmethod
    def valid_zone(cls, value):
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("time_zone must be an IANA timezone") from None
        return value

    @field_validator("occurred_at")
    @classmethod
    def aware_time(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        return value


class ForgottenUser(StrictModel):
    user_id: UUID
    forgotten: Literal[True]


class ImportSource(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=255, pattern=r"^[^/]+$")
    source_id: str = Field(min_length=1, max_length=255, pattern=r"^[^/]+$")
    messages: list[SourceMessage] = Field(min_length=1, max_length=1000)
    metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique_messages(self):
        ids = [m.message_id for m in self.messages]
        if len(ids) != len(set(ids)):
            raise ValueError("message_id must be unique within a blob")
        return self


class DeleteMessages(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=255, pattern=r"^[^/]+$")
    message_ids: list[Annotated[str, Field(min_length=1, max_length=255)]] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def unique_messages(self):
        if len(self.message_ids) != len(set(self.message_ids)):
            raise ValueError("message_ids must be unique")
        return self


class OperationError(StrictModel):
    code: str
    retryable: bool


class SourceResult(StrictModel):
    event_ids: list[UUID]
    profile_ids: list[UUID]
    memory_version: int | None = None
    fact_ids: list[UUID] = Field(default_factory=list)


class FlushInput(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=255, pattern=r"^[^/]+$")


class FlushProgress(StrictModel):
    operation_id: UUID
    status: Literal["pending", "running", "completed", "failed"]
    blob_ids: list[UUID]
    attempts: int
    available_at: datetime | None
    error: OperationError | None
    retryable: bool


class MaintenanceStatus(StrictModel):
    pending_blob_count: int
    flushes: list[FlushProgress]


class FlushResult(StrictModel):
    blob_ids: list[UUID]
    profile_ids: list[UUID]
    event_ids: list[UUID]
    memory_version: int | None = None


class Operation(StrictModel):
    operation_id: UUID
    kind: Literal["import", "retract", "legacy_import", "flush"] = "import"
    status: Literal["processing", "completed", "failed"]
    source_id: str | None
    blob_id: UUID | None
    result: SourceResult | FlushResult | None
    error: OperationError | None
    flush: FlushProgress | None = None

    @model_validator(mode="after")
    def valid_completion(self):
        if self.kind == "flush":
            if self.source_id is not None or self.blob_id is not None or self.flush is None:
                raise ValueError("flush is user-scoped and requires its progress")
            if self.result is not None and not isinstance(self.result, FlushResult):
                raise ValueError("flush requires a flush result")
            expected = {"completed": {"completed"}, "failed": {"failed"}, "processing": {"pending", "running"}}
            if self.flush.status not in expected[self.status]:
                raise ValueError("flush progress must agree with the operation outcome")
            if self.status == "processing" and self.error is not None and not self.error.retryable:
                raise ValueError("processing flush can only carry a retryable last error")
        elif self.source_id is None:
            raise ValueError("Fact operations require source_id")
        if self.status == "completed" and (self.result is None or self.error is not None):
            raise ValueError("completed requires result, without error")
        if self.status == "failed" and (self.error is None or self.result is not None):
            raise ValueError("failed requires error, without result")
        if self.status == "processing" and self.result is not None:
            raise ValueError("processing cannot carry a completed result")
        return self


class Operations(StrictModel):
    operations: list[Operation]


class TimeEvidence(StrictModel):
    message_id: str = Field(min_length=1, max_length=255)
    expression: str = Field(min_length=1, max_length=1024)


class EventTime(StrictModel):
    start: date | None
    end: date | None
    precision: Literal["year", "month", "day", "range", "unknown"]
    evidence: list[TimeEvidence] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def valid_period(self):
        if self.precision == "unknown":
            if self.start is not None or self.end is not None:
                raise ValueError("Unknown event time cannot carry invented dates")
            return self
        if self.start is None or self.end is None or self.end < self.start:
            raise ValueError("Known event time requires an ordered inclusive date range")
        if self.precision == "day" and self.start != self.end:
            raise ValueError("Day precision requires one day")
        if self.precision == "year" and (self.start != date(self.start.year, 1, 1) or self.end != date(self.start.year, 12, 31)):
            raise ValueError("Year precision requires calendar year boundaries")
        if self.precision == "month" and (self.start.day != 1 or self.end != date(self.start.year, self.start.month, calendar.monthrange(self.start.year, self.start.month)[1])):
            raise ValueError("Month precision requires calendar month boundaries")
        return self


class SourceObservation(StrictModel):
    message_id: str
    recorded_at: datetime
    time_zone: str | None = None


class Evidence(StrictModel):
    fact_id: UUID
    blob_id: UUID
    content: str
    topic: str | None = None
    sub_topic: str | None = None
    subject: str | None = None
    reporter: str | None = None
    certainty: Literal["asserted", "reported", "uncertain", "legacy"] = "legacy"
    revision: int = 1
    support_groups: list[list[str]]
    event_time: EventTime | None = None
    source_messages: list[SourceObservation] = Field(default_factory=list)


class Blob(StrictModel):
    blob_id: UUID
    source_id: str
    status: Literal["processing", "failed", "active", "retracted", "rebuilding"]
    message_ids: list[str]
    event_ids: list[UUID]
    created_at: datetime
    kind: Literal["import", "retract"] = "import"
    flush: FlushProgress | None = None


class SourceSummary(StrictModel):
    source_id: str
    legacy: bool
    created_at: datetime


class Source(SourceSummary):
    message_ids: list[str]
    deleted_message_ids: list[str]
    blobs: list[Blob]
    evidence: list[Evidence]
    next_message_offset: int | None
    next_blob_offset: int | None
    next_evidence_offset: int | None


class Sources(StrictModel):
    sources: list[SourceSummary]


class Profile(StrictModel):
    created_at: datetime
    id: UUID
    content: str
    topic: str
    sub_topic: str
    source_ids: list[str]
    updated_at: datetime


class Profiles(StrictModel):
    profiles: list[Profile]


class SearchEvent(StrictModel):
    id: UUID
    content: str
    source_id: str | None
    blob_id: UUID | None
    score: float
    occurred_at: datetime
    # Legacy occurred_at is source recording time, never an inferred event date.
    evidence: list[Evidence] = Field(default_factory=list)
    title: str | None = None
    summary: str | None = None
    interpretation: str | None = None
    keywords: str | None = None
    time: str | None = None
    location: str | None = None
    fact_ids: list[UUID] = Field(default_factory=list)


class SearchFact(StrictModel):
    id: UUID
    content: str
    source_id: str
    blob_id: UUID
    score: float
    occurred_at: datetime
    evidence: Evidence


class SearchProfile(StrictModel):
    id: UUID
    content: str
    topic: str
    sub_topic: str
    fact_ids: list[UUID]
    source_ids: list[str]
    score: float
    created_at: datetime
    updated_at: datetime


class SearchResult(StrictModel):
    events: list[SearchEvent]
    facts: list[SearchFact]
    profiles: list[SearchProfile]


class HistoricalProfile(StrictModel):
    id: UUID
    content: str
    topic: str
    sub_topic: str
    source_ids: list[str]
    fact_ids: list[UUID]


class HistoryEntry(StrictModel):
    revision_id: UUID
    operation_id: UUID | None
    source_id: str | None
    maintenance_version: int | None = None
    created_at: datetime
    profiles: list[HistoricalProfile]
    added: list[HistoricalProfile]
    removed: list[HistoricalProfile]


class History(StrictModel):
    entries: list[HistoryEntry]


def user_fk():
    return ForeignKeyConstraint(["user_id", "project_id"], ["users.id", "users.project_id"], ondelete="CASCADE")


def identity_columns():
    return [Column("user_id", PGUUID(as_uuid=True), nullable=False), Column("project_id", String(64), nullable=False)]


user_memory_states = Table(
    "memory_user_states", REG.metadata, *identity_columns(),
    Column("generation", BigInteger, nullable=False, server_default="0"),
    Column("version", BigInteger, nullable=False, server_default="0"),
    user_fk(), UniqueConstraint("user_id", "project_id"),
)
user_memory_tombstones = Table(
    "memory_user_tombstones", REG.metadata,
    Column("project_id", String(64), primary_key=True),
    Column("user_id", PGUUID(as_uuid=True), primary_key=True),
    Column("forgotten_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    ForeignKeyConstraint(["project_id"], ["projects.project_id"], ondelete="CASCADE"),
)
memory_sources = Table(
    "memory_sources", REG.metadata,
    *identity_columns(), Column("source_id", String(255), nullable=False),
    Column("legacy", Boolean, nullable=False, server_default="false"),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), PrimaryKeyConstraint("user_id", "project_id", "source_id"),
)


def source_fk():
    return ForeignKeyConstraint(["user_id", "project_id", "source_id"],
        ["memory_sources.user_id", "memory_sources.project_id", "memory_sources.source_id"], ondelete="CASCADE")


memory_messages = Table(
    "memory_messages", REG.metadata, *identity_columns(),
    Column("source_id", String(255), nullable=False), Column("message_id", String(255), nullable=False),
    Column("content_hash", String(64)), Column("role", String(16)),
    Column("occurred_at", TIMESTAMP(timezone=True)),
    Column("time_zone", String(100)),
    Column("processed", Boolean, nullable=False, server_default="false"),
    Column("deleted", Boolean, nullable=False, server_default="false"),
    source_fk(), PrimaryKeyConstraint("user_id", "project_id", "source_id", "message_id"),
)


memory_blobs = Table(
    "memory_blobs", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("source_id", String(255), nullable=False),
    Column("message_ids", JSONB, nullable=False),
    Column("status", String(16), nullable=False),
    Column("event_id", PGUUID(as_uuid=True), nullable=True),
    Column("event_deleted", Boolean, nullable=False, server_default="false"),
    Column("kind", String(16), nullable=False, server_default="import"),
    Column("fact_changes", JSONB, nullable=False, server_default="[]"),
    Column("fact_completed_at", TIMESTAMP(timezone=True)),
    Column("flush_operation_id", PGUUID(as_uuid=True)),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    source_fk(), UniqueConstraint("id", "user_id", "project_id"),
    UniqueConstraint("id", "user_id", "project_id", "source_id"),
    ForeignKeyConstraint(["flush_operation_id", "user_id", "project_id"],
        ["memory_operations.id", "memory_operations.user_id", "memory_operations.project_id"], use_alter=True),
    Index("idx_memory_blobs_user", "user_id", "project_id", "source_id", "created_at", "id"),
)
memory_operations = Table(
    "memory_operations", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("idempotency_key", String(255), nullable=False),
    Column("kind", String(16), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("request", JSONB, nullable=False),
    Column("source_id", String(255), nullable=True),
    Column("blob_id", PGUUID(as_uuid=True), nullable=True),
    Column("input_expires_at", TIMESTAMP(timezone=True)),
    Column("status", String(16), nullable=False),
    Column("result", JSONB(none_as_null=True), nullable=True),
    Column("error", JSONB(none_as_null=True), nullable=True),
    Column("generation", BigInteger, nullable=True),
    Column("lease_owner", PGUUID(as_uuid=True)),
    Column("lease_until", TIMESTAMP(timezone=True)),
    Column("attempts", BigInteger, nullable=False, server_default="0"),
    Column("available_at", TIMESTAMP(timezone=True)),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("user_id", "project_id", "idempotency_key"),
    source_fk(),
    ForeignKeyConstraint(["blob_id", "user_id", "project_id"],
        ["memory_blobs.id", "memory_blobs.user_id", "memory_blobs.project_id"], ondelete="CASCADE"),
    ForeignKeyConstraint(["blob_id", "user_id", "project_id", "source_id"],
        ["memory_blobs.id", "memory_blobs.user_id", "memory_blobs.project_id", "memory_blobs.source_id"], ondelete="CASCADE"),
    UniqueConstraint("id", "user_id", "project_id"),
    UniqueConstraint("id", "user_id", "project_id", "source_id"),
    Index("idx_memory_operations_user", "user_id", "project_id", "created_at", "id"),
    Index("uq_memory_fact_operation_blob", "blob_id", unique=True, postgresql_where=text("kind IN ('import','retract')")),
)
memory_facts = Table(
    "memory_facts", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("blob_id", PGUUID(as_uuid=True), nullable=False),
    Column("content", String, nullable=False),
    Column("topic", String(128), nullable=True),
    Column("sub_topic", String(128), nullable=True),
    Column("subject", String(512)),
    Column("reporter", String(512)),
    Column("certainty", String(16), nullable=False, server_default="legacy"),
    Column("support_groups", JSONB, nullable=False),
    Column("occurred_at", TIMESTAMP(timezone=True), nullable=False),
    Column("event_time", JSONB),
    Column("included", Boolean, nullable=False, server_default="true"),
    Column("active", Boolean, nullable=False, server_default="true"),
    Column("revision", BigInteger, nullable=False, server_default="1"),
    Column("created_version", BigInteger, nullable=False, server_default="0"),
    Column("search_text", String),
    Column("embedding", Vector(dim=CONFIG.embedding_dim)),
    user_fk(), ForeignKeyConstraint(["blob_id", "user_id", "project_id"],
        ["memory_blobs.id", "memory_blobs.user_id", "memory_blobs.project_id"], ondelete="CASCADE"),
    Index("idx_memory_facts_user", "user_id", "project_id", "blob_id"),
    UniqueConstraint("id", "user_id", "project_id"),
)
SOURCE_TABLES = [user_memory_states, memory_sources, memory_messages, memory_blobs, memory_operations, memory_facts]

memory_profile_revisions = Table(
    "memory_profile_revisions", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("operation_id", PGUUID(as_uuid=True), nullable=True),
    Column("source_id", String(255), nullable=True),
    Column("maintenance_version", BigInteger),
    Column("profiles", JSONB, nullable=False),
    Column("added", JSONB, nullable=False),
    Column("removed", JSONB, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("operation_id"),
    UniqueConstraint("user_id", "project_id", "maintenance_version"),
    source_fk(),
    ForeignKeyConstraint(["operation_id", "user_id", "project_id", "source_id"],
        ["memory_operations.id", "memory_operations.user_id", "memory_operations.project_id", "memory_operations.source_id"], ondelete="CASCADE"),
    Index("idx_memory_profile_revisions_user", "user_id", "project_id", "created_at", "id"),
)

memory_fact_corrections = Table(
    "memory_fact_corrections", REG.metadata, *identity_columns(),
    Column("fact_id", PGUUID(as_uuid=True), nullable=False),
    Column("corrected_fact_id", PGUUID(as_uuid=True), nullable=False),
    Column("support_groups", JSONB, nullable=False),
    PrimaryKeyConstraint("fact_id", "corrected_fact_id", "project_id"),
    ForeignKeyConstraint(["fact_id", "user_id", "project_id"],
        ["memory_facts.id", "memory_facts.user_id", "memory_facts.project_id"], ondelete="CASCADE"),
    ForeignKeyConstraint(["corrected_fact_id", "user_id", "project_id"],
        ["memory_facts.id", "memory_facts.user_id", "memory_facts.project_id"], ondelete="CASCADE"),
)
memory_event_facts = Table(
    "memory_event_facts", REG.metadata, *identity_columns(),
    Column("event_id", PGUUID(as_uuid=True), nullable=False),
    Column("fact_id", PGUUID(as_uuid=True), nullable=False),
    PrimaryKeyConstraint("event_id", "fact_id", "project_id"),
    ForeignKeyConstraint(["event_id", "user_id", "project_id"],
        ["user_events.id", "user_events.user_id", "user_events.project_id"], ondelete="CASCADE"),
    ForeignKeyConstraint(["fact_id", "user_id", "project_id"],
        ["memory_facts.id", "memory_facts.user_id", "memory_facts.project_id"], ondelete="CASCADE"),
)
memory_deleted_events = Table(
    "memory_deleted_events", REG.metadata, *identity_columns(),
    Column("id", PGUUID(as_uuid=True), nullable=False),
    PrimaryKeyConstraint("id", "user_id", "project_id"), user_fk(),
)
