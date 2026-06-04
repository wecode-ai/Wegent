"""Output helpers for the Wegent CLI."""

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

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


def format_table(
    headers: List[str], rows: List[List[str]], min_widths: Optional[List[int]] = None
) -> str:
    """Format data as a table."""
    if not rows:
        return "No resources found."

    widths = [len(h) for h in headers]
    if min_widths:
        widths = [max(w, mw) for w, mw in zip(widths, min_widths)]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    lines = []
    header_line = "  ".join(h.upper().ljust(widths[i]) for i, h in enumerate(headers))
    lines.append(header_line)
    for row in rows:
        row_line = "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row))
        lines.append(row_line)

    return "\n".join(lines)


def format_resource_list(resources: List[Dict[str, Any]], kind: str) -> str:
    """Format resource list as table."""
    if not resources:
        return f"No {kind}s found."

    headers = ["NAME", "NAMESPACE", "STATE", "AGE"]
    rows = []

    for res in resources:
        metadata = res.get("metadata", {})
        status = res.get("status", {})
        name = metadata.get("name", "")
        namespace = metadata.get("namespace", "default")
        state = status.get("state", "Unknown")

        created = metadata.get("createdAt") or status.get("createdAt")
        age = format_age(created) if created else "Unknown"

        rows.append([name, namespace, state, age])

    return format_table(headers, rows)


def format_resource_yaml(resource: Dict[str, Any]) -> str:
    """Format resource as YAML."""
    return yaml.dump(resource, default_flow_style=False, allow_unicode=True)


def format_resource_json(resource: Dict[str, Any]) -> str:
    """Format resource as JSON."""
    return json.dumps(resource, indent=2, ensure_ascii=False, default=str)


def format_age(timestamp: Any) -> str:
    """Format timestamp as age string."""
    if not timestamp:
        return "Unknown"

    try:
        if isinstance(timestamp, str):
            for fmt in [
                "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S",
            ]:
                try:
                    dt = datetime.strptime(timestamp.replace("Z", ""), fmt)
                    break
                except ValueError:
                    continue
            else:
                return "Unknown"
        elif isinstance(timestamp, datetime):
            dt = timestamp
        else:
            return "Unknown"

        delta = datetime.now() - dt
        seconds = delta.total_seconds()

        if seconds < 60:
            return f"{int(seconds)}s"
        if seconds < 3600:
            return f"{int(seconds // 60)}m"
        if seconds < 86400:
            return f"{int(seconds // 3600)}h"
        return f"{int(seconds // 86400)}d"
    except Exception:
        return "Unknown"


def format_describe(resource: Dict[str, Any]) -> str:
    """Format detailed resource description."""
    lines = []
    metadata = resource.get("metadata", {})
    spec = resource.get("spec", {})
    status = resource.get("status", {})

    lines.append(f"Name:         {metadata.get('name', '')}")
    lines.append(f"Namespace:    {metadata.get('namespace', 'default')}")
    lines.append(f"Kind:         {resource.get('kind', '')}")
    lines.append(f"API Version:  {resource.get('apiVersion', '')}")

    if metadata.get("displayName"):
        lines.append(f"Display Name: {metadata['displayName']}")

    created = metadata.get("createdAt") or status.get("createdAt")
    if created:
        lines.append(f"Created:      {created}")
    updated = metadata.get("updatedAt") or status.get("updatedAt")
    if updated:
        lines.append(f"Updated:      {updated}")

    lines.append("")
    lines.append("Status:")
    for key, value in status.items():
        if key not in ["createdAt", "updatedAt"]:
            lines.append(f"  {key}: {value}")

    lines.append("")
    lines.append("Spec:")
    lines.extend(_format_dict(spec, indent=2))

    return "\n".join(lines)


def _format_dict(d: Dict[str, Any], indent: int = 0) -> List[str]:
    """Format dictionary with indentation."""
    lines = []
    prefix = " " * indent

    for key, value in d.items():
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            lines.extend(_format_dict(value, indent + 2))
        elif isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    lines.append(f"{prefix}  -")
                    lines.extend(_format_dict(item, indent + 4))
                else:
                    lines.append(f"{prefix}  - {item}")
        else:
            lines.append(f"{prefix}{key}: {value}")

    return lines
