# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal robot queue dispatch endpoint.

The Celery worker must not touch the Socket.IO singleton (it is bound to the
uvicorn event loop and a forked worker's loop mismatch breaks ACK-based RPCs).
This endpoint runs inside the uvicorn process where the device sockets live,
so it can emit `runtime:rpc` to a device reliably.
"""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.core.socketio import get_sio
from app.services.device_service import device_service

router = APIRouter(prefix="/robot-queue", tags=["internal-robot-queue"])


@router.post("/emit-runtime-rpc")
async def emit_runtime_rpc(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Emit a runtime RPC (for example runtime.tasks.create) to one device."""

    user_id = payload.get("user_id")
    device_id = payload.get("device_id")
    method = payload.get("method") or "runtime.tasks.create"
    rpc_payload = payload.get("payload")
    if not user_id or not device_id or not isinstance(rpc_payload, dict):
        raise HTTPException(
            status_code=422, detail="user_id/device_id/payload required"
        )
    online = await device_service.get_device_online_info(int(user_id), str(device_id))
    socket_id = (online or {}).get("socket_id") if online else None
    if not socket_id:
        return {"emitted": False, "reason": "device_offline"}
    # Fire-and-forget: do not wait for an ACK. The Socket.IO Redis manager
    # routes ACKs through a two-level callback id table shared by every
    # concurrent call (for example capability sync), so a lost or misrouted
    # ACK would stall this endpoint for the full timeout. The dispatcher
    # writes `runtime_task_id` optimistically and runtime events write back
    # the real status, so the ACK carries no information we depend on.
    await get_sio().emit(
        "runtime:rpc",
        {"method": method, "payload": rpc_payload},
        to=socket_id,
        namespace="/local-executor",
    )
    return {"emitted": True}
