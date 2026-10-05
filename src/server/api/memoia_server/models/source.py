"""V2 protocol: explicit identities and bounded complete messages."""
from datetime import date, datetime
import calendar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Table, Column, String, BigInteger, Boolean, ForeignKeyConstraint, Index, UniqueConstraint, PrimaryKeyConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID, TIMESTAMP

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


class Operation(StrictModel):
    operation_id: UUID
    status: Literal["processing", "completed", "failed"]
    source_id: str
    blob_id: UUID | None
    result: SourceResult | None
    error: OperationError | None

    @model_validator(mode="after")
    def valid_completion(self):
        if self.status == "completed" and (self.source_id is None or self.result is None or self.error is not None):
            raise ValueError("completed requires source_id and result, without error")
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
    topic: str
    sub_topic: str
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


class SearchResult(StrictModel):
    events: list[SearchEvent]


class HistoricalProfile(StrictModel):
    id: UUID
    content: str
    topic: str
    sub_topic: str
    source_ids: list[str]
    fact_ids: list[UUID]


class HistoryEntry(StrictModel):
    revision_id: UUID
    operation_id: UUID
    source_id: str
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
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    source_fk(), UniqueConstraint("id", "user_id", "project_id"),
    UniqueConstraint("id", "user_id", "project_id", "source_id"),
    Index("idx_memory_blobs_user", "user_id", "project_id", "source_id", "created_at", "id"),
)
memory_operations = Table(
    "memory_operations", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("idempotency_key", String(255), nullable=False),
    Column("kind", String(16), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("request", JSONB, nullable=False),
    Column("source_id", String(255), nullable=False),
    Column("blob_id", PGUUID(as_uuid=True), nullable=True),
    Column("input_expires_at", TIMESTAMP(timezone=True)),
    Column("status", String(16), nullable=False),
    Column("result", JSONB(none_as_null=True), nullable=True),
    Column("error", JSONB(none_as_null=True), nullable=True),
    Column("generation", BigInteger, nullable=True),
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
    Index("uq_memory_import_blob", "blob_id", unique=True, postgresql_where=text("kind='import'")),
)
memory_facts = Table(
    "memory_facts", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("blob_id", PGUUID(as_uuid=True), nullable=False),
    Column("content", String, nullable=False),
    Column("topic", String(128), nullable=False),
    Column("sub_topic", String(128), nullable=False),
    Column("support_groups", JSONB, nullable=False),
    Column("occurred_at", TIMESTAMP(timezone=True), nullable=False),
    Column("event_time", JSONB),
    Column("included", Boolean, nullable=False, server_default="true"),
    user_fk(), ForeignKeyConstraint(["blob_id", "user_id", "project_id"],
        ["memory_blobs.id", "memory_blobs.user_id", "memory_blobs.project_id"], ondelete="CASCADE"),
    Index("idx_memory_facts_user", "user_id", "project_id", "blob_id"),
)
SOURCE_TABLES = [user_memory_states, memory_sources, memory_messages, memory_blobs, memory_operations, memory_facts]

memory_profile_revisions = Table(
    "memory_profile_revisions", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("operation_id", PGUUID(as_uuid=True), nullable=False),
    Column("source_id", String(255), nullable=False),
    Column("profiles", JSONB, nullable=False),
    Column("added", JSONB, nullable=False),
    Column("removed", JSONB, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("operation_id"),
    source_fk(),
    ForeignKeyConstraint(["operation_id", "user_id", "project_id", "source_id"],
        ["memory_operations.id", "memory_operations.user_id", "memory_operations.project_id", "memory_operations.source_id"], ondelete="CASCADE"),
    Index("idx_memory_profile_revisions_user", "user_id", "project_id", "created_at", "id"),
)
