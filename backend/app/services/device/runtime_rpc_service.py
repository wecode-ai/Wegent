# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed runtime task RPC over the existing local executor Socket.IO channel."""

import asyncio
import base64
import copy
import gzip
import json
import logging
import time
from typing import Any, Optional

from socketio.exceptions import BadNamespaceError, DisconnectedError
from socketio.exceptions import TimeoutError as SocketTimeoutError

from app.core.socketio import get_sio
from app.db.session import get_db_session
from app.schemas.device import DeviceType
from app.services.device.remote_control_policy import (
    REMOTE_CONTROL_DISABLED_MESSAGE,
    remote_control_is_enabled,
)
from app.services.device.runtime_route import (
    RuntimeRouteError,
    runtime_route_resolver,
)
from app.services.device.runtime_task_create_protocol import (
    RuntimeTaskCreateProtocolError,
    negotiate_runtime_task_create_payload,
)
from app.services.user_runtime_config import user_runtime_config_service
from shared.telemetry.context import get_request_id
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS = 30
MAX_RUNTIME_RPC_TIMEOUT_SECONDS = 600
SOCKET_ACK_GRACE_SECONDS = 5
RUNTIME_RPC_COMPRESSED_ENCODING = "gzip+base64+json"
RUNTIME_RPC_ENCODING_KEY = "__runtimeRpcEncoding"
RUNTIME_RPC_COMPRESSION_THRESHOLD_BYTES = 512 * 1024
RUNTIME_RPC_MAX_ENCODED_BYTES = 980_000
LOCAL_EXECUTOR_NAMESPACE = "/local-executor"
DEVICE_ID_RESPONSE_KEYS = frozenset({"deviceId", "device_id"})
RETRYABLE_RUNTIME_RPC_CODES = frozenset(
    {
        "device_disconnected",
        "runtime_rpc_timeout",
    }
)
REMOTE_RUNTIME_DEVICE_TYPES = frozenset({DeviceType.CLOUD, DeviceType.REMOTE})
RUNTIME_MODEL_CONFIG_METHODS = frozenset(
    {
        "runtime.text.generate",
        "runtime.tasks.create",
        "runtime.tasks.send",
        "runtime.tasks.rollback",
        "runtime.tasks.interrupt_and_send",
        "runtime.tasks.supervisor.set",
        "runtime.automations.create",
        "runtime.automations.update",
    }
)
RUNTIME_MODEL_CONFIG_KEYS = frozenset({"model_config", "modelConfig"})


def _load_remote_runtime_proxy_url(user_id: int) -> str:
    with get_db_session() as db:
        return user_runtime_config_service.get_proxy_url_for_execution(
            db,
            user_id=user_id,
        )


def _runtime_model_configs(value: Any) -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = []
    if isinstance(value, list):
        for item in value:
            configs.extend(_runtime_model_configs(item))
        return configs
    if not isinstance(value, dict):
        return configs

    for key, item in value.items():
        if key in RUNTIME_MODEL_CONFIG_KEYS and isinstance(item, dict):
            configs.append(item)
            continue
        configs.extend(_runtime_model_configs(item))
    return configs


def _set_runtime_proxy(model_config: dict[str, Any], proxy_url: str) -> None:
    model_config.pop("proxy_url", None)
    model_config.pop("proxyUrl", None)
    if proxy_url:
        model_config["proxy"] = {"url": proxy_url}
    else:
        model_config.pop("proxy", None)

    runtime_config = model_config.pop("runtimeConfig", None)
    if not isinstance(runtime_config, dict):
        runtime_config = model_config.get("runtime_config")
    runtime_config = dict(runtime_config) if isinstance(runtime_config, dict) else {}
    codex_config = runtime_config.get("codex")
    codex_config = dict(codex_config) if isinstance(codex_config, dict) else {}
    codex_config["use_proxy"] = bool(proxy_url)
    codex_config["proxy_configured"] = bool(proxy_url)
    runtime_config["codex"] = codex_config
    model_config["runtime_config"] = runtime_config


def _uses_backend_cloud_model_gateway(model_config: dict[str, Any]) -> bool:
    return model_config.get("wework_model_kind") == "cloud"


