"""Output helpers for the Wegent CLI."""

import json
from typing import Any

import yaml

from .errors import CliError


def success_envelope(data: Any) -> dict[str, Any]:
    """Wrap successful command data in the stable JSON envelope."""
    return {"success": True, "data": data}


def error_envelope(error: CliError) -> dict[str, Any]:
    """Wrap a CLI error in the stable JSON envelope."""
    return {"success": False, "error": error.to_dict()}


def dumps_json(data: Any) -> str:
    """Serialize JSON for CLI output."""
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def dumps_yaml(data: Any) -> str:
    """Serialize YAML for CLI output."""
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def extract_response_text(response: dict[str, Any]) -> str:
    """Extract assistant output text from an OpenAI-compatible response object."""
    chunks: list[str] = []
    for item in response.get("output", []) or []:
        if item.get("type") != "message":
            continue
        if item.get("role") != "assistant":
            continue
        for content in item.get("content", []) or []:
            text = content.get("text")
            if text:
                chunks.append(str(text))
    return "\n".join(chunks)
