# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated LLM proxy gateway for Wework cloud models."""

import json
import logging
from typing import Any

import httpx
from fastapi import HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.chat.config.model_resolver import extract_and_process_model_config
from app.services.group_permission import get_user_groups

logger = logging.getLogger(__name__)

MODEL_TYPE_HEADER = "x-wegent-model-type"
MODEL_NAMESPACE_HEADER = "x-wegent-model-namespace"
MODEL_USER_ID_HEADER = "x-wegent-model-user-id"
UPSTREAM_HEADER_PREFIX = "x-wegent-upstream-header-"
SUPPORTED_MODEL_TYPES = {"public", "user", "group"}
PROTECTED_UPSTREAM_HEADERS = {
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    MODEL_TYPE_HEADER,
    MODEL_NAMESPACE_HEADER,
    MODEL_USER_ID_HEADER,
}
PROTECTED_UPSTREAM_HEADER_MARKERS = (
    "api-key",
    "apikey",
    "credential",
    "secret",
    "token",
)


def _is_protected_upstream_header(name: str) -> bool:
    normalized = name.strip().lower().replace("_", "-")
    parts = normalized.split("-")
    return (
        normalized in PROTECTED_UPSTREAM_HEADERS
        or "auth" in parts
        or "authentication" in parts
        or any(marker in normalized for marker in PROTECTED_UPSTREAM_HEADER_MARKERS)
    )


def _extract_custom_upstream_headers(request: Request) -> dict[str, str]:
    custom_headers: dict[str, str] = {}
    for header_name, value in request.headers.items():
        if not header_name.lower().startswith(UPSTREAM_HEADER_PREFIX):
            continue
        target_name = header_name[len(UPSTREAM_HEADER_PREFIX) :].strip()
        if not target_name or target_name.startswith("-"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid custom upstream header name",
            )
        if _is_protected_upstream_header(target_name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Custom upstream header is protected: {target_name}",
            )
        custom_headers[target_name] = value
    return custom_headers


def _merge_headers_case_insensitive(
    *header_sources: dict[str, str],
) -> dict[str, str]:
    merged: dict[str, str] = {}
    names_by_lowercase: dict[str, str] = {}
    for headers in header_sources:
        for name, value in headers.items():
            normalized = name.lower()
            previous_name = names_by_lowercase.get(normalized)
            if previous_name is not None:
                merged.pop(previous_name, None)
            merged[name] = value
            names_by_lowercase[normalized] = name
    return merged


def _required_header(request: Request, name: str) -> str:
    value = (request.headers.get(name) or "").strip()
    if not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Missing {name} header",
        )
    return value


def _resource_user_id(request: Request) -> int:
    raw_value = _required_header(request, MODEL_USER_ID_HEADER)
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {MODEL_USER_ID_HEADER} header",
        ) from exc
    if value < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {MODEL_USER_ID_HEADER} header",
        )
    return value


def _validate_model_access(
    db: Session,
    current_user: User,
    model_type: str,
    namespace: str,
    resource_user_id: int,
) -> None:
    if model_type == "user":
        allowed = namespace == "default" and resource_user_id == current_user.id
    elif model_type == "public":
        allowed = namespace == "default" and resource_user_id == 0
    elif model_type == "group":
        allowed = namespace != "default" and namespace in get_user_groups(
            db, current_user.id
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported cloud model type: {model_type}",
        )

    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cloud model access denied",
        )


def resolve_llm_proxy_model_config(
    db: Session,
    current_user: User,
    *,
    model_name: str,
    model_type: str,
    namespace: str,
    resource_user_id: int,
) -> dict[str, Any]:
    """Resolve one authorized Model CRD by its complete resource identity."""
    if model_type not in SUPPORTED_MODEL_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported cloud model type: {model_type}",
        )
    _validate_model_access(
        db,
        current_user,
        model_type,
        namespace,
        resource_user_id,
    )

    kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == resource_user_id,
            Kind.kind == "Model",
            Kind.namespace == namespace,
            Kind.name == model_name,
            Kind.is_active == True,
        )
        .first()
    )
    if not kind or not kind.json:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cloud model not found",
        )
    return extract_and_process_model_config(
        model_spec=kind.json.get("spec", {}),
        user_id=current_user.id,
        user_name=current_user.user_name or "",
    )


def _parse_request_body(body_bytes: bytes) -> tuple[dict[str, Any], str]:
    try:
        body = json.loads(body_bytes)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request body must be valid JSON",
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request body must be an object",
        )
    model_name = body.get("model")
    if not isinstance(model_name, str) or not model_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request model is required",
        )
    return body, model_name.strip()


async def proxy_llm_responses(
    request: Request,
    db: Session,
    current_user: User,
) -> StreamingResponse:
    """Resolve a cloud model for the authenticated user and stream its response."""
    body_json, model_name = _parse_request_body(await request.body())
    model_type = _required_header(request, MODEL_TYPE_HEADER)
    namespace = _required_header(request, MODEL_NAMESPACE_HEADER)
    resource_user_id = _resource_user_id(request)
    model_config = resolve_llm_proxy_model_config(
        db,
        current_user,
        model_name=model_name,
        model_type=model_type,
        namespace=namespace,
        resource_user_id=resource_user_id,
    )

    provider_base_url = str(model_config.get("base_url") or "").strip()
    provider_api_key = str(model_config.get("api_key") or "").strip()
    provider_model_id = str(model_config.get("model_id") or "").strip()
    default_headers = model_config.get("default_headers") or {}
    if not provider_base_url or not provider_model_id:
        logger.error(
            "LLM proxy model configuration incomplete for user %s model %s",
            current_user.id,
            model_name,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model configuration incomplete",
        )

    body_json["model"] = provider_model_id
    body_bytes = json.dumps(body_json).encode("utf-8")
    upstream_url = f"{provider_base_url.rstrip('/')}/responses"

    configured_headers = (
        {str(key): str(value) for key, value in default_headers.items()}
        if isinstance(default_headers, dict)
        else {}
    )
    custom_headers = _extract_custom_upstream_headers(request)
    provider_headers = _merge_headers_case_insensitive(
        configured_headers,
        custom_headers,
    )
    protocol_headers: dict[str, str] = {}
    if provider_api_key:
        protocol_headers["Authorization"] = f"Bearer {provider_api_key}"
    content_type = request.headers.get("content-type")
    if content_type:
        protocol_headers["Content-Type"] = content_type
    accept = request.headers.get("accept")
    if accept:
        protocol_headers["Accept"] = accept
    provider_headers = _merge_headers_case_insensitive(
        provider_headers,
        protocol_headers,
    )

    client = httpx.AsyncClient(timeout=httpx.Timeout(600.0))
    try:
        upstream_request = httpx.Request(
            "POST", upstream_url, headers=provider_headers, content=body_bytes
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.RequestError as exc:
        await client.aclose()
        logger.error(
            "LLM proxy upstream request failed for user %s: %s",
            current_user.id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upstream request failed: {exc}",
        ) from exc

    async def response_stream():
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            await client.aclose()

    content_type = upstream_response.headers.get("content-type", "text/event-stream")
    return StreamingResponse(
        response_stream(),
        status_code=upstream_response.status_code,
        media_type=content_type,
    )
