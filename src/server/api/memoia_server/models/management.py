"""The single HTTP contract for existing user and management capabilities."""
from datetime import datetime
from uuid import UUID
from pydantic import Field
from .source import StrictModel
from .response import DailyUsage, EventData

class SearchInput(StrictModel):
    query: str = Field(min_length=1, max_length=8192)
    limit: int = Field(default=10, ge=1, le=100)

class ContextInput(StrictModel):
    query: str | None = Field(default=None, min_length=1, max_length=8192)
    max_token_size: int = Field(default=500, ge=1, le=10000)

class Context(StrictModel):
    context: str
    entries: list[str]

class ProfileInput(StrictModel):
    content: str = Field(min_length=1, max_length=32768)
    topic: str = Field(min_length=1, max_length=256)
    sub_topic: str = Field(min_length=1, max_length=256)

class ProfileConfig(StrictModel):
    profile_config: str

class Usage(StrictModel):
    usages: list[DailyUsage]

class Health(StrictModel):
    status: str = "ok"

class ProjectUser(StrictModel):
    id: UUID
    project_id: str
    additional_fields: dict | None
    created_at: datetime
    updated_at: datetime
    profile_count: int
    event_count: int

class Users(StrictModel):
    users: list[ProjectUser]
    count: int

class EventRecord(StrictModel):
    id: UUID
    event_data: EventData
    created_at: datetime
    updated_at: datetime

class Events(StrictModel):
    events: list[EventRecord]
