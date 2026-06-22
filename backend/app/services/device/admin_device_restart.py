# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Extension point for admin-triggered device restart."""

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from sqlalchemy.orm import Session


@dataclass(frozen=True)
class AdminDeviceRestartResult:
    """Result returned by an admin device restart implementation."""

    success: bool
    message: str


AdminDeviceRestartHandler = Callable[
    [Session, int, str], Awaitable[AdminDeviceRestartResult]
]

_restart_handler: Optional[AdminDeviceRestartHandler] = None


def register_admin_device_restart_handler(
    handler: AdminDeviceRestartHandler,
) -> None:
    """Register the deployment-specific cloud device restart implementation."""
    global _restart_handler

    _restart_handler = handler


async def restart_admin_device(
    db: Session,
    user_id: int,
    device_id: str,
) -> AdminDeviceRestartResult:
    """Restart a cloud device through the registered deployment implementation."""
    if _restart_handler is None:
        return AdminDeviceRestartResult(
            success=False,
            message="Device restart is not configured in this deployment",
        )

    return await _restart_handler(db, user_id, device_id)


def _reset_admin_device_restart_handler_for_tests() -> None:
    """Clear the registered handler for isolated tests."""
    global _restart_handler

    _restart_handler = None
