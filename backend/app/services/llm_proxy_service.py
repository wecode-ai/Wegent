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

Request signing lifecycle:
- If ``LLM_PROXY_SIGNING_KEY`` is set, it is used as the master HMAC key.
- Otherwise the key is loaded from ``SystemConfig`` (key
  ``llm_proxy_signing_key``). A legacy ``codex_proxy_signing_key`` entry is
  migrated automatically.
- If no stored key exists, a new random key is generated and persisted.
- For tests/development without a database, a deterministic fallback key is
  derived from existing settings.

Each proxy token carries a unique ``jti`` claim. The per-token signing key is
derived as ``HMAC-SHA256(master_signing_key, jti)`` and returned to the executor
alongside the encrypted token. The executor must include the token in the
``Authorization`` header and sign every request with a fresh nonce.
"""

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
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
_SIGNING_KEY_CACHE: Optional[str] = None
_NONCE_MEMORY_CACHE: dict[str, int] = {}
_REDIS_CLIENT_CACHE: Optional[Any] = None

LLM_PROXY_NONCE_REDIS_KEY_PREFIX = "llm_proxy_nonce"
LLM_PROXY_SIGNING_KEY_CONFIG_KEY = "llm_proxy_signing_key"
LLM_PROXY_SIGNING_KEY_LEGACY_CONFIG_KEY = "codex_proxy_signing_key"
LLM_PROXY_TOKEN_KEY_CONFIG_KEY = "llm_proxy_token_key"
LLM_PROXY_TOKEN_KEY_LEGACY_CONFIG_KEY = "codex_proxy_token_key"

NONCE_HEADER_NAME = "X-Wegent-Request-Nonce"
SIGNATURE_HEADER_NAME = "X-Wegent-Body-Signature"


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
        .filter(SystemConfig.config_key == LLM_PROXY_TOKEN_KEY_CONFIG_KEY)
        .first()
    )
    if config is not None:
        stored = (config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            return stored.strip()

    legacy_config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == LLM_PROXY_TOKEN_KEY_LEGACY_CONFIG_KEY)
        .first()
    )
    if legacy_config is not None:
        stored = (legacy_config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            key = stored.strip()
            if config is None:
                config = SystemConfig(
                    config_key=LLM_PROXY_TOKEN_KEY_CONFIG_KEY,
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
        config_key=LLM_PROXY_TOKEN_KEY_CONFIG_KEY,
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


def _env_signing_key() -> Optional[str]:
    """Return the explicitly configured master signing key, if any."""
    key = settings.LLM_PROXY_SIGNING_KEY.strip()
    return key or None


def _dev_fallback_signing_key() -> str:
    """Return a deterministic dev/test signing key derived from existing settings.

    This is only used when no env key and no database are available. It must
    not be relied upon in production.
    """
    seed = settings.SHARE_TOKEN_AES_KEY or settings.INTERNAL_SERVICE_TOKEN
    raw = seed.encode("utf-8")[:32].ljust(32, b"0")
    return base64.urlsafe_b64encode(raw).decode("utf-8")


def _load_stored_signing_key(db: Session) -> Optional[str]:
    """Return a stored master signing key, migrating a legacy key name if found."""
    from app.models.system_config import SystemConfig

    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == LLM_PROXY_SIGNING_KEY_CONFIG_KEY)
        .first()
    )
    if config is not None:
        stored = (config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            return stored.strip()

    legacy_config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == LLM_PROXY_SIGNING_KEY_LEGACY_CONFIG_KEY)
        .first()
    )
    if legacy_config is not None:
        stored = (legacy_config.config_value or {}).get("key")
        if isinstance(stored, str) and stored.strip():
            key = stored.strip()
            if config is None:
                config = SystemConfig(
                    config_key=LLM_PROXY_SIGNING_KEY_CONFIG_KEY,
                    config_value={"key": key},
                )
                db.add(config)
            else:
                config.config_value = {"key": key}
            db.delete(legacy_config)
            db.commit()
            logger.info(
                "Migrated legacy Codex proxy signing key to LLM proxy signing key"
            )
            return key

    return None


def _load_or_create_stored_signing_key(db: Session) -> str:
    """Load the persisted master signing key from SystemConfig, creating one if missing."""
    stored_key = _load_stored_signing_key(db)
    if stored_key is not None:
        return stored_key

    from app.models.system_config import SystemConfig

    key = base64.urlsafe_b64encode(hashlib.sha256(uuid.uuid4().bytes).digest()).decode(
        "utf-8"
    )
    config = SystemConfig(
        config_key=LLM_PROXY_SIGNING_KEY_CONFIG_KEY,
        config_value={"key": key},
    )
    db.add(config)
    db.commit()
    logger.info("Generated and persisted new LLM proxy signing key")
    return key


def _get_master_signing_key(db: Optional[Session] = None) -> str:
    """Return the master HMAC signing key.

    Priority:
    1. ``LLM_PROXY_SIGNING_KEY`` environment variable.
    2. Persisted ``SystemConfig`` value (auto-generated on first use).
    3. Deterministic dev/test fallback (no DB or env key).
    """
    global _SIGNING_KEY_CACHE  # noqa: PLW0603

    env_key = _env_signing_key()
    if env_key is not None:
        return env_key

    if _SIGNING_KEY_CACHE is not None:
        return _SIGNING_KEY_CACHE

    if db is not None:
        key = _load_or_create_stored_signing_key(db)
    else:
        key = _dev_fallback_signing_key()

    _SIGNING_KEY_CACHE = key
    return key


def derive_per_token_signing_key(jti: str, db: Optional[Session] = None) -> str:
    """Derive a per-token HMAC signing key from the master key and token ``jti``."""
    master_key = _get_master_signing_key(db)
    digest = hmac.new(
        master_key.encode("utf-8"),
        jti.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest


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


def _signature_for_request(
    signing_key: str,
    nonce: str,
    body: bytes,
) -> str:
    """Return the hex HMAC-SHA256 signature for ``nonce + body``."""
    return hmac.new(
        signing_key.encode("utf-8"),
        nonce.encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()


def _verify_request_signature(
    payload: dict[str, Any],
    nonce: str,
    body: bytes,
    signature: str,
    db: Optional[Session] = None,
) -> None:
    """Verify the HMAC signature for a request."""
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        raise LLMProxyTokenError("Malformed proxy token: missing jti")

    expected = _signature_for_request(
        derive_per_token_signing_key(jti, db), nonce, body
    )
    if not hmac.compare_digest(expected, signature):
        raise LLMProxyTokenError("Invalid request signature")


def _redis_client() -> Optional[Any]:
    """Return a cached Redis client, creating one on first use if possible.

    The client is reused across calls to avoid creating a new TCP connection
    for every nonce check. If Redis becomes unavailable, the cached client is
    discarded and the function returns None so the caller can fall back to the
    in-memory nonce cache.
    """
    global _REDIS_CLIENT_CACHE  # noqa: PLW0603

    if _REDIS_CLIENT_CACHE is not None:
        try:
            _REDIS_CLIENT_CACHE.ping()
            return _REDIS_CLIENT_CACHE
        except Exception as exc:
            logger.warning(
                "LLM proxy cached Redis client failed ping, recreating: %s", exc
            )
            _REDIS_CLIENT_CACHE = None

    try:
        import redis

        client = redis.from_url(settings.REDIS_URL)
        client.ping()
        _REDIS_CLIENT_CACHE = client
        return client
    except Exception as exc:
        logger.warning("LLM proxy Redis nonce store unavailable: %s", exc)
        return None


def _nonce_cache_key(jti: str, nonce: str) -> str:
    return f"{LLM_PROXY_NONCE_REDIS_KEY_PREFIX}:{jti}:{nonce}"


def _record_nonce(
    payload: dict[str, Any],
    nonce: str,
    db: Optional[Session] = None,
) -> None:
    """Store a nonce atomically to prevent replay.

    The nonce is associated with the token ``jti`` and expires together with
    the token. Redis is used when available; otherwise a process-local in-memory
    cache is used as a fallback for tests and single-process deployments.

    Raises:
        LLMProxyTokenError: If the nonce has already been recorded.
    """
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        raise LLMProxyTokenError("Malformed proxy token: missing jti")

    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise LLMProxyTokenError("Malformed proxy token: missing exp")

    ttl = max(1, exp - int(time.time()))
    key = _nonce_cache_key(jti, nonce)

    redis_client = _redis_client()
    if redis_client is not None:
        try:
            # SET NX EX is atomic: it only succeeds when the key did not exist.
            # This closes the check-then-set race window across concurrent
            # requests with the same nonce.
            set_ok = redis_client.set(key, "1", nx=True, ex=ttl)
            if set_ok:
                return
            raise LLMProxyTokenError("Request nonce reused")
        except LLMProxyTokenError:
            raise
        except Exception as exc:
            logger.warning(
                "LLM proxy failed to record nonce in Redis, falling back to memory: %s",
                exc,
            )

    # Memory fallback: the CPython GIL makes dict get/set effectively atomic,
    # which is acceptable for the single-process/test fallback path.
    if key in _NONCE_MEMORY_CACHE:
        raise LLMProxyTokenError("Request nonce reused")
    _NONCE_MEMORY_CACHE[key] = exp
    _cleanup_expired_nonces()


def _cleanup_expired_nonces() -> None:
    """Remove expired entries from the in-memory nonce cache."""
    now = int(time.time())
    expired = [key for key, exp in _NONCE_MEMORY_CACHE.items() if exp <= now]
    for key in expired:
        _NONCE_MEMORY_CACHE.pop(key, None)


def _is_nonce_reused(
    payload: dict[str, Any],
    nonce: str,
) -> bool:
    """Return True if the nonce has been seen before for this token."""
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        raise LLMProxyTokenError("Malformed proxy token: missing jti")

    key = _nonce_cache_key(jti, nonce)

    redis_client = _redis_client()
    if redis_client is not None:
        try:
            return bool(redis_client.exists(key))
        except Exception as exc:
            logger.warning(
                "LLM proxy failed to check nonce in Redis, falling back to memory: %s",
                exc,
            )

    return key in _NONCE_MEMORY_CACHE


def _extract_bearer_token(request: Request) -> str:
    """Extract the Fernet token from the ``Authorization: Bearer`` header."""
    auth = request.headers.get("authorization") or ""
    parts = auth.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    raise LLMProxyTokenError("Missing or invalid Authorization header")


def _extract_signature_headers(request: Request) -> tuple[str, str]:
    """Return the nonce and body signature headers."""
    nonce = request.headers.get(NONCE_HEADER_NAME) or ""
    signature = request.headers.get(SIGNATURE_HEADER_NAME) or ""
    if not nonce or not signature:
        raise LLMProxyTokenError("Missing request signature headers")
    return nonce, signature


def create_llm_proxy_token(
    db: Session,
    user_id: int,
    model_namespace: str,
    model_name: str,
    expires_in_seconds: Optional[int] = None,
) -> tuple[str, str]:
    """Create an encrypted proxy token and per-token signing key for a Model CRD.

    The token binds the caller (user_id) to one Model CRD identified by
    namespace + name. It is time-limited and encrypted with the backend key.
    The returned signing key is derived from the token ``jti`` and must be used
    by the executor to sign every proxied request.
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
    jti = str(uuid.uuid4())
    payload = {
        "u": user_id,
        "ns": resolved_namespace,
        "n": model_name,
        "iat": now,
        "exp": now + expires_in_seconds,
        "jti": jti,
    }
    token = _encode_payload(payload, db)
    signing_key = derive_per_token_signing_key(jti, db)
    return token, signing_key


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
    request: Request,
    db: Session,
) -> StreamingResponse:
    """Validate token and signature and stream the LLM responses request to the provider."""
    token = _extract_bearer_token(request)
    nonce, signature = _extract_signature_headers(request)
    payload = decode_llm_proxy_token(token, db)

    if _is_nonce_reused(payload, nonce):
        raise LLMProxyTokenError("Request nonce reused")

    body_bytes = await request.body()
    _verify_request_signature(payload, nonce, body_bytes, signature, db)
    _record_nonce(payload, nonce, db)

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
