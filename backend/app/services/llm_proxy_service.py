# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LLM proxy gateway.

Keeps provider API keys inside the backend by issuing encrypted proxy tokens to
Wework local executors. The executor calls the backend proxy endpoint, which
decrypts the token, resolves the Wegent Model CRD, and forwards the request to
the real provider with the stored credentials.

Token encryption key lifecycle:
- If ``LLM_PROXY_TOKEN_KEY`` is set, it is used directly.
- Otherwise the key is loaded from ``SystemConfig`` (key ``llm_proxy_token_key``).
  If a legacy ``codex_proxy_token_key`` entry exists, it is migrated to the new
  key name automatically.
- If no stored key exists, a new Fernet key is generated and persisted
  automatically so deployments do not need manual key provisioning.
- For tests/development without a database, a deterministic fallback key is
  derived from existing settings.
"""

import base64
import json
import logging
import time
from typing import Any, Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.chat.config.model_resolver import (
    _extract_model_config,
    _find_model_with_namespace,
)

logger = logging.getLogger(__name__)

_TOKEN_KEY_CACHE: Optional[Fernet] = None


class LLMProxyTokenError(Exception):
    """Raised when a proxy token is invalid, expired, or malformed."""


class LLMProxyConfigurationError(Exception):
    """Raised when the referenced model has incomplete provider configuration."""


def _env_fernet_key() -> Optional[str]:
    """Return the explicitly configured Fernet key, if any."""
    key = settings.LLM_PROXY_TOKEN_KEY.strip()
    return key or None


def _dev_fallback_fernet_key() -> str:
    """Return a deterministic dev/test key derived from existing settings.

    This is only used when no env key and no database are available. It must
    not be relied upon in production.
    """
    seed = settings.INTERNAL_SERVICE_TOKEN or settings.SHARE_TOKEN_AES_KEY
    raw = seed.encode("utf-8")[:32].ljust(32, b"0")
    return base64.urlsafe_b64encode(raw).decode("utf-8")


def _load_stored_token_key(db: Session) -> Optional[str]:
    """Return a stored Fernet key, migrating a legacy key name if found."""
    from app.models.system_config import SystemConfig

    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == "llm_proxy_token_key")
        .first()
    )
    if config is not None:
        stored = (config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            return stored.strip()

    legacy_config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == "codex_proxy_token_key")
        .first()
    )
    if legacy_config is not None:
        stored = (legacy_config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            key = stored.strip()
            if config is None:
                config = SystemConfig(
                    config_key="llm_proxy_token_key",
                    config_value={"key": key},
                )
                db.add(config)
            else:
                config.config_value = {"key": key}
            db.delete(legacy_config)
            db.commit()
            logger.info("Migrated legacy Codex proxy token key to LLM proxy token key")
            return key

    return None


def _load_or_create_stored_token_key(db: Session) -> str:
    """Load the persisted Fernet key from SystemConfig, creating one if missing."""
    stored_key = _load_stored_token_key(db)
    if stored_key is not None:
        return stored_key

    from app.models.system_config import SystemConfig

    key = Fernet.generate_key().decode("utf-8")
    config = SystemConfig(
        config_key="llm_proxy_token_key",
        config_value={"key": key},
    )
    db.add(config)
    db.commit()
    logger.info("Generated and persisted new LLM proxy token key")
    return key


def _get_fernet(db: Optional[Session] = None) -> Fernet:
    """Return a Fernet instance for proxy token crypto.

    Priority:
    1. ``LLM_PROXY_TOKEN_KEY`` environment variable.
    2. Persisted ``SystemConfig`` value (auto-generated on first use).
    3. Deterministic dev/test fallback (no DB or env key).
    """
    global _TOKEN_KEY_CACHE  # noqa: PLW0603

    env_key = _env_fernet_key()
    if env_key is not None:
        if _TOKEN_KEY_CACHE is None:
            _TOKEN_KEY_CACHE = Fernet(env_key)
        return _TOKEN_KEY_CACHE

    if _TOKEN_KEY_CACHE is not None:
        return _TOKEN_KEY_CACHE

    if db is not None:
        key = _load_or_create_stored_token_key(db)
    else:
        key = _dev_fallback_fernet_key()

    _TOKEN_KEY_CACHE = Fernet(key)
    return _TOKEN_KEY_CACHE


def _encode_payload(payload: dict[str, Any], db: Optional[Session] = None) -> str:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return _get_fernet(db).encrypt(data).decode("utf-8")


def _decode_payload(token: str, db: Optional[Session] = None) -> dict[str, Any]:
    try:
        data = _get_fernet(db).decrypt(token.encode("utf-8"), ttl=None)
        payload = json.loads(data)
    except (InvalidToken, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise LLMProxyTokenError("Invalid proxy token") from exc
    if not isinstance(payload, dict):
        raise LLMProxyTokenError("Invalid proxy token payload")
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time()):
        raise LLMProxyTokenError("Proxy token expired")
    return payload


def create_llm_proxy_token(
    db: Session,
    user_id: int,
    model_namespace: str,
    model_name: str,
    expires_in_seconds: Optional[int] = None,
) -> str:
    """Create an encrypted proxy token for a Wegent Model CRD.

    The token binds the caller (user_id) to one Model CRD identified by
    namespace + name. It is time-limited and encrypted with the backend key.
    """
    if expires_in_seconds is None:
        expires_in_seconds = settings.LLM_PROXY_TOKEN_TTL_SECONDS

    # Verify the model exists before issuing a token.
    kind, model_spec = _find_model_with_namespace(db, model_name, user_id)
    if not model_spec:
        raise LLMProxyConfigurationError(f"Model '{model_name}' not found")
    resolved_namespace = kind.namespace if kind else model_namespace
    if model_namespace and resolved_namespace != model_namespace:
        raise LLMProxyConfigurationError(f"Model '{model_name}' namespace mismatch")

    now = int(time.time())
    payload = {
        "u": user_id,
        "ns": resolved_namespace,
        "n": model_name,
        "iat": now,
        "exp": now + expires_in_seconds,
    }
    return _encode_payload(payload, db)


def decode_llm_proxy_token(token: str, db: Optional[Session] = None) -> dict[str, Any]:
    """Decrypt and validate a proxy token."""
    return _decode_payload(token, db)


def resolve_llm_proxy_model_config(
    db: Session,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Resolve the Model CRD referenced by a proxy token."""
    user_id = payload.get("u")
    namespace = payload.get("ns")
    name = payload.get("n")
    if (
        not isinstance(user_id, int)
        or not isinstance(namespace, str)
        or not isinstance(name, str)
    ):
        raise LLMProxyTokenError("Malformed proxy token")

    kind, model_spec = _find_model_with_namespace(db, name, user_id)
    if not model_spec:
        raise LLMProxyConfigurationError(f"Model '{name}' not found")
    if kind and kind.namespace != namespace:
        raise LLMProxyConfigurationError(f"Model '{name}' namespace mismatch")
    return _extract_model_config(model_spec)


