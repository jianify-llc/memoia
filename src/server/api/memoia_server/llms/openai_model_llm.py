# Modified for Memoia: relocated package and GPT-6 Luna request compatibility.
import time
from collections.abc import Awaitable, Callable
from openai import APIError
from .utils import get_openai_async_client_instance, get_error_usage, supports_prompt_cache_options
from ..env import CONFIG


async def openai_complete(
    model, prompt, system_prompt=None, history_messages=[],
    on_usage: Callable[..., Awaitable[None]] | None = None,
    cache_fixed_prompt: bool = False,
    **kwargs
) -> str:
    openai_async_client = get_openai_async_client_instance()
    messages = []
    if cache_fixed_prompt and not system_prompt:
        raise ValueError("Explicit caching requires fixed instructions")
    if cache_fixed_prompt and supports_prompt_cache_options(model):
        # One-shot extraction caches only instructions, never the unique source input.
        messages.append({"role": "developer", "content": [{
            "type": "text", "text": system_prompt,
            "prompt_cache_breakpoint": {"mode": "explicit"},
        }]})
        kwargs["prompt_cache_options"] = {"mode": "explicit", "ttl": "30m"}
    elif system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.extend(history_messages)
    messages.append({"role": "user", "content": prompt})

    if model == "gpt-6-luna":
        # 正式调用默认使用完整推理预算；启动探针可显式指定独立 completion 上限。
        kwargs.setdefault("reasoning_effort", CONFIG.llm_reasoning_effort)
        kwargs.pop("max_tokens", None)
        kwargs.setdefault("max_completion_tokens", 32768)
        for name in ("temperature", "top_p", "top_logprobs", "logprobs"):
            kwargs.pop(name, None)

    started = time.monotonic()
    async def report_usage(usage, *, actual_model=model, service_tier=None):
        if on_usage is None:
            return
        def value(obj, name):
            return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        details = value(usage, "prompt_tokens_details")
        await on_usage(value(usage, "prompt_tokens"), value(usage, "completion_tokens"),
                       (time.monotonic() - started) * 1000,
                       cached_tokens=value(details, "cached_tokens"),
                       cache_write_tokens=value(details, "cache_write_tokens"),
                       model=actual_model, service_tier=service_tier,
                       requested_service_tier=kwargs.get("service_tier", "auto"))

    try:
        response = await openai_async_client.chat.completions.create(
            model=model, messages=messages, timeout=120, **kwargs
        )
    except APIError as error:
        await report_usage(get_error_usage(error))
        raise
    usage = response.usage
    await report_usage(usage, actual_model=response.model,
                       service_tier=getattr(response, "service_tier", None))
    if not response.choices:
        raise ValueError("LLM returned no completion choices")
    choice = response.choices[0]
    if choice.message.refusal is not None:
        raise ValueError("LLM refused the completion")
    if choice.finish_reason != "stop":
        raise ValueError(f"LLM completion did not finish: {choice.finish_reason}")
    content = choice.message.content
    # 协议完整的空文本由业务层判断；None 不代表合法的空摘要。
    if not isinstance(content, str):
        raise ValueError("LLM returned no text content")

    return content
