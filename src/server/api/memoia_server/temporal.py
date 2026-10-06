"""Shared time evidence validation and derived retrieval/context text."""
import json

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


def render_search_fact(content, event_time):
    """Derive searchable dates only from valid event evidence, never recording time."""
    if event_time is None:
        return content
    time = EventTime.model_validate(event_time)
    if time.precision == "unknown":
        return content
    start = time.start.isoformat()
    if time.precision == "year":
        label = start[:4]
    elif time.precision == "month":
        label = start[:7]
    elif time.precision == "day":
        label = start
    else:
        label = f"{start} to {time.end.isoformat()}"
    return f"{content}\n[Event time: {label}; precision: {time.precision}]"


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
