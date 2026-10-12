# Memoia one-shot Responses boundary; task/transaction recovery owns retries.
import time
from collections.abc import Awaitable, Callable
from openai import APIError
from .utils import get_openai_async_client_instance, get_error_usage, supports_prompt_cache_options
from ..env import CONFIG, LOG


async def openai_complete(
    model, prompt, system_prompt=None,
    on_usage: Callable[..., Awaitable[None]] | None = None,
    cache_fixed_prompt: bool = False,
    **kwargs
) -> str:
    openai_async_client = get_openai_async_client_instance()
    inputs = []
    if cache_fixed_prompt and not system_prompt:
        raise ValueError("Explicit caching requires fixed instructions")
    if cache_fixed_prompt:
        LOG.info("Prompt cache contract: kind=fact_extraction enabled=%s", supports_prompt_cache_options(model))
    cache_enabled = cache_fixed_prompt and supports_prompt_cache_options(model)
    if system_prompt:
        # One-shot extraction caches only instructions, never the unique source input.
        fixed = {"type": "input_text", "text": system_prompt}
        if cache_enabled:
            fixed["prompt_cache_breakpoint"] = {"mode": "explicit"}
        inputs.append({"role": "developer", "content": [fixed]})
    if cache_enabled:
        kwargs["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
    # An extraction's source is reference material, not a fabricated current user.
    inputs.append({"role": "developer" if cache_fixed_prompt else "user",
                   "content": [{"type": "input_text", "text": prompt}]})

    if model == "gpt-6-luna":
        # 正式调用默认使用完整推理预算；启动探针可显式指定独立 completion 上限。
        kwargs.setdefault("reasoning", {"effort": CONFIG.llm_reasoning_effort})
        kwargs.setdefault("max_output_tokens", 32768)
        for name in ("temperature", "top_p", "top_logprobs", "logprobs"):
            kwargs.pop(name, None)

    started = time.monotonic()
    async def report_usage(usage, *, actual_model=model, service_tier=None):
        if on_usage is None:
            return
        def value(obj, name):
            return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        details = value(usage, "input_tokens_details")
        await on_usage(value(usage, "input_tokens"), value(usage, "output_tokens"),
                       (time.monotonic() - started) * 1000,
                       cached_tokens=value(details, "cached_tokens"),
                       cache_write_tokens=value(details, "cache_write_tokens"),
                       model=actual_model, service_tier=service_tier,
                       requested_service_tier=kwargs.get("service_tier", "auto"))

    try:
        response = await openai_async_client.responses.create(
            model=model, input=inputs, store=False, truncation="disabled", timeout=120, **kwargs
        )
    except APIError as error:
        await report_usage(get_error_usage(error))
        raise
    usage = response.usage
    await report_usage(usage, actual_model=response.model,
                       service_tier=getattr(response, "service_tier", None))
    # Observe provider usage before protocol and business/schema validation.
    if response.status != "completed" or response.error is not None:
        raise ValueError("LLM response did not complete")
    texts = []
    for item in response.output:
        if item.type == "reasoning":
            continue
        # One-shot callers have no tools. Never silently drop refusal/tool output.
        if item.type != "message" or item.role != "assistant" or item.status != "completed":
            raise ValueError("LLM returned unexpected output")
        for part in item.content:
            if part.type != "output_text" or not isinstance(part.text, str):
                raise ValueError("LLM returned no valid text content")
            texts.append(part.text)
    if not texts:
        raise ValueError("LLM returned no text output")
    # Explicit empty text remains for business callers to validate, as before.
    return "".join(texts)
