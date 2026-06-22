# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for Socket.IO connection setup."""

import logging
from typing import Any

from socketio.exceptions import ConnectionRefusedError


def _is_missing_socket_session_error(error: Exception) -> bool:
    if isinstance(error, KeyError):
        return True

    return isinstance(error, ValueError) and "not connected" in str(error)


def _reject_disconnected_client(
    logger: logging.Logger,
    log_prefix: str,
    sid: str,
    error: Exception,
    setup_stage: str,
    *,
    room: str | None = None,
) -> None:
    if not _is_missing_socket_session_error(error):
        raise error

    if room:
        logger.info(
            "%s Connection disappeared before %s; sid=%s, room=%s, error=%s",
            log_prefix,
            setup_stage,
            sid,
            room,
            error,
        )
    else:
        logger.info(
            "%s Connection disappeared before %s; sid=%s, error=%s",
            log_prefix,
            setup_stage,
            sid,
            error,
        )

    raise ConnectionRefusedError(
        "Client disconnected during connection setup"
    ) from error


async def save_connect_session(
    namespace: Any,
    sid: str,
    session_data: dict[str, Any],
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> None:
    """Save a Socket.IO session or reject if the connection disappeared."""
    try:
        await namespace.save_session(sid, session_data)
    except (KeyError, ValueError) as exc:
        _reject_disconnected_client(logger, log_prefix, sid, exc, "session save")


async def enter_connect_room(
    namespace: Any,
    sid: str,
    room: str,
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> None:
    """Join a Socket.IO room or reject if the connection disappeared."""
    try:
        await namespace.enter_room(sid, room)
    except (KeyError, ValueError) as exc:
        _reject_disconnected_client(
            logger,
            log_prefix,
            sid,
            exc,
            "room join",
            room=room,
        )
