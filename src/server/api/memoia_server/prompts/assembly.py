"""Reference data and cache identity only; never owns model or business state."""
import hashlib
import json
from html import escape


def reference_data(name: str, value) -> str:
    # Callers supply a fixed tag, not an external name. XML preserves data boundaries,
    # not trust: fixed instructions must still prohibit executing source instructions.
    return f'<{name} source="memoia">{escape(json.dumps(value, ensure_ascii=False), quote=False)}</{name}>'


def developer_data(name: str, value, *, cache: bool = False) -> dict:
    content = {"type": "input_text", "text": reference_data(name, value)}
    if cache:
        content["prompt_cache_breakpoint"] = {"mode": "explicit"}
    return {"role": "developer", "content": [content]}


def loop_cache_key(project_id: str, user_id: str, operation_id: str) -> str:
    # The server-owned flush identity survives retries and recovery, not new batches.
    # Structured encoding avoids delimiter collisions and hides raw scoped identities.
    identity = json.dumps(["memoia", "flush", str(project_id), str(user_id), str(operation_id)],
                          ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode()).hexdigest()
