# Modified for Memoia: relocated from the upstream memobase_server package.
from functools import partial
from ..prompts.utils import convert_response_to_json
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
    json_mode=False,
    model=None,
    max_tokens=1024,
    **kwargs,
) -> Promise[str | dict]:
    use_model = model or CONFIG.best_llm_model
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    try:
        results = await openai_complete(
            use_model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            max_tokens=max_tokens,
            on_usage=partial(record_completion_usage, project_id),
            **kwargs,
        )
    except Exception as e:
        LOG.error("LLM completion failed (%s)", type(e).__name__)
        return Promise.reject(CODE.SERVICE_UNAVAILABLE, "LLM completion failed")

    if not json_mode:
        return Promise.resolve(results)
    parse_dict = convert_response_to_json(results)
    if parse_dict is not None:
        return Promise.resolve(parse_dict)
    else:
        return Promise.reject(
            CODE.UNPROCESSABLE_ENTITY, "Failed to parse JSON response"
        )


async def record_completion_usage(project_id, in_tokens, out_tokens, latency):
    # Await the small accounting write; it must not inherit a memory-write fence or
    # escape as a detached task after the request's lease and process have ended.
    usage_known = all(type(value) is int and value >= 0 for value in (in_tokens, out_tokens))
    if usage_known:
        try:
            result = await project_cost_token_billing(project_id, in_tokens, out_tokens)
            if not result.ok():
                LOG.warning("Completion accounting rejected (%s)", result.code())
        except Exception as error:
            LOG.error("Completion accounting failed (%s)", type(error).__name__)
        telemetry_manager.increment_counter_metric(CounterMetricName.LLM_TOKENS_INPUT, in_tokens,
                                                   {"project_id": project_id})
        telemetry_manager.increment_counter_metric(CounterMetricName.LLM_TOKENS_OUTPUT, out_tokens,
                                                   {"project_id": project_id})
    else:
        LOG.warning("Completion token usage unknown; no token estimate or debit recorded")
        await capture_int_key(TelemetryKeyName.llm_usage_unknown, project_id=project_id)
        telemetry_manager.increment_counter_metric(CounterMetricName.LLM_USAGE_UNKNOWN, 1,
                                                   {"project_id": project_id})
    telemetry_manager.increment_counter_metric(
        CounterMetricName.LLM_INVOCATIONS,
        1,
        {"project_id": project_id},
    )
    telemetry_manager.record_histogram_metric(
        HistogramMetricName.LLM_LATENCY_MS,
        latency,
        {"project_id": project_id},
    )

async def llm_sanity_check():
    r = await llm_complete(
        DEFAULT_PROJECT_ID,
        "Reply with exactly OK, without punctuation or any other text.",
        max_completion_tokens=4096,
        prompt_id="__test__",
    )
    if not r.ok():
        raise ValueError(f"LLM sanity check failed: {r.msg()}")
    if r.data().strip() != "OK":
        raise ValueError("LLM sanity check failed: expected OK")
    LOG.info("LLM sanity check passed")