async def _enforce_remote_runtime_proxy(
    *,
    user_id: int,
    device_type: DeviceType,
    method: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if (
        device_type not in REMOTE_RUNTIME_DEVICE_TYPES
        or method not in RUNTIME_MODEL_CONFIG_METHODS
    ):
        return payload

    next_payload = copy.deepcopy(payload)
    model_configs = _runtime_model_configs(next_payload)
    if not model_configs:
        return payload

    proxy_url = await asyncio.to_thread(_load_remote_runtime_proxy_url, user_id)
    cloud_model_config_count = 0
    for model_config in model_configs:
        if _uses_backend_cloud_model_gateway(model_config):
            cloud_model_config_count += 1
            _set_runtime_proxy(model_config, "")
        else:
            _set_runtime_proxy(model_config, proxy_url)
    logger.info(
        "[RuntimeRpcService] Applied account proxy policy: "
        "user_id=%s method=%s configured=%s model_config_count=%s "
        "cloud_model_config_count=%s",
        user_id,
        method,
        bool(proxy_url),
        len(model_configs),
        cloud_model_config_count,
    )
    return next_payload


class RuntimeRpcError(RuntimeError):
    """Raised when a runtime task RPC cannot be dispatched or completed."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "runtime_rpc_failed",
        retryable: bool = False,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details or {}


class RuntimeRpcService:
    """Dispatch typed runtime RPC requests to one online local executor."""

    @trace_async(
        span_name="device.runtime_rpc.call",
        tracer_name="backend.device",
        extract_attributes=lambda self, **kwargs: {
            "device.user_id": str(kwargs.get("user_id", "")),
            "device.submitted_id": str(kwargs.get("device_id", "")),
            "rpc.method": str(kwargs.get("method", "")),
        },
    )
    async def call(
        self,
        *,
        user_id: int,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        timeout_seconds: int = DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        """Call `runtime:rpc` on an online local executor and return its result."""

        request_id = get_request_id()
        started_at = time.perf_counter()
        normalized_timeout = self._normalize_timeout(timeout_seconds)
        logger.info(
            "[RuntimeRpcService] Runtime RPC started: request_id=%s "
            "user_id=%s submitted_device_id=%s method=%s",
            request_id or "-",
            user_id,
            device_id,
            method,
        )
        try:
            route = await runtime_route_resolver.resolve(
                user_id=user_id,
                submitted_device_id=device_id,
            )
        except RuntimeRouteError as exc:
            logger.warning(
                "[RuntimeRpcService] Runtime RPC route failed: request_id=%s "
                "user_id=%s submitted_device_id=%s method=%s code=%s",
                request_id or "-",
                user_id,
                device_id,
                method,
                exc.code,
            )
            raise RuntimeRpcError(
                str(exc),
                code=exc.code,
                retryable=exc.retryable,
                details=exc.details,
            ) from exc

        if not remote_control_is_enabled(route.device_type):
            raise RuntimeRpcError(
                REMOTE_CONTROL_DISABLED_MESSAGE,
                code="remote_control_disabled",
                retryable=False,
                details={"deviceId": route.logical_device_id},
            )

        if method == "runtime.tasks.create":
            try:
                payload = negotiate_runtime_task_create_payload(
                    payload,
                    route.online_info.get("runtime_features"),
                )
            except RuntimeTaskCreateProtocolError as exc:
                logger.warning(
                    "[RuntimeRpcService] Runtime RPC negotiation failed: "
                    "request_id=%s user_id=%s logical_device_id=%s "
                    "method=%s features=%s",
                    request_id or "-",
                    user_id,
                    route.logical_device_id,
                    method,
                    sorted(exc.features),
                )
                raise RuntimeRpcError(
                    str(exc),
                    code="unsupported_runtime_task_create_features",
                    retryable=False,
                    details={
                        "deviceId": route.logical_device_id,
                        "features": list(exc.features),
                    },
                ) from exc

        try:
            payload = await _enforce_remote_runtime_proxy(
                user_id=user_id,
                device_type=route.device_type,
                method=method,
                payload=payload,
            )
        except Exception as exc:
            logger.exception(
                "[RuntimeRpcService] Failed to resolve account proxy policy: "
                "request_id=%s user_id=%s logical_device_id=%s method=%s",
                request_id or "-",
                user_id,
                route.logical_device_id,
                method,
            )
            raise RuntimeRpcError(
                "Failed to resolve cloud device proxy configuration",
                code="runtime_proxy_config_failed",
                retryable=False,
                details={"deviceId": route.logical_device_id},
            ) from exc

        sio = get_sio()
        request = {
            "method": method,
            "payload": payload,
        }
        if request_id:
            request["request_id"] = request_id
        logger.info(
            "[RuntimeRpcService] Sending runtime RPC: request_id=%s user_id=%s "
            "logical_device_id=%s runtime_device_id=%s method=%s "
            "timeout_seconds=%s payload_keys=%s",
            request_id or "-",
            user_id,
            route.logical_device_id,
            route.runtime_device_id,
            method,
            normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            sorted(payload.keys()),
        )
        try:
            result = await sio.call(
                "runtime:rpc",
                request,
                to=route.socket_id,
                namespace=LOCAL_EXECUTOR_NAMESPACE,
                timeout=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            )
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.warning(
                "[RuntimeRpcService] Runtime RPC failed: request_id=%s user_id=%s "
                "logical_device_id=%s runtime_device_id=%s method=%s "
                "elapsed_ms=%s error_type=%s",
                request_id or "-",
                user_id,
                route.logical_device_id,
                route.runtime_device_id,
                method,
                elapsed_ms,
                exc.__class__.__name__,
            )
            code, message = self._classify_rpc_error(
                exc,
                device_id=route.logical_device_id,
                method=method,
                timeout_seconds=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            )
            raise RuntimeRpcError(
                message,
                code=code,
                retryable=code in RETRYABLE_RUNTIME_RPC_CODES,
                details={"deviceId": route.logical_device_id},
            ) from exc

        try:
            result = self._decode_response(result, method=method)
        except RuntimeRpcError as exc:
            logger.warning(
                "[RuntimeRpcService] Runtime RPC response decoding failed: "
                "request_id=%s user_id=%s logical_device_id=%s method=%s code=%s",
                request_id or "-",
                user_id,
                route.logical_device_id,
                method,
                exc.code,
            )
            raise
        if not isinstance(result, dict):
            logger.warning(
                "[RuntimeRpcService] Runtime RPC returned invalid response: "
                "request_id=%s user_id=%s logical_device_id=%s method=%s "
                "response_type=%s",
                request_id or "-",
                user_id,
                route.logical_device_id,
                method,
                type(result).__name__,
            )
            raise RuntimeRpcError(
                "Runtime RPC returned an invalid response",
                code="runtime_rpc_invalid_response",
                details={"deviceId": route.logical_device_id},
            )
        result = self._project_response_device_ids(
            result,
            method=method,
            logical_device_id=route.logical_device_id,
            runtime_device_id=route.runtime_device_id,
            app_device_id=route.app_device_id,
        )
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            "[RuntimeRpcService] Runtime RPC completed: request_id=%s user_id=%s "
            "logical_device_id=%s runtime_device_id=%s method=%s "
            "elapsed_ms=%s result_keys=%s",
            request_id or "-",
            user_id,
            route.logical_device_id,
            route.runtime_device_id,
            method,
            elapsed_ms,
            sorted(result.keys()),
        )
        return result

    @classmethod
    def _project_response_device_ids(
        cls,
        result: dict[str, Any],
        *,
        method: str,
        logical_device_id: str,
        runtime_device_id: str,
        app_device_id: str | None,
    ) -> dict[str, Any]:
        """Keep external Runtime responses on the stable logical device identity."""

        device_aliases = frozenset(
            device_id for device_id in (runtime_device_id, app_device_id) if device_id
        )
        projected = dict(result)
        for key in DEVICE_ID_RESPONSE_KEYS:
            if projected.get(key) in device_aliases:
                projected[key] = logical_device_id

        if not method.startswith("runtime.worktrees."):
            return projected

        return cls._project_nested_device_ids(
            projected,
            logical_device_id=logical_device_id,
            device_aliases=device_aliases,
        )

    @classmethod
    def _project_nested_device_ids(
        cls,
        value: Any,
        *,
        logical_device_id: str,
        device_aliases: frozenset[str],
    ) -> Any:
        if isinstance(value, list):
            return [
                cls._project_nested_device_ids(
                    item,
                    logical_device_id=logical_device_id,
                    device_aliases=device_aliases,
                )
                for item in value
            ]
        if not isinstance(value, dict):
            return value

        projected: dict[str, Any] = {}
        for key, item in value.items():
            if key in DEVICE_ID_RESPONSE_KEYS and item in device_aliases:
                projected[key] = logical_device_id
                continue
            projected[key] = cls._project_nested_device_ids(
                item,
                logical_device_id=logical_device_id,
                device_aliases=device_aliases,
            )
        return projected

    @staticmethod
    def _decode_response(result: Any, *, method: str) -> Any:
        if not (
            isinstance(result, dict)
            and result.get(RUNTIME_RPC_ENCODING_KEY) == RUNTIME_RPC_COMPRESSED_ENCODING
        ):
            return result

        payload = result.get("payload")
        if not isinstance(payload, str):
            raise RuntimeRpcError(
                "Runtime RPC returned an invalid compressed payload",
                code="runtime_rpc_invalid_response",
            )

        try:
            compressed = base64.b64decode(payload.encode("ascii"), validate=True)
            decoded = gzip.decompress(compressed)
            response = json.loads(decoded.decode("utf-8"))
        except Exception as exc:
            raise RuntimeRpcError(
                "Runtime RPC returned an unreadable payload",
                code="runtime_rpc_invalid_response",
            ) from exc

        logger.info(
            "[RuntimeRpcService] Runtime RPC response decompressed: method=%s raw_bytes=%s compressed_bytes=%s encoded_bytes=%s",
            method,
            len(decoded),
            len(compressed),
            len(payload),
        )
        return response

    @staticmethod
    def _normalize_timeout(timeout_seconds: Any) -> int:
        try:
            parsed = int(timeout_seconds)
        except (TypeError, ValueError):
            parsed = DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS
        if parsed <= 0:
            return DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS
        return min(parsed, MAX_RUNTIME_RPC_TIMEOUT_SECONDS)

    @staticmethod
    def _classify_rpc_error(
        exc: Exception,
        *,
        device_id: str,
        method: str,
        timeout_seconds: int,
    ) -> tuple[str, str]:
        if isinstance(exc, SocketTimeoutError):
            return (
                "runtime_rpc_timeout",
                f"Runtime RPC '{method}' timed out after {timeout_seconds} seconds "
                f"waiting for device '{device_id}'.",
            )
        if isinstance(exc, DisconnectedError):
            return (
                "device_disconnected",
                f"Runtime RPC '{method}' failed because device '{device_id}' "
                "disconnected before acknowledging the request.",
            )
        if isinstance(exc, BadNamespaceError):
            return (
                "runtime_route_missing",
                f"Runtime RPC '{method}' failed because the local executor is not "
                f"connected to /local-executor for device '{device_id}'.",
            )
        detail = str(exc).strip() or exc.__class__.__name__
        return "runtime_rpc_failed", f"Runtime RPC '{method}' failed: {detail}"


runtime_rpc_service = RuntimeRpcService()


def encode_runtime_rpc_response(
    response: dict[str, Any],
    *,
    method: str,
) -> dict[str, Any]:
    """Compress a large browser-facing Runtime RPC result for Socket.IO."""

    raw = json.dumps(
        response,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(raw) <= RUNTIME_RPC_COMPRESSION_THRESHOLD_BYTES:
        return response

    compressed = gzip.compress(raw)
    encoded = base64.b64encode(compressed).decode("ascii")
    envelope: dict[str, Any] = {
        RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING,
        "payload": encoded,
        "rawBytes": len(raw),
        "compressedBytes": len(compressed),
    }
    envelope_bytes = len(json.dumps(envelope, separators=(",", ":")).encode("utf-8"))
    if envelope_bytes > RUNTIME_RPC_MAX_ENCODED_BYTES:
        raise RuntimeRpcError(
            "Runtime RPC response exceeded the Socket.IO payload limit",
            code="runtime_rpc_response_too_large",
        )

    logger.info(
        "[RuntimeRpcService] Runtime RPC response compressed for Wework: "
        "method=%s raw_bytes=%s compressed_bytes=%s encoded_bytes=%s",
        method,
        len(raw),
        len(compressed),
        envelope_bytes,
    )
    return envelope
