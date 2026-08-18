# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed runtime task RPC over the existing local executor Socket.IO channel."""

import base64
import gzip
import json
import logging
import time
from typing import Any, Optional

from socketio.exceptions import BadNamespaceError, DisconnectedError
from socketio.exceptions import TimeoutError as SocketTimeoutError

from app.core.socketio import get_sio
from app.services.device.runtime_route import (
    RuntimeRouteError,
    runtime_route_resolver,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS = 30
MAX_RUNTIME_RPC_TIMEOUT_SECONDS = 600
SOCKET_ACK_GRACE_SECONDS = 5
RUNTIME_RPC_COMPRESSED_ENCODING = "gzip+base64+json"
RUNTIME_RPC_ENCODING_KEY = "__runtimeRpcEncoding"
LOCAL_EXECUTOR_NAMESPACE = "/local-executor"
DEVICE_ID_RESPONSE_KEYS = frozenset({"deviceId", "device_id"})
RETRYABLE_RUNTIME_RPC_CODES = frozenset(
    {
        "device_disconnected",
        "runtime_rpc_timeout",
    }
)


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

        normalized_timeout = self._normalize_timeout(timeout_seconds)
        try:
            route = await runtime_route_resolver.resolve(
                user_id=user_id,
                submitted_device_id=device_id,
            )
        except RuntimeRouteError as exc:
            raise RuntimeRpcError(
                str(exc),
                code=exc.code,
                retryable=exc.retryable,
                details=exc.details,
            ) from exc

        sio = get_sio()
        request = {"method": method, "payload": payload}
        started_at = time.perf_counter()
        logger.info(
            "[RuntimeRpcService] Sending runtime RPC: user_id=%s "
            "logical_device_id=%s runtime_device_id=%s method=%s "
            "timeout_seconds=%s payload_keys=%s",
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
                "[RuntimeRpcService] Runtime RPC failed: user_id=%s "
                "logical_device_id=%s runtime_device_id=%s method=%s "
                "elapsed_ms=%s error_type=%s",
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
        except RuntimeRpcError:
            raise
        if not isinstance(result, dict):
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
        )
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            "[RuntimeRpcService] Runtime RPC completed: user_id=%s "
            "logical_device_id=%s runtime_device_id=%s method=%s "
            "elapsed_ms=%s result_keys=%s",
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
    ) -> dict[str, Any]:
        """Keep external Runtime responses on the stable logical device identity."""

        projected = dict(result)
        for key in DEVICE_ID_RESPONSE_KEYS:
            if projected.get(key) == runtime_device_id:
                projected[key] = logical_device_id

        if not method.startswith("runtime.worktrees."):
            return projected

        return cls._project_nested_device_ids(
            projected,
            logical_device_id=logical_device_id,
            runtime_device_id=runtime_device_id,
        )

    @classmethod
    def _project_nested_device_ids(
        cls,
        value: Any,
        *,
        logical_device_id: str,
        runtime_device_id: str,
    ) -> Any:
        if isinstance(value, list):
            return [
                cls._project_nested_device_ids(
                    item,
                    logical_device_id=logical_device_id,
                    runtime_device_id=runtime_device_id,
                )
                for item in value
            ]
        if not isinstance(value, dict):
            return value

        projected: dict[str, Any] = {}
        for key, item in value.items():
            if key in DEVICE_ID_RESPONSE_KEYS and item == runtime_device_id:
                projected[key] = logical_device_id
                continue
            projected[key] = cls._project_nested_device_ids(
                item,
                logical_device_id=logical_device_id,
                runtime_device_id=runtime_device_id,
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
