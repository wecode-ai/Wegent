# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Send Runtime cancellation requests through the existing internal RPC route."""

import logging
from collections.abc import Iterable
from dataclasses import dataclass

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RuntimeCancellationTarget:
    owner_user_id: int
    device_id: str
    task_id: str
    runtime_device_id: str

    @property
    def identity(self) -> tuple[int, str, str]:
        return self.owner_user_id, self.device_id, self.task_id


def _internal_url() -> str:
    base = (
        (settings.BACKEND_INTERNAL_URL or "http://localhost:8000").strip().rstrip("/")
    )
    return base if base.endswith("/api") else f"{base}/api"


def emit_runtime_cancellations(
    targets: Iterable[RuntimeCancellationTarget],
) -> set[RuntimeCancellationTarget]:
    """Return accepted control requests without projecting task completion.

    Offline devices and transport failures do not undo an already committed
    archive or cancellation. Runtime terminal events remain authoritative.
    """

    accepted: set[RuntimeCancellationTarget] = set()
    seen: set[tuple[int, str, str]] = set()
    for target in targets:
        if not target.owner_user_id or not target.device_id or not target.task_id:
            continue
        if target.identity in seen:
            continue
        seen.add(target.identity)
        try:
            with httpx.Client(
                base_url=_internal_url(), timeout=5, trust_env=False
            ) as client:
                response = client.post(
                    "/internal/robot-queue/emit-runtime-rpc",
                    headers={
                        "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"
                    },
                    json={
                        "user_id": target.owner_user_id,
                        "device_id": target.device_id,
                        "method": "runtime.tasks.cancel",
                        "payload": {
                            "taskId": target.task_id,
                            "deviceId": target.runtime_device_id,
                        },
                        "wait_ack": True,
                        "ack_timeout_seconds": 15,
                    },
                )
                result = response.json() if response.status_code == 200 else {}
                if response.status_code == 200 and result.get("accepted"):
                    accepted.add(target)
        except Exception:
            logger.exception("Runtime cancel failed target=%s", target.identity)
    return accepted
