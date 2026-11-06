# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Observe retained services in workflows whose read APIs are now Rust-owned.

These are service assertions, not HTTP coverage. Never mount a retired handler
to exercise them. Unmigrated writes still use the production FastAPI client;
Rust handler/authentication contracts live in backend-rs.
"""

from collections.abc import Callable
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import TypeAdapter


def service_result(
    operation: Callable[..., Any],
    *args: Any,
    response_model: Any = None,
    **kwargs: Any,
) -> httpx.Response:
    """Keep success/error and serialization assertions on the actual service."""
    try:
        value = operation(*args, **kwargs)
        if response_model is not None:
            value = TypeAdapter(response_model).validate_python(value)
        return httpx.Response(200, json=jsonable_encoder(value))
    except HTTPException as error:
        return httpx.Response(error.status_code, json={"detail": error.detail})
