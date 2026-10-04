"""Shared time evidence validation, rendering and soft relevance ranking."""
import calendar
import json
import re
from datetime import date

from .models.source import EventTime


def supported_event_time(value, groups):
    """A surviving fact does not imply its original time anchor survived."""
    if value is None:
        return None
    evidence_ids = {item["message_id"] for item in value["evidence"]}
    return value if any(evidence_ids.issubset(group) for group in groups) else None


def source_observations(groups, messages):
    ids = {mid for group in groups for mid in group}
    return [{"message_id": m["message_id"],
             "recorded_at": m["occurred_at"].isoformat() if hasattr(m["occurred_at"], "isoformat") else m["occurred_at"],
             "time_zone": m.get("time_zone")} for m in sorted(messages, key=lambda m: m["message_id"])
            if m["message_id"] in ids and m.get("occurred_at") is not None]


def query_periods(query):
    """Only explicit ISO calendar clues; never guess natural-language relative dates."""
    periods = []
    for match in re.finditer(r"(?<![0-9A-Za-z-])(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?![0-9A-Za-z-])", query):
        year, month, day = (int(v) if v else None for v in match.groups())
        if not 1800 <= year <= 2200:
            continue
        try:
            start = date(year, month or 1, day or 1)
            if day:
                end = start
            elif month:
                end = date(year, month, calendar.monthrange(year, month)[1])
            else:
                end = date(year, 12, 31)
        except ValueError:
            continue
        periods.append((start, end))
    return periods


def time_overlap(value, periods):
    if not value or not periods:
        return False
    time = EventTime.model_validate(value)
    if time.start is None:
        return False
    return any(time.start <= end and time.end >= start for start, end in periods)


def render_gist(gist):
    # Labels prevent a recording timestamp from masquerading as an event date.
    content = gist.content
    details = {"event_time": gist.event_time.model_dump(mode="json") if gist.event_time else None,
               "source_messages": [m.model_dump(mode="json") for m in gist.source_messages],
               "source_id": gist.source_id,
               "blob_id": str(gist.blob_id) if gist.blob_id else None,
               "fact_id": str(gist.fact_id) if gist.fact_id else None}
    if gist.event_time is None and not gist.source_messages and gist.source_id is None:
        return content
    return f'{content}\n[Time evidence (event_time=null means unknown): {json.dumps(details, ensure_ascii=False, separators=(",", ":"))}]'
