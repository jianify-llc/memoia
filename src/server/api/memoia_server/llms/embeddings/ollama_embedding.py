# Modified for Memoia: relocated from the upstream memobase_server package.
import numpy as np
from typing import Literal
from ...errors import ExternalAPIError
from ...env import CONFIG, LOG
from .utils import get_ollama_async_client_instance

OLLAMA_TASK = {
    "query": "retrieval.query",
    "document": "retrieval.passage",
}


async def ollama_embedding(
    model: str, texts: list[str], phase: Literal["query", "document"] = "document"
) -> np.ndarray:
    openai_async_client = get_ollama_async_client_instance()
    response = await openai_async_client.post(
        "/api/embed",
        json={
            "model": model,
            "input": texts,
            # "task": OLLAMA_TASK[phase],
            "truncate": True,
            "dimensions": CONFIG.embedding_dim,
        },
        timeout=10,
    )
    if response.status_code != 200:
        raise ExternalAPIError("Embedding request rejected", status_code=response.status_code)
    data = response.json()
    LOG.info(
        f"Ollama embedding, {model}, {data['load_duration']}/{data['total_duration']}"
    )
    return np.array(data["embeddings"])
