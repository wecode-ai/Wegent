# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal robot queue device-status diagnostics; runtime RPC is Rust-owned."""
from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.device_service import device_service

router = APIRouter(
    prefix="/robot-queue",
    tags=["internal-robot-queue"],
    dependencies=[Depends(verify_internal_service_token)],
)


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
