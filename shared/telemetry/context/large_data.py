# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Helper functions for logging large data to span events instead of attributes.

Large data (like full request/response bodies, long lists of IDs) should be stored
in span events rather than span attributes to reduce storage size and improve
query performance. These helpers provide a consistent pattern for:
1. Storing metadata (length, preview) in span attributes for filtering
2. Storing full data in span events for debugging
"""

import json
import logging
from typing import Any, Dict, List, Optional

from shared.telemetry.context.span import add_span_event, set_span_attributes

logger = logging.getLogger(__name__)


def log_large_attribute(
    attribute_name: str,
    data: Any,
    max_attr_length: int = 100,
    max_event_length: int = 10000,
    event_name: Optional[str] = None,
    extra_attributes: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Log large data by storing full data in span event and metadata in span attribute.

    This pattern reduces storage size while preserving debugging capability:
    - Span attribute: {attribute_name}.length + truncated preview (for filtering)
    - Span event: full data (truncated to max_event_length)

    Args:
        attribute_name: Base name for the attribute (e.g., "request.body")
        data: The data to log (will be converted to string)
        max_attr_length: Maximum length for the attribute preview (default: 100)
        max_event_length: Maximum length for the event data (default: 10000)
        event_name: Optional custom event name (default: "{attribute_name}.data")
        extra_attributes: Optional additional attributes to include in the event
    """
    try:
        # Convert data to string
        if isinstance(data, str):
            data_str = data
        else:
            data_str = str(data)

        # Build attribute metadata
        data_length = len(data_str)
        preview = data_str[:max_attr_length]
        if len(data_str) > max_attr_length:
            preview += "..."

        attributes = {
            f"{attribute_name}.length": data_length,
            f"{attribute_name}.preview": preview,
        }
        set_span_attributes(attributes)

        # Build event data
        event_data = data_str[:max_event_length]
        if len(data_str) > max_event_length:
            event_data += f"...[truncated from {data_length} chars]"

        event_attrs: Dict[str, Any] = {"data": event_data}
        if extra_attributes:
            event_attrs.update(extra_attributes)

        event_name = event_name or f"{attribute_name}.data"
        add_span_event(event_name, event_attrs)

    except Exception as e:
        logger.debug(f"Failed to log large attribute {attribute_name}: {e}")


def log_large_string_list(
    attribute_name: str,
    items: List[str],
    max_attr_items: int = 5,
    max_event_items: int = 1000,
    event_name: Optional[str] = None,
) -> None:
    """
    Log a large list of strings by storing full list in span event and metadata in attribute.

    This is useful for logging lists of IDs, file paths, etc.:
    - Span attribute: {attribute_name}.count + preview of first N items
    - Span event: full list (up to max_event_items)

    Args:
        attribute_name: Base name for the attribute (e.g., "file.ids", "tool.calls")
        items: List of strings to log
        max_attr_items: Maximum number of items in attribute preview (default: 5)
        max_event_items: Maximum number of items in event (default: 1000)
        event_name: Optional custom event name (default: "{attribute_name}.list")
    """
    try:
        # Build attribute metadata
        item_count = len(items)
        preview_items = items[:max_attr_items]

        attributes = {
            f"{attribute_name}.count": item_count,
            f"{attribute_name}.preview": json.dumps(preview_items),
        }
        set_span_attributes(attributes)

        # Build event data
        event_items = items[:max_event_items]
        event_attrs: Dict[str, Any] = {"items": json.dumps(event_items)}

        if item_count > max_event_items:
            event_attrs["truncated"] = True
            event_attrs["total_count"] = item_count

        event_name = event_name or f"{attribute_name}.list"
        add_span_event(event_name, event_attrs)

    except Exception as e:
        logger.debug(f"Failed to log large string list {attribute_name}: {e}")


def log_json_body(
    attribute_name: str,
    body: Any,
    max_attr_preview: int = 100,
    max_event_size: int = 10000,
) -> None:
    """
    Log HTTP JSON body by extracting common fields to attributes and full body to event.

    This is specialized for HTTP request/response bodies:
    - Span attributes: has_messages, message_count, model, task_id, is_stream, preview
    - Span event: full JSON body (truncated to max_event_size)

    Args:
        attribute_name: Base name for the attribute (e.g., "request.body", "response.body")
        body: The JSON body (dict, list, string, or bytes)
        max_attr_preview: Maximum length for the preview attribute (default: 100)
        max_event_size: Maximum size for the event body (default: 10000)
    """
    try:
        # Handle bytes input (common for HTTP bodies)
        if isinstance(body, bytes):
            try:
                body = body.decode("utf-8", errors="replace")
            except Exception:
                body = str(body)

        # Parse body if it's a string
        if isinstance(body, str):
            try:
                parsed_body = json.loads(body)
            except json.JSONDecodeError:
                # Not valid JSON, treat as plain text
                log_large_attribute(
                    attribute_name=attribute_name,
                    data=body,
                    max_attr_length=max_attr_preview,
                    max_event_length=max_event_size,
                    event_name=f"{attribute_name}.json",
                )
                return
        else:
            parsed_body = body

        # Build attribute metadata with common fields
        attributes: Dict[str, Any] = {}

        # Extract common fields if present
        if isinstance(parsed_body, dict):
            # Check for messages
            messages = parsed_body.get("messages")
            if messages is not None:
                attributes[f"{attribute_name}.has_messages"] = True
                if isinstance(messages, list):
                    attributes[f"{attribute_name}.message_count"] = len(messages)
            else:
                attributes[f"{attribute_name}.has_messages"] = False

            # Check for model
            model = parsed_body.get("model")
            if model:
                attributes[f"{attribute_name}.model"] = model

            # Check for task_id
            task_id = parsed_body.get("task_id")
            if task_id is not None:
                attributes[f"{attribute_name}.task_id"] = task_id

            # Check for stream flag
            is_stream = parsed_body.get("stream", False)
            attributes[f"{attribute_name}.is_stream"] = bool(is_stream)

        # Add preview
        body_str = json.dumps(parsed_body) if not isinstance(body, str) else body
        preview = body_str[:max_attr_preview]
        if len(body_str) > max_attr_preview:
            preview += "..."
        attributes[f"{attribute_name}.preview"] = preview
        attributes[f"{attribute_name}.length"] = len(body_str)

        set_span_attributes(attributes)

        # Build event data
        event_body = body_str[:max_event_size]
        if len(body_str) > max_event_size:
            event_body += f"...[truncated from {len(body_str)} chars]"

        add_span_event(f"{attribute_name}.json", {"body": event_body})

    except Exception as e:
        logger.debug(f"Failed to log JSON body {attribute_name}: {e}")
