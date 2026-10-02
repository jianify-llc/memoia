"""Explicit project administration and revocable, scoped API keys."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator
from sqlalchemy import Table, Column, String, ForeignKeyConstraint, Index, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID, TIMESTAMP
from .source import StrictModel
from .database import REG

Scope = Literal["read", "write", "admin"]


class ProjectCreate(StrictModel):
    project_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


class ProjectUpdate(StrictModel):
    status: Literal["active", "suspended"]


class ManagedProject(StrictModel):
    project_id: str
    status: str
    created_at: datetime


class Projects(StrictModel):
    projects: list[ManagedProject]


class KeyCreate(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    scopes: list[Scope] = Field(min_length=1, max_length=3)
    expires_at: datetime | None = None

    @field_validator("scopes")
    @classmethod
    def unique_scopes(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("Scopes must be distinct")
        return value

    @field_validator("expires_at")
    @classmethod
    def aware_expiry(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("expires_at must include a timezone")
        return value


class ManagedKey(StrictModel):
    key_id: UUID
    name: str
    scopes: list[Scope]
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class IssuedKey(ManagedKey):
    token: str


class Keys(StrictModel):
    keys: list[ManagedKey]


class LegacyToken(StrictModel):
    token: str


project_api_keys = Table(
    "project_api_keys", REG.metadata,
    Column("id", PGUUID(as_uuid=True), primary_key=True),
    Column("project_id", String(64), nullable=False),
    Column("name", String(128), nullable=False),
    Column("token_hash", String(64), nullable=False),
    Column("scopes", JSONB, nullable=False),
    Column("expires_at", TIMESTAMP(timezone=True), nullable=True),
    Column("revoked_at", TIMESTAMP(timezone=True), nullable=True),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    ForeignKeyConstraint(["project_id"], ["projects.project_id"], ondelete="CASCADE"),
    Index("idx_project_api_keys_project", "project_id", "id"),
)
