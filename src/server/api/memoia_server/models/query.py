"""Three independent read contracts; recording, creation and calendar time stay distinct."""
from datetime import date
from uuid import UUID
from typing import Annotated
from pydantic import AwareDatetime, Field, model_validator
from .source import StrictModel, SearchFact, SearchProfile
from .management import EventRecord
from .response import EventData


class MemoryQuery(StrictModel):
    query: str | None = Field(default=None, min_length=1, max_length=8192)
    ids: list[UUID] = Field(default_factory=list, max_length=500)
    exclude_ids: list[UUID] = Field(default_factory=list, max_length=500)
    limit: int = Field(default=10, ge=1, le=100)
    max_token_size: int = Field(default=4000, ge=1, le=10000)


class FactQuery(MemoryQuery):
    source_ids: list[Annotated[str, Field(min_length=1, max_length=255)]] = Field(default_factory=list, max_length=100)
    recorded_after: AwareDatetime | None = None
    recorded_before: AwareDatetime | None = None
    event_after: date | None = None
    event_before: date | None = None

    @model_validator(mode="after")
    def ordered_ranges(self):
        for start, end in [(self.recorded_after, self.recorded_before), (self.event_after, self.event_before)]:
            if start is not None and end is not None and end < start:
                raise ValueError("Time range must be ordered")
        return self


class EventQuery(MemoryQuery):
    fact_ids: list[UUID] = Field(default_factory=list, max_length=500)
    created_after: AwareDatetime | None = None
    created_before: AwareDatetime | None = None
    event_after: date | None = None
    event_before: date | None = None

    @model_validator(mode="after")
    def ordered_ranges(self):
        for start, end in [(self.created_after, self.created_before), (self.event_after, self.event_before)]:
            if start is not None and end is not None and end < start:
                raise ValueError("Time range must be ordered")
        return self


class ProfileQuery(MemoryQuery):
    topic: str | None = Field(default=None, min_length=1, max_length=256)
    sub_topic: str | None = Field(default=None, min_length=1, max_length=256)


class QueriedEventData(EventData):
    # Query links are part of the read contract, not discarded management extras.
    fact_ids: list[UUID]


class QueriedEvent(EventRecord):
    event_data: QueriedEventData
    score: float


class QueriedFacts(StrictModel):
    facts: list[SearchFact]


class QueriedEvents(StrictModel):
    events: list[QueriedEvent]


class QueriedProfiles(StrictModel):
    profiles: list[SearchProfile]


class ProjectIdentity(StrictModel):
    project_id: str
