# Modified for Memoia: relocated from the upstream memobase_server package.
from functools import partial
from ..env import CONFIG, LOG, TelemetryKeyName
from ..telemetry.capture_key import capture_int_key
from ..controllers.billing import project_cost_token_billing
from ..models.utils import Promise
from ..models.response import CODE
from ..models.database import DEFAULT_PROJECT_ID
from ..telemetry import telemetry_manager, CounterMetricName, HistogramMetricName

from .openai_model_llm import openai_complete


# TODO: add TPM/Rate limiter
async def llm_complete(
    project_id,
    prompt,
    system_prompt=None,
    history_messages=[],
    model=None,
    max_tokens=1024,
    usage_kind="completion",
    **kwargs,
) -> Promise[str]:
    use_model = model or CONFIG.best_llm_model
    try:
        results = await openai_complete(
            use_model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            max_tokens=max_tokens,
            on_usage=partial(record_completion_usage, project_id, kind=usage_kind),
            **kwargs,
        )
    except Exception as e:
        LOG.error("LLM completion failed (%s)", type(e).__name__)
        return Promise.reject(CODE.SERVICE_UNAVAILABLE, "LLM completion failed")

    return Promise.resolve(results)


async def record_completion_usage(project_id, in_tokens, out_tokens, latency, *,
                                  kind="completion", model=None, service_tier=None,
                                  requested_service_tier="auto", cached_tokens=None,
                                  cache_write_tokens=None):
    # Await the small accounting write; it must not inherit a memory-write fence or
    # escape as a detached task after the request's lease and process have ended.
    attributes = {"project_id": project_id, "kind": kind, "model": model or "unknown",
                  "service_tier": service_tier or "unknown",
                  "requested_service_tier": requested_service_tier}
    usage_known = all(type(value) is int and value >= 0 for value in (in_tokens, out_tokens))
    if usage_known:
        try:
            result = await project_cost_token_billing(project_id, in_tokens, out_tokens)
            if not result.ok():
                LOG.warning("Completion accounting rejected (%s)", result.code())
        except Exception as error:
            LOG.error("Completion accounting failed (%s)", type(error).__name__)
    cache_known = usage_known and all(type(value) is int and 0 <= value <= in_tokens
                                     for value in (cached_tokens, cache_write_tokens))
    if cache_known and cached_tokens + cache_write_tokens > in_tokens:
        cache_known = False
    # Observability is best effort, independent of memory success and existing quota rules.
    # Read/write tokens are disjoint subsets of input; never double-debit cache writes.
    try:
        if usage_known:
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_TOKENS_INPUT, in_tokens, attributes)
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_TOKENS_OUTPUT, out_tokens, attributes)
        else:
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_USAGE_UNKNOWN, 1, attributes)
        if cache_known:
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_CACHE_READ_TOKENS, cached_tokens, attributes)
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_CACHE_WRITE_TOKENS, cache_write_tokens, attributes)
        else:
            telemetry_manager.increment_counter_metric(CounterMetricName.LLM_CACHE_USAGE_UNKNOWN, 1, attributes)
        telemetry_manager.increment_counter_metric(CounterMetricName.LLM_INVOCATIONS, 1, attributes)
        telemetry_manager.record_histogram_metric(HistogramMetricName.LLM_LATENCY_MS, latency, attributes)
        if not usage_known:
            await capture_int_key(TelemetryKeyName.llm_usage_unknown, project_id=project_id)
    except Exception as error:
        LOG.error("Completion telemetry failed (%s)", type(error).__name__)
    LOG.info("LLM usage: kind=%s model=%s tier=%s requested_tier=%s input=%s output=%s cache_read=%s cache_write=%s latency_ms=%.3f",
             kind, attributes["model"], attributes["service_tier"], requested_service_tier,
             in_tokens if usage_known else None, out_tokens if usage_known else None,
             cached_tokens if cache_known else None, cache_write_tokens if cache_known else None, latency)

async def llm_sanity_check():
    r = await llm_complete(
        DEFAULT_PROJECT_ID,
        "Reply with exactly OK, without punctuation or any other text.",
        max_completion_tokens=4096,
        usage_kind="startup_probe",
    )
    if not r.ok():
        raise ValueError(f"LLM sanity check failed: {r.msg()}")
    if r.data().strip() != "OK":
        raise ValueError("LLM sanity check failed: expected OK")
    LOG.info("LLM sanity check passed")
