# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schema extractor for MCP tools.

This module provides functions to extract parameter and response schemas from
FastAPI endpoint signatures and Pydantic models, enabling automatic MCP tool
documentation generation.
"""

import inspect
import logging
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Type,
    Union,
    get_args,
    get_origin,
)

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

logger = logging.getLogger(__name__)


# ============== Parameter Extraction ==============


def extract_tool_parameters(func: Callable) -> List[Dict[str, Any]]:
    """Extract MCP tool parameters from FastAPI endpoint signature.

    Handles:
    - Path parameters (from Path())
    - Query parameters (from Query())
    - Body parameters (from Pydantic models)
    - Filters out dependency injections (Depends())
    - Filters out FastAPI special injection types (BackgroundTasks, Request, etc.)

    Args:
        func: The FastAPI endpoint function

    Returns:
        List of parameter definitions for MCP tool schema
    """
    sig = inspect.signature(func)

    # Get type hints, handling potential errors
    try:
        type_hints = _get_type_hints_safe(func)
    except Exception as e:
        logger.warning(f"Failed to get type hints for {func.__name__}: {e}")
        type_hints = {}

    parameters = []

    for param_name, param in sig.parameters.items():
        # Skip dependency injection parameters
        if _is_dependency(param):
            continue

        param_type = type_hints.get(param_name, str)

        # Skip FastAPI special injection types (BackgroundTasks, Request, etc.)
        if _is_fastapi_special_type(param_type):
            logger.debug(
                f"Skipping FastAPI special type parameter: {param_name} ({param_type})"
            )
            continue

        # Handle Pydantic Body parameters - flatten into individual params
        if _is_pydantic_body(param_type):
            flattened = _flatten_pydantic_model(param_type)
            parameters.extend(flattened)
            continue

        # Extract regular parameter info
        param_info = _extract_param_info(param_name, param, param_type)
        if param_info:
            parameters.append(param_info)

    return parameters


def _get_type_hints_safe(func: Callable) -> Dict[str, Any]:
    """Safely get type hints, handling forward references."""
    try:
        # Try with include_extras for Python 3.11+
        return inspect.get_annotations(func, eval_str=True)
    except (NameError, AttributeError):
        # Fallback for older Python or forward reference issues
        try:
            from typing import get_type_hints

            return get_type_hints(func)
        except Exception:
            return {}


def _is_dependency(param: inspect.Parameter) -> bool:
    """Check if parameter is a FastAPI dependency (db, current_user, etc.).

    This function detects:
    1. Parameters with Depends() marker (explicit dependency injection)
    2. Parameters with common dependency names (db, current_user, background_tasks)
    3. FastAPI special injection types (BackgroundTasks, Request, Response)

    Args:
        param: The inspect.Parameter to check

    Returns:
        True if the parameter is a FastAPI dependency that should be filtered out
    """
    # Check for Depends() marker - works for parameters with default values
    default = param.default
    if default is not inspect.Parameter.empty and hasattr(default, "dependency"):
        return True

    # Check for common dependency parameter names as fallback
    # This catches cases where Depends() might not be directly accessible
    if param.name in ("db", "current_user", "background_tasks"):
        return True

    return False


def _is_fastapi_special_type(param_type: Any) -> bool:
    """Check if a type is a FastAPI special injection type.

    FastAPI automatically injects certain types without requiring Depends():
    - BackgroundTasks: For scheduling background tasks
    - Request: For accessing the raw request
    - Response: For modifying the response
    - WebSocket: For WebSocket connections

    Args:
        param_type: The type annotation to check

    Returns:
        True if the type is a FastAPI special injection type
    """
    if param_type is None:
        return False

    # Get the actual type name for comparison
    type_name = getattr(param_type, "__name__", str(param_type))

    # List of FastAPI special injection types
    fastapi_special_types = {
        "BackgroundTasks",
        "Request",
        "Response",
        "WebSocket",
        "HTTPConnection",
    }

    return type_name in fastapi_special_types


def _is_pydantic_body(param_type: Any) -> bool:
    """Check if parameter type is a Pydantic model (Body parameter)."""
    if param_type is None:
        return False
    try:
        return inspect.isclass(param_type) and issubclass(param_type, BaseModel)
    except TypeError:
        return False


def _extract_param_info(
    name: str, param: inspect.Parameter, param_type: Any
) -> Optional[Dict[str, Any]]:
    """Extract parameter info for MCP schema."""
    description = _get_param_description(param)
    default_value = _get_default_value(param)
    is_required = param.default is inspect.Parameter.empty

    # Handle Optional[X] - check if type is optional
    if _is_optional_type(param_type):
        is_required = False
        param_type = _unwrap_optional(param_type)

    json_type = _python_type_to_json_type(param_type)

    result: Dict[str, Any] = {
        "name": name,
        "type": json_type,
        "description": description,
        "required": is_required,
    }

    if default_value is not None:
        result["default"] = default_value

    return result


def _get_param_description(param: inspect.Parameter) -> str:
    """Extract description from FastAPI Query/Path/Body."""
    default = param.default
    if default is inspect.Parameter.empty:
        return ""

    # Try to get description from FastAPI field info
    if hasattr(default, "description") and default.description:
        return default.description

    return ""


def _get_default_value(param: inspect.Parameter) -> Any:
    """Extract default value, handling FastAPI field types."""
    default = param.default
    if default is inspect.Parameter.empty:
        return None

    # Check for FastAPI Query/Path/Body default value
    if hasattr(default, "default"):
        val = default.default
        # Handle PydanticUndefined sentinel
        if val is not None and val is not PydanticUndefined:
            return val
        return None

    # Check if it's a simple default value
    if isinstance(default, (str, int, float, bool)):
        return default

    return None


def _is_optional_type(param_type: Any) -> bool:
    """Check if type is Optional[X]."""
    origin = get_origin(param_type)
    if origin is Union:
        args = get_args(param_type)
        return type(None) in args
    return False


def _unwrap_optional(param_type: Any) -> Any:
    """Unwrap Optional[X] to get X."""
    origin = get_origin(param_type)
    if origin is Union:
        args = get_args(param_type)
        non_none_args = [a for a in args if a is not type(None)]
        if non_none_args:
            return non_none_args[0]
    return param_type


def _python_type_to_json_type(py_type: Any) -> str:
    """Convert Python type to JSON schema type."""
    if py_type is None:
        return "string"

    origin = get_origin(py_type)

    # Handle Optional[X] -> X
    if origin is Union:
        args = get_args(py_type)
        non_none_args = [a for a in args if a is not type(None)]
        if non_none_args:
            py_type = non_none_args[0]
            origin = get_origin(py_type)

    # Handle List[X]
    if origin is list:
        return "array"

    # Handle Dict[K, V]
    if origin is dict:
        return "object"

    # Handle basic types
    type_map = {
        str: "string",
        int: "integer",
        float: "number",
        bool: "boolean",
        list: "array",
        dict: "object",
        bytes: "string",
    }

    return type_map.get(py_type, "string")


def _flatten_pydantic_model(model: Type[BaseModel]) -> List[Dict[str, Any]]:
    """Flatten Pydantic model fields into individual parameters."""
    parameters = []

    for field_name, field_info in model.model_fields.items():
        annotation = field_info.annotation
        json_type = _python_type_to_json_type(annotation)

        param_info: Dict[str, Any] = {
            "name": field_name,
            "type": json_type,
            "description": field_info.description or "",
            "required": field_info.is_required(),
        }

        # Get default value using PydanticUndefined sentinel
        if (
            field_info.default is not None
            and field_info.default is not PydanticUndefined
        ):
            param_info["default"] = field_info.default

        parameters.append(param_info)

    return parameters


# ============== Response Schema Extraction ==============


def extract_response_schema(
    func: Callable, explicit_model: Optional[Type[BaseModel]] = None
) -> Optional[Dict[str, Any]]:
    """Extract response schema from FastAPI endpoint.

    Priority:
    1. Explicit response_model from @mcp_tool decorator
    2. Return type hint from function signature
    3. None (no schema available)

    Args:
        func: The endpoint function
        explicit_model: Explicitly specified response model from @mcp_tool

    Returns:
        Response schema dict with structure description, or None
    """
    model = explicit_model

    # Try to get from function's return type hint if no explicit model
    if model is None:
        try:
            type_hints = _get_type_hints_safe(func)
            return_type = type_hints.get("return")
            if return_type and _is_pydantic_body(return_type):
                model = return_type
        except Exception as e:
            logger.debug(f"Could not extract return type for {func.__name__}: {e}")

    if model is None:
        return None

    return _pydantic_model_to_schema(model)


def _pydantic_model_to_schema(
    model: Type[BaseModel], max_depth: int = 3, current_depth: int = 0
) -> Dict[str, Any]:
    """Convert Pydantic model to response schema description.

    Args:
        model: Pydantic model class
        max_depth: Maximum recursion depth for nested models
        current_depth: Current recursion depth

    Returns:
        A structured description suitable for MCP tool documentation.
    """
    if current_depth >= max_depth:
        return {"type": "object", "description": f"{model.__name__} (nested)"}

    schema: Dict[str, Any] = {
        "type": "object",
        "description": model.__doc__ or f"{model.__name__} response",
        "properties": {},
    }

    required_fields = []

    for field_name, field_info in model.model_fields.items():
        field_schema = _field_to_schema(field_info, max_depth, current_depth)
        schema["properties"][field_name] = field_schema

        if field_info.is_required():
            required_fields.append(field_name)

    if required_fields:
        schema["required"] = required_fields

    return schema


def _field_to_schema(
    field_info: Any, max_depth: int = 3, current_depth: int = 0
) -> Dict[str, Any]:
    """Convert a single Pydantic field to schema."""
    annotation = field_info.annotation
    origin = get_origin(annotation)

    field_schema: Dict[str, Any] = {
        "type": _python_type_to_json_type(annotation),
    }

    if field_info.description:
        field_schema["description"] = field_info.description

    # Handle Optional[X]
    if origin is Union:
        args = get_args(annotation)
        non_none_args = [a for a in args if a is not type(None)]
        if non_none_args:
            annotation = non_none_args[0]
            origin = get_origin(annotation)
            field_schema["type"] = _python_type_to_json_type(annotation)

    # Handle List[SomeModel]
    if origin is list:
        args = get_args(annotation)
        if args and _is_pydantic_body(args[0]):
            field_schema["items"] = _pydantic_model_to_schema(
                args[0], max_depth, current_depth + 1
            )

    # Handle nested Pydantic models
    elif _is_pydantic_body(annotation):
        field_schema = _pydantic_model_to_schema(
            annotation, max_depth, current_depth + 1
        )

    return field_schema


# ============== Docstring Generation ==============


def generate_tool_docstring(
    name: str,
    description: str,
    parameters: List[Dict[str, Any]],
    response_schema: Optional[Dict[str, Any]],
) -> str:
    """Generate comprehensive docstring for MCP tool including response schema.

    This docstring will be used by LLM to understand the tool's behavior.

    Args:
        name: Tool name
        description: Tool description
        parameters: List of parameter definitions
        response_schema: Response schema dict

    Returns:
        Formatted docstring string
    """
    lines = [f"Tool: {name}", "", description, ""]

    # Parameters section
    if parameters:
        lines.append("Args:")
        for param in parameters:
            param_desc = param.get("description", "")
            param_type = param.get("type", "string")
            required = "required" if param.get("required") else "optional"
            default = param.get("default")

            line = f"    {param['name']} ({param_type}, {required})"
            if default is not None:
                line += f" [default: {default}]"
            if param_desc:
                line += f": {param_desc}"
            lines.append(line)
        lines.append("")

    # Returns section
    lines.append("Returns:")
    lines.append("    JSON string with the following structure:")

    if response_schema:
        lines.extend(_schema_to_docstring_lines(response_schema, indent=4))
    else:
        lines.append('    {"data": ...}')

    return "\n".join(lines)


def _schema_to_docstring_lines(schema: Dict[str, Any], indent: int = 0) -> List[str]:
    """Convert schema to human-readable docstring lines."""
    lines = []
    prefix = " " * indent

    if schema.get("type") == "object":
        properties = schema.get("properties", {})
        for prop_name, prop_schema in properties.items():
            prop_type = prop_schema.get("type", "any")
            prop_desc = prop_schema.get("description", "")

            line = f"{prefix}- {prop_name} ({prop_type})"
            if prop_desc:
                line += f": {prop_desc}"
            lines.append(line)

            # Handle nested objects/arrays (limit depth)
            if prop_type == "object" and "properties" in prop_schema:
                nested_lines = _schema_to_docstring_lines(prop_schema, indent + 2)
                # Limit nested output
                if len(nested_lines) > 5:
                    lines.extend(nested_lines[:5])
                    lines.append(f"{prefix}    ...")
                else:
                    lines.extend(nested_lines)
            elif prop_type == "array" and "items" in prop_schema:
                items_schema = prop_schema["items"]
                if items_schema.get("type") == "object":
                    lines.append(f"{prefix}  items:")
                    nested_lines = _schema_to_docstring_lines(items_schema, indent + 4)
                    if len(nested_lines) > 5:
                        lines.extend(nested_lines[:5])
                        lines.append(f"{prefix}      ...")
                    else:
                        lines.extend(nested_lines)

    return lines
