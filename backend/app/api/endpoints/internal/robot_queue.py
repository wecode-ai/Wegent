# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal robot queue dispatch endpoint.

The Celery worker must not touch the Socket.IO singleton (it is bound to the
uvicorn event loop and a forked worker's loop mismatch breaks ACK-based RPCs).
This endpoint runs inside the uvicorn process where the device sockets live,
so it can emit `runtime:rpc` to a device reliably.
"""

import logging
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.core.socketio import get_sio
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/robot-queue", tags=["internal-robot-queue"])


@router.post("/emit-runtime-rpc")
async def emit_runtime_rpc(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Emit a runtime RPC (for example runtime.tasks.create) to one device.

    Fire-and-forget by default (used for runtime.tasks.cancel and side-effect
    notifications). When ``wait_ack`` is set, wait for the executor's ACK and
    return whether it accepted the RPC, so the dispatcher can verify a codex
    session was actually created before marking the run running.
    """

    user_id = payload.get("user_id")
    device_id = payload.get("device_id")
    method = payload.get("method") or "runtime.tasks.create"
    rpc_payload = payload.get("payload")
    wait_ack = bool(payload.get("wait_ack"))
    try:
        ack_timeout = int(payload.get("ack_timeout_seconds") or 15)
    except (TypeError, ValueError):
        ack_timeout = 15
    if not user_id or not device_id or not isinstance(rpc_payload, dict):
        raise HTTPException(
            status_code=422, detail="user_id/device_id/payload required"
        )
    online = await device_service.get_device_online_info(int(user_id), str(device_id))
    socket_id = (online or {}).get("socket_id") if online else None
    if not socket_id:
        return {"emitted": False, "reason": "device_offline"}
    logger.info(
        "[RobotQueue] Emitting runtime RPC method=%s user_id=%s device_id=%s "
        "socket_id=%s payload_keys=%s task_id=%s",
        method,
        user_id,
        device_id,
        socket_id,
        sorted(rpc_payload.keys()),
        (rpc_payload.get("taskId") or rpc_payload.get("task_id")),
    )
    if wait_ack:
        try:
            result = await get_sio().call(
                "runtime:rpc",
                {"method": method, "payload": rpc_payload},
                to=socket_id,
                namespace="/local-executor",
                timeout=ack_timeout,
            )
        except Exception as exc:
            logger.warning(
                "[RobotQueue] Runtime RPC ACK timed out method=%s user_id=%s "
                "device_id=%s error=%s",
                method,
                user_id,
                device_id,
                str(exc)[:300],
            )
            return {
                "emitted": True,
                "accepted": False,
                "error": f"runtime RPC ACK timed out after {ack_timeout}s",
            }
        accepted = bool(
            result.get("accepted", result.get("success", False))
            if isinstance(result, dict)
            else False
        )
        return {
            "emitted": True,
            "accepted": accepted,
            "response": result if isinstance(result, dict) else {"value": result},
        }
    await get_sio().emit(
        "runtime:rpc",
        {"method": method, "payload": rpc_payload},
        to=socket_id,
        namespace="/local-executor",
    )
    return {"emitted": True}


@router.get("/device-status")
async def robot_queue_device_status(
    user_id: int,
    device_id: str,
) -> Dict[str, Any]:
    """Return the device online state the queue dispatcher observes.

    Diagnostic aid for "device went offline before dispatch": online state is
    a Redis heartbeat key written by the executor's device socket, so this
    endpoint reflects exactly what the dispatcher sees for one user/device.
    """

    online = await device_service.get_device_online_info(int(user_id), str(device_id))
    if not online:
        return {"user_id": int(user_id), "device_id": str(device_id), "online": False}
    return {
        "user_id": int(user_id),
        "device_id": str(device_id),
        "online": True,
        "status": online.get("status"),
        "name": online.get("name"),
        "executor_version": online.get("executor_version"),
        "client_ip": online.get("client_ip"),
        "runtime_transfer_host": online.get("runtime_transfer_host"),
        "last_heartbeat": online.get("last_heartbeat"),
        "socket_id": online.get("socket_id"),
    }
