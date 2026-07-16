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
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS = 30
MAX_RUNTIME_RPC_TIMEOUT_SECONDS = 600
SOCKET_ACK_GRACE_SECONDS = 5
RUNTIME_RPC_COMPRESSED_ENCODING = "gzip+base64+json"
RUNTIME_RPC_ENCODING_KEY = "__runtimeRpcEncoding"
LOCAL_EXECUTOR_NAMESPACE = "/local-executor"


class RuntimeRpcError(RuntimeError):
    """Raised when a runtime task RPC cannot be dispatched or completed."""


class RuntimeRpcService:
    """Dispatch typed runtime RPC requests to one online local executor."""

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
        online_info = await device_service.get_device_online_info(user_id, device_id)
        if not online_info:
            raise RuntimeRpcError(f"Device '{device_id}' is offline")

        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise RuntimeRpcError(f"Device '{device_id}' has no socket information")

        sio = get_sio()
        if not sio.manager.is_connected(socket_id, LOCAL_EXECUTOR_NAMESPACE):
            logger.warning(
                "[RuntimeRpcService] Runtime RPC skipped stale socket: user_id=%s device_id=%s method=%s socket_id=%s",
                user_id,
                device_id,
                method,
                socket_id,
            )
            await device_service.set_device_offline(user_id, device_id)
            raise RuntimeRpcError(f"Device '{device_id}' is disconnected")

        request = {"method": method, "payload": payload}
        started_at = time.perf_counter()
        logger.info(
            "[RuntimeRpcService] Sending runtime RPC: user_id=%s device_id=%s method=%s timeout_seconds=%s payload_keys=%s",
            user_id,
            device_id,
            method,
            normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            sorted(payload.keys()),
        )
        try:
            result = await sio.call(
                "runtime:rpc",
                request,
                to=socket_id,
                namespace=LOCAL_EXECUTOR_NAMESPACE,
                timeout=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            )
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.warning(
                "[RuntimeRpcService] Runtime RPC failed: user_id=%s device_id=%s method=%s elapsed_ms=%s error_type=%s",
                user_id,
                device_id,
                method,
                elapsed_ms,
                exc.__class__.__name__,
            )
            raise RuntimeRpcError(
                self._format_rpc_error(
                    exc,
                    device_id=device_id,
                    method=method,
                    timeout_seconds=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
                )
            ) from exc

        result = self._decode_response(result, method=method)
        if not isinstance(result, dict):
            raise RuntimeRpcError("Runtime RPC returned an invalid response")
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            "[RuntimeRpcService] Runtime RPC completed: user_id=%s device_id=%s method=%s elapsed_ms=%s result_keys=%s",
            user_id,
            device_id,
            method,
            elapsed_ms,
            sorted(result.keys()),
        )
        return result

    @staticmethod
    def _decode_response(result: Any, *, method: str) -> Any:
        if not (
            isinstance(result, dict)
            and result.get(RUNTIME_RPC_ENCODING_KEY) == RUNTIME_RPC_COMPRESSED_ENCODING
        ):
            return result

        payload = result.get("payload")
        if not isinstance(payload, str):
            raise RuntimeRpcError("Runtime RPC returned an invalid compressed payload")

        try:
            compressed = base64.b64decode(payload.encode("ascii"), validate=True)
            decoded = gzip.decompress(compressed)
            response = json.loads(decoded.decode("utf-8"))
        except Exception as exc:
            raise RuntimeRpcError("Runtime RPC returned an unreadable payload") from exc

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
    def _format_rpc_error(
        exc: Exception,
        *,
        device_id: str,
        method: str,
        timeout_seconds: int,
    ) -> str:
        if isinstance(exc, SocketTimeoutError):
            return (
                f"Runtime RPC '{method}' timed out after {timeout_seconds} seconds "
                f"waiting for device '{device_id}'."
            )
        if isinstance(exc, DisconnectedError):
            return (
                f"Runtime RPC '{method}' failed because device '{device_id}' "
                "disconnected before acknowledging the request."
            )
        if isinstance(exc, BadNamespaceError):
            return (
                f"Runtime RPC '{method}' failed because the local executor is not "
                f"connected to /local-executor for device '{device_id}'."
            )
        detail = str(exc).strip() or exc.__class__.__name__
        return f"Runtime RPC '{method}' failed: {detail}"


runtime_rpc_service = RuntimeRpcService()
