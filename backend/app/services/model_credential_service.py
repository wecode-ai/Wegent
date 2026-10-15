# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deployment-extensible, request-user-scoped Model API key resolution."""

import asyncio
from typing import Any, Awaitable, Callable, Mapping

from app.models.user import User
from shared.telemetry.decorators import trace_async

ModelApiKeyResolver = Callable[[str, User], Awaitable[str | None]]
MODEL_API_KEY_RESOLUTION_TIMEOUT = 30.0
_model_api_key_resolver: ModelApiKeyResolver | None = None


class ModelCredentialError(Exception):
    """Expose no resolver exception details or credential values."""

    def __init__(self) -> None:
        super().__init__("Model credentials unavailable")


def register_model_api_key_resolver(resolver: ModelApiKeyResolver | None) -> None:
    """Set the deployment resolver at startup; None restores core behavior."""
    global _model_api_key_resolver
    _model_api_key_resolver = resolver


def with_model_api_key_template(
    model_config: dict[str, Any], model_spec: Mapping[str, Any]
) -> dict[str, Any]:
    """Preserve the original placeholder before environment/source substitution."""
    result = dict(model_config)
    config = model_spec.get("modelConfig")
    env = config.get("env") if isinstance(config, Mapping) else None
    template = env.get("api_key") if isinstance(env, Mapping) else None
    result.pop("_api_key_template", None)
    if isinstance(template, str) and "${" in template:
        result["_api_key_template"] = template
    return result


def validate_model_api_key(value: Any, *, required: bool) -> str:
    """Validate a supplied key without resolving deployment credentials."""
    if not isinstance(value, str):
        raise ModelCredentialError()
    key = value.strip()
    if "${" in key or "\r" in value or "\n" in value or (required and not key):
        raise ModelCredentialError()
    return key


@trace_async("resolve_model_provider_api_key", "backend.model_credentials")
async def resolve_model_provider_api_key(
    model_config: Mapping[str, Any],
    current_user: User,
    *,
    require_api_key: bool = False,
) -> str:
    """Resolve for the caller, never the owner of a shared Model.

    None means the extension does not handle this template. A claimed template
    must return a usable key; errors, empty results and timeouts never fall back
    to the core/environment value. No resolved keys are cached or persisted.
    """
    key = model_config.get("api_key") or ""
    template = model_config.get("_api_key_template", key)
    if not isinstance(template, str):
        raise ModelCredentialError()
    resolver = _model_api_key_resolver
    if resolver is not None:
        try:
            resolved = await asyncio.wait_for(
                resolver(template, current_user),
                timeout=MODEL_API_KEY_RESOLUTION_TIMEOUT,
            )
        except Exception:
            raise ModelCredentialError() from None
        if resolved is not None:
            return validate_model_api_key(resolved, required=True)
    return validate_model_api_key(key, required=require_api_key)
