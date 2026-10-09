# Modified for Memoia: relocated package and GPT-6 Luna request compatibility.
import time
from collections.abc import Awaitable, Callable
from .utils import exclude_special_kwargs, get_openai_async_client_instance
from ..env import CONFIG, LOG


async def openai_complete(
    model, prompt, system_prompt=None, history_messages=[],
    on_usage: Callable[[int | None, int | None, float], Awaitable[None]] | None = None,
    **kwargs
) -> str:
    sp_args, kwargs = exclude_special_kwargs(kwargs)
    prompt_id = sp_args.get("prompt_id", None)

    openai_async_client = get_openai_async_client_instance()
    messages = []
    if system_prompt:
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
    response = await openai_async_client.chat.completions.create(
        model=model, messages=messages, timeout=120, **kwargs
    )
    usage = response.usage
    if on_usage is not None:
        await on_usage(getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None),
                       (time.monotonic() - started) * 1000)
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

    cached_tokens = getattr(
        getattr(usage, "prompt_tokens_details", None), "cached_tokens", None
    )
    LOG.info(
        f"Cached {prompt_id} {model} {cached_tokens}/{getattr(usage, 'prompt_tokens', None)}"
    )
    return content
