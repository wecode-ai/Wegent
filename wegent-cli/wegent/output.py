"""Output formatting utilities."""

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

import yaml


def format_table(
    headers: List[str], rows: List[List[str]], min_widths: Optional[List[int]] = None
) -> str:
    """Format data as a table."""
    if not rows:
        return "No resources found."

    # Calculate column widths
    widths = [len(h) for h in headers]
    if min_widths:
        widths = [max(w, mw) for w, mw in zip(widths, min_widths)]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    # Build table
    lines = []
    # Header
    header_line = "  ".join(h.upper().ljust(widths[i]) for i, h in enumerate(headers))
    lines.append(header_line)
    # Rows
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

        # Calculate age
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
            # Try different formats
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
        elif seconds < 3600:
            return f"{int(seconds // 60)}m"
        elif seconds < 86400:
            return f"{int(seconds // 3600)}h"
        else:
            return f"{int(seconds // 86400)}d"
    except Exception:
        return "Unknown"


def format_describe(resource: Dict[str, Any]) -> str:
    """Format detailed resource description."""
    lines = []
    metadata = resource.get("metadata", {})
    spec = resource.get("spec", {})
    status = resource.get("status", {})

    # Basic info
    lines.append(f"Name:         {metadata.get('name', '')}")
    lines.append(f"Namespace:    {metadata.get('namespace', 'default')}")
    lines.append(f"Kind:         {resource.get('kind', '')}")
    lines.append(f"API Version:  {resource.get('apiVersion', '')}")

    if metadata.get("displayName"):
        lines.append(f"Display Name: {metadata['displayName']}")

    # Timestamps
    created = metadata.get("createdAt") or status.get("createdAt")
    if created:
        lines.append(f"Created:      {created}")
    updated = metadata.get("updatedAt") or status.get("updatedAt")
    if updated:
        lines.append(f"Updated:      {updated}")

    # Status
    lines.append("")
    lines.append("Status:")
    for key, value in status.items():
        if key not in ["createdAt", "updatedAt"]:
            lines.append(f"  {key}: {value}")

    # Spec
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
