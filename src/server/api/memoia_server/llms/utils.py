# Modified for Memoia: relocated from the upstream memobase_server package.
import logging
import re

from openai import AsyncOpenAI, APIStatusError
from ..env import CONFIG

# Transport DEBUG includes request bodies, including before AgentLoop is imported.
logging.getLogger("openai._base_client").setLevel(logging.WARNING)

_global_openai_async_client = None


def get_openai_async_client_instance() -> AsyncOpenAI:
    global _global_openai_async_client
    if _global_openai_async_client is None:
        _global_openai_async_client = AsyncOpenAI(
            base_url=CONFIG.llm_base_url,
            api_key=CONFIG.llm_api_key,
            default_query=CONFIG.llm_openai_default_query,
            default_headers=CONFIG.llm_openai_default_header,
            # Operation recovery owns retries; the SDK must not hide extra attempts.
            max_retries=0,
        )
    return _global_openai_async_client


def supports_prompt_cache_options(model: str) -> bool:
    """Only known new-cache model families opt in; unknown aliases keep defaults."""
    return re.fullmatch(
        r"gpt-(?:5\.6|6(?:\.1)?)(?:-(?:luna|sol|astra))?(?:-\d{4}-\d{2}-\d{2})?",
        model,
    ) is not None


def get_error_usage(error):
    """Preserve reported failure usage; a transport failure is not zero usage."""
    if not isinstance(error, APIStatusError):
        return None
    if isinstance(error.body, dict) and "usage" in error.body:
        return error.body["usage"]
    try:
        body = error.response.json()
    except ValueError:
        return None
    return body.get("usage") if isinstance(body, dict) else None
