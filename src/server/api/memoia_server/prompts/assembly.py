"""Escaped reference data only; never owns model or business state."""
import json
from html import escape


def reference_data(name: str, value) -> str:
    # Callers supply a fixed tag, not an external name. XML preserves data boundaries,
    # not trust: fixed instructions must still prohibit executing source instructions.
    return f'<{name} source="memoia">{escape(json.dumps(value, ensure_ascii=False), quote=False)}</{name}>'


def developer_data(name: str, value) -> dict:
    content = {"type": "input_text", "text": reference_data(name, value)}
    return {"role": "developer", "content": [content]}
