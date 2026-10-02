# Modified for Memoia: relocated from the upstream memobase_server package.
import time
from typing import Literal
import numpy as np
from openai import BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError
from traceback import format_exc
from ...env import CONFIG, LOG
from ...models.utils import Promise
from ...models.response import CODE
from ...models.database import DEFAULT_PROJECT_ID
from .jina_embedding import jina_embedding
from .openai_embedding import openai_embedding
from .lmstudio_embedding import lmstudio_embedding
from .ollama_embedding import ollama_embedding
from ...telemetry import telemetry_manager, HistogramMetricName, CounterMetricName
from ...utils import get_encoded_tokens

FACTORIES = {"openai": openai_embedding, "jina": jina_embedding, "lmstudio": lmstudio_embedding, "ollama": ollama_embedding}
assert (
    CONFIG.embedding_provider in FACTORIES
), f"Unsupported embedding provider: {CONFIG.embedding_provider}"


async def check_embedding_sanity():
    if not CONFIG.enable_event_embedding:
        LOG.info("Event embedding is disabled, skipping sanity check.")
        return
    r = await get_embedding(DEFAULT_PROJECT_ID, ["Hello, world!"])
    if not r.ok():
        raise ValueError(
            "Embedding API check failed! Make sure the embedding API key is valid."
        )
    d = r.data()
    embedding_dim = d.shape[-1]
    if embedding_dim != CONFIG.embedding_dim:
        raise ValueError(
            f"Embedding dimension mismatch! Expected {CONFIG.embedding_dim}, got {embedding_dim}."
        )
    LOG.info(f"Embedding dimension matched: {embedding_dim}")


async def get_embedding(
    project_id: str,
    texts: list[str],
    phase: Literal["query", "document"] = "document",
    model: str = None,
) -> Promise[np.ndarray]:
    model = model or CONFIG.embedding_model
    if not texts:
        return Promise.resolve(np.empty((0, CONFIG.embedding_dim)))
    if CONFIG.embedding_batch_size < 1:
        return Promise.reject(CODE.SERVICE_UNAVAILABLE, "Invalid embedding batch configuration")
    if any(len(get_encoded_tokens(text)) > CONFIG.embedding_max_token_size for text in texts):
        return Promise.reject(CODE.BAD_REQUEST, "Embedding input exceeds complete-text limit")
    try:
        start_time = time.time()
        batches = []
        for start in range(0, len(texts), CONFIG.embedding_batch_size):
            batch = texts[start:start + CONFIG.embedding_batch_size]
            vectors = np.asarray(await FACTORIES[CONFIG.embedding_provider](model, batch, phase), dtype=float)
            if vectors.shape != (len(batch), CONFIG.embedding_dim) or not np.isfinite(vectors).all():
                raise ValueError("Invalid embedding count, dimension or values")
            batches.append(vectors)
        results = np.concatenate(batches, axis=0)
        latency_ms = (time.time() - start_time) * 1000
    except (BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError) as e:
        LOG.error("Embedding configuration rejected", error_type=type(e).__name__)
        return Promise.reject(CODE.UNPROCESSABLE_ENTITY, "Embedding configuration rejected")
    except Exception as e:
        LOG.error("Embedding generation failed", error_type=type(e).__name__)
        return Promise.reject(CODE.SERVICE_UNAVAILABLE, "Embedding generation failed")
    embedding_tokens = len(get_encoded_tokens("\n".join(texts)))
    telemetry_manager.increment_counter_metric(
        CounterMetricName.EMBEDDING_TOKENS,
        embedding_tokens,
        {"project_id": project_id},
    )
    telemetry_manager.record_histogram_metric(
        HistogramMetricName.EMBEDDING_LATENCY_MS,
        latency_ms,
        {"project_id": project_id},
    )
    return Promise.resolve(results)
