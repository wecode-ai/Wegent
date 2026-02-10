# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus utility functions.

Provides helper functions for route normalization, label handling, etc.
"""

import re
from typing import Optional


def normalize_route(route_template: Optional[str], path: str) -> str:
    """Normalize a route path to a consistent format.

    Uses the route template if available (from FastAPI), otherwise
    attempts to normalize the raw path by replacing UUIDs and numeric IDs.

    Args:
        route_template: The route template from FastAPI (e.g., "/api/v1/tasks/{task_id}")
        path: The actual request path (e.g., "/api/v1/tasks/123")

    Returns:
        Normalized endpoint string for use as a metric label.

    Examples:
        >>> normalize_route("/api/v1/tasks/{task_id}", "/api/v1/tasks/123")
        "/api/v1/tasks/{task_id}"
        >>> normalize_route(None, "/api/v1/tasks/123")
        "/api/v1/tasks/{id}"
    """
    if route_template:
        return route_template

    # Fallback: normalize the path by replacing IDs
    # Replace UUIDs (8-4-4-4-12 or just 32 hex chars)
    normalized = re.sub(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        "{uuid}",
        path,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(r"[0-9a-f]{32}", "{uuid}", normalized, flags=re.IGNORECASE)

    # Replace numeric IDs in path segments
    normalized = re.sub(r"/\d+(?=/|$)", "/{id}", normalized)

    return normalized


def get_route_template(request) -> Optional[str]:
    """Extract route template from FastAPI request.

    Args:
        request: FastAPI/Starlette Request object

    Returns:
        Route template string if available, None otherwise.
    """
    # Try to get route from request scope
    route = request.scope.get("route")
    if route and hasattr(route, "path"):
        return route.path
    return None


def sanitize_label(value: str, max_length: int = 128) -> str:
    """Sanitize a string for use as a Prometheus label value.

    Args:
        value: The value to sanitize
        max_length: Maximum length for the label value

    Returns:
        Sanitized label value
    """
    if not value:
        return ""

    # Truncate if too long
    if len(value) > max_length:
        value = value[:max_length]

    return value
