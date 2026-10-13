# Modified for Memoia: relocated from the upstream memobase_server package.
from ..models.utils import Promise
from ..models.database import (
    Billing,
    ProjectBilling,
    next_month_first_day,
)
from ..models.response import CODE, BillingData
from ..connectors import Session, ADMIN_URL, run_sql
from ..telemetry.capture_key import get_int_key, capture_int_keys
from ..env import (
    TelemetryKeyName,
    USAGE_TOKEN_LIMIT_MAP,
    BILLING_REFILL_AMOUNT_MAP,
    BillingStatus,
)
from datetime import datetime, date, timezone
from sqlalchemy import select, update
from ..auth import admin_api


async def get_project_billing(project_id: str) -> Promise[BillingData]:
    if ADMIN_URL is not None:
        return await admin_api.get_project_usage(project_id)

    # Read counters before entering SQL: a slow Redis call must not hold a transaction.
    this_month_token_costs = await get_int_key(
        TelemetryKeyName.llm_input_tokens, project_id, in_month=True
    ) + await get_int_key(
        TelemetryKeyName.llm_output_tokens, project_id, in_month=True
    )

    def read():
        with Session() as session:
            # Billing belongs to the project, not this task's user-memory generation.
            session.info["memoia_non_memory_commit"] = True
            billing_id = session.scalar(select(ProjectBilling.billing_id).where(
                ProjectBilling.project_id == project_id).limit(1))
            if billing_id is None:
                return None
            refill = BILLING_REFILL_AMOUNT_MAP[BillingStatus.free]
            if refill is not None:
                # Recheck eligibility under the SQL row lock: a delayed reader
                # cannot refill twice and overwrite a debit after the first refill.
                session.execute(update(Billing).where(Billing.id == billing_id,
                    Billing.next_refill_at < datetime.now(timezone.utc),
                    Billing.usage_left.is_not(None), Billing.usage_left < refill)
                    .values(usage_left=refill, next_refill_at=next_month_first_day()))
                session.commit()
            row = session.execute(select(Billing.usage_left, Billing.next_refill_at)
                .where(Billing.id == billing_id)).one()
            return BillingData(
                token_left=row.usage_left,
                next_refill_at=row.next_refill_at,
                project_token_cost_month=this_month_token_costs,
            )
    billing = await run_sql(read)
    if billing is None:
        return await fallback_billing_data(project_id, month_usage=this_month_token_costs)
    return Promise.resolve(billing)


async def fallback_billing_data(project_id: str, *, month_usage: int | None = None) -> Promise[BillingData]:
    from .project import get_project_status

    if month_usage is None:
        month_usage = await get_int_key(
            TelemetryKeyName.llm_input_tokens, project_id, in_month=True
        ) + await get_int_key(
            TelemetryKeyName.llm_output_tokens, project_id, in_month=True
        )
    this_month_token_costs = month_usage
    p = await get_project_status(project_id)
    if not p.ok():
        return p
    status = p.data()
    if status not in USAGE_TOKEN_LIMIT_MAP:
        return Promise.reject(
            CODE.INTERNAL_SERVER_ERROR, f"Invalid project status: {status}"
        )
    usage_token_limit = USAGE_TOKEN_LIMIT_MAP[status]
    if usage_token_limit < 0:
        this_month_left_tokens = None
    else:
        this_month_left_tokens = usage_token_limit - this_month_token_costs

    # Calculate first day of next month
    today = date.today()
    if today.month == 12:
        next_month = date(today.year + 1, 1, 1)
    else:
        next_month = date(today.year, today.month + 1, 1)

    return Promise.resolve(
        BillingData(
            token_left=this_month_left_tokens,
            next_refill_at=next_month,
            project_token_cost_month=this_month_token_costs,
        )
    )


async def project_cost_token_billing(
    project_id: str, input_tokens: int, output_tokens: int
) -> Promise[None]:
    await capture_int_keys({TelemetryKeyName.llm_input_tokens: input_tokens,
                            TelemetryKeyName.llm_output_tokens: output_tokens}, project_id=project_id)
    if ADMIN_URL is not None:
        return await admin_api.cost_project_usage(
            project_id, input_tokens, output_tokens
        )
    def debit():
        with Session() as session:
            session.info["memoia_non_memory_commit"] = True
            billing_id = session.execute(select(ProjectBilling.billing_id).where(
                ProjectBilling.project_id == project_id)).scalar_one_or_none()
            if billing_id is None:
                return Promise.reject(CODE.NOT_FOUND, "Billing not found")
            session.execute(update(Billing).where(Billing.id == billing_id,
                Billing.usage_left.is_not(None)).values(
                    usage_left=Billing.usage_left - input_tokens - output_tokens))
            session.commit()
        return Promise.resolve(None)
    return await run_sql(debit)
