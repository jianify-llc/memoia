# Modified for Memoia: relocated from the upstream memobase_server package.
import logging
import re
from urllib.parse import urlsplit

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
    """Both model and endpoint must support the contract; no capability probes."""
    known_model = re.fullmatch(
        r"gpt-(?:5\.6|6(?:\.1)?)(?:-(?:luna|sol|astra|terra))?(?:-\d{4}-\d{2}-\d{2})?",
        model,
    ) is not None
    if not known_model or CONFIG.llm_prompt_cache_options is False:
        return False
    if CONFIG.llm_base_url is None:
        return True  # The SDK's native HTTPS OpenAI endpoint.
    try:
        url = urlsplit(CONFIG.llm_base_url)
        port = url.port
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            return False
        native = (url.scheme == "https" and url.hostname == "api.openai.com" and
                  port in (None, 443) and url.path.rstrip("/") == "/v1")
        return native or CONFIG.llm_prompt_cache_options is True
    except ValueError:
        return False


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
