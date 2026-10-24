"""Internal influence is a conservative invalidation scope, never Fact evidence."""

from sqlalchemy import false, or_

IMPACT_KEY = "_impact_fact_ids"


def public_data(data):
    return {key: value for key, value in (data or {}).items() if key != IMPACT_KEY}


def affected(data, fact_ids, *, include_unknown=False):
    matches = [data.contains({IMPACT_KEY: [str(ident)]}) for ident in fact_ids]
    if include_unknown and fact_ids:
        # SQL NULL (old missing key) and JSON null both mean unknown, not empty.
        matches.append(data[IMPACT_KEY].astext.is_(None))
    return or_(*matches) if matches else false()


def history_survives(profile, changed_fact_ids):
    if not changed_fact_ids:
        return True
    impact = profile.get(IMPACT_KEY)
    return impact is not None and not changed_fact_ids.intersection(
        {*impact, *profile.get("fact_ids", [])})
