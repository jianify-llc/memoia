# Modified for Memoia: relocated from the upstream memobase_server package.
import numpy as np
from typing import Literal
from .utils import get_openai_async_client_instance
from ...env import LOG, CONFIG


async def openai_embedding(
    model: str, texts: list[str], phase: Literal["query", "document"] = "document"
) -> np.ndarray:
    openai_async_client = get_openai_async_client_instance()
    # 查询的完整等待由检索子预算拥有，不能在短窗口内隐式重试。
    if phase == "query":
        openai_async_client = openai_async_client.with_options(max_retries=0)
    response = await openai_async_client.embeddings.create(
        model=model,
        input=texts,
        encoding_format="float",
        dimensions=CONFIG.embedding_dim,
    )

    prompt_tokens = getattr(response.usage, "prompt_tokens", None)
    total_tokens = getattr(response.usage, "total_tokens", None)
    LOG.info(f"OpenAI embedding, {model}, {phase}, {prompt_tokens}/{total_tokens}")
    if len(response.data) != len(texts):
        raise ValueError("Embedding response count mismatch")
    indices = [dp.index for dp in response.data]
    if sorted(indices) != list(range(len(texts))):
        raise ValueError("Embedding response indices are incomplete or duplicated")
    vectors = np.asarray([dp.embedding for dp in sorted(response.data, key=lambda dp: dp.index)], dtype=float)
    if vectors.shape != (len(texts), CONFIG.embedding_dim) or not np.isfinite(vectors).all():
        raise ValueError("Embedding response has invalid dimensions or non-finite values")
    return vectors