async def proxy_llm_responses(
    token: str,
    request: Request,
    db: Session,
) -> StreamingResponse:
    """Validate token and stream the LLM responses request to the provider."""
    payload = decode_llm_proxy_token(token, db)
    model_config = resolve_llm_proxy_model_config(db, payload)
    user_id = payload["u"]

    provider_base_url = str(model_config.get("base_url") or "").strip()
    provider_api_key = str(model_config.get("api_key") or "").strip()
    provider_model_id = str(model_config.get("model_id") or "").strip()
    default_headers = model_config.get("default_headers") or {}

    if not provider_base_url or not provider_api_key or not provider_model_id:
        logger.error("LLM proxy model configuration incomplete for user %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model configuration incomplete",
        )

    body_bytes = await request.body()
    try:
        body_json = json.loads(body_bytes)
        if isinstance(body_json, dict):
            request_model = body_json.get("model")
            if request_model is not None and str(request_model) != provider_model_id:
                logger.warning(
                    "LLM proxy request model mismatch for user %s: "
                    "requested=%s, crd=%s",
                    user_id,
                    request_model,
                    provider_model_id,
                )
            body_json["model"] = provider_model_id
            body_bytes = json.dumps(body_json).encode("utf-8")
    except json.JSONDecodeError:
        logger.warning("LLM proxy received non-JSON body from user %s", user_id)

    upstream_url = f"{provider_base_url.rstrip('/')}/responses"

    provider_headers: dict[str, str] = {}
    for key, value in default_headers.items():
        provider_headers[str(key)] = str(value)
    provider_headers["Authorization"] = f"Bearer {provider_api_key}"
    content_type = request.headers.get("content-type")
    if content_type:
        provider_headers["Content-Type"] = content_type
    accept = request.headers.get("accept")
    if accept:
        provider_headers["Accept"] = accept

    client = httpx.AsyncClient(timeout=httpx.Timeout(600.0))
    try:
        upstream_request = httpx.Request(
            "POST", upstream_url, headers=provider_headers, content=body_bytes
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.RequestError as exc:
        await client.aclose()
        logger.error("LLM proxy upstream request failed for user %s: %s", user_id, exc)
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
