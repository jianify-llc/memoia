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


def user_cache_key(project_id: str, user_id: str) -> str:
    # Compact JSON avoids delimiter collisions and keeps project/user scope stable
    # across processes, retries and batches without sending the raw identity.
    identity = json.dumps([str(project_id), str(user_id)], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode()).hexdigest()
