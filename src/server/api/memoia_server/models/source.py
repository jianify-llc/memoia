"""V2 protocol: explicit identities and bounded complete messages."""
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Table, Column, String, BigInteger, Boolean, ForeignKeyConstraint, Index, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID, TIMESTAMP

from .database import REG


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceMessage(StrictModel):
    message_id: str = Field(min_length=1, max_length=255)
    role: Literal["user", "assistant", "system", "tool"]
    content: str = Field(min_length=1, max_length=262144)
    occurred_at: datetime

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
    external_id: str = Field(min_length=1, max_length=255, pattern=r"^[^/]+$")
    messages: list[SourceMessage] = Field(min_length=1, max_length=1000)
    metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique_messages(self):
        ids = [m.message_id for m in self.messages]
        if len(ids) != len(set(ids)):
            raise ValueError("message_id must be unique within a source")
        return self


class RetractMessages(StrictModel):
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
    source_id: UUID | None
    external_id: str
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


class Evidence(StrictModel):
    fact_id: UUID
    content: str
    topic: str
    sub_topic: str
    support_groups: list[list[str]]


class Source(StrictModel):
    source_id: UUID
    external_id: str
    status: Literal["active", "retracted", "rebuilding"]
    message_ids: list[str]
    retracted_message_ids: list[str]
    created_at: datetime
    evidence: list[Evidence]


class Sources(StrictModel):
    sources: list[Source]


class Profile(StrictModel):
    id: UUID
    content: str
    topic: str
    sub_topic: str
    source_ids: list[UUID]
    updated_at: datetime


class Profiles(StrictModel):
    profiles: list[Profile]


class SearchEvent(StrictModel):
    id: UUID
    content: str
    source_id: UUID | None
    score: float
    occurred_at: datetime


class SearchResult(StrictModel):
    events: list[SearchEvent]


class HistoricalProfile(StrictModel):
    id: UUID
    content: str
    topic: str
    sub_topic: str
    source_ids: list[UUID]
    fact_ids: list[UUID]


class HistoryEntry(StrictModel):
    revision_id: UUID
    operation_id: UUID
    source_id: UUID
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
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("external_id", String(255), nullable=False),
    Column("payload", JSONB, nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("status", String(16), nullable=False),
    Column("retracted_message_ids", JSONB, nullable=False, server_default="[]"),
    Column("event_id", PGUUID(as_uuid=True), nullable=True),
    Column("event_deleted", Boolean, nullable=False, server_default="false"),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("user_id", "project_id", "external_id"),
    Index("idx_memory_sources_user", "user_id", "project_id", "created_at", "id"),
)
memory_operations = Table(
    "memory_operations", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("idempotency_key", String(255), nullable=False),
    Column("kind", String(16), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("request", JSONB, nullable=False),
    Column("external_id", String(255), nullable=False),
    Column("source_id", PGUUID(as_uuid=True), nullable=True),
    Column("status", String(16), nullable=False),
    Column("result", JSONB(none_as_null=True), nullable=True),
    Column("error", JSONB(none_as_null=True), nullable=True),
    Column("generation", BigInteger, nullable=True),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("user_id", "project_id", "idempotency_key"),
    Index("idx_memory_operations_user", "user_id", "project_id", "created_at", "id"),
)
memory_facts = Table(
    "memory_facts", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("source_id", PGUUID(as_uuid=True), nullable=False),
    Column("content", String, nullable=False),
    Column("topic", String(128), nullable=False),
    Column("sub_topic", String(128), nullable=False),
    Column("support_groups", JSONB, nullable=False),
    Column("occurred_at", TIMESTAMP(timezone=True), nullable=False),
    Column("included", Boolean, nullable=False, server_default="true"),
    user_fk(), ForeignKeyConstraint(["source_id"], ["memory_sources.id"], ondelete="CASCADE"),
    Index("idx_memory_facts_user", "user_id", "project_id", "source_id"),
)
SOURCE_TABLES = [user_memory_states, memory_sources, memory_operations, memory_facts]

memory_profile_revisions = Table(
    "memory_profile_revisions", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True), *identity_columns(),
    Column("operation_id", PGUUID(as_uuid=True), nullable=False),
    Column("source_id", PGUUID(as_uuid=True), nullable=False),
    Column("profiles", JSONB, nullable=False),
    Column("added", JSONB, nullable=False),
    Column("removed", JSONB, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    user_fk(), UniqueConstraint("operation_id"),
    ForeignKeyConstraint(["operation_id"], ["memory_operations.id"], ondelete="CASCADE"),
    Index("idx_memory_profile_revisions_user", "user_id", "project_id", "created_at", "id"),
)
