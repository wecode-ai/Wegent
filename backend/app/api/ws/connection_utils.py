# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for Socket.IO connection setup."""

import logging
from typing import Any


async def save_connect_session(
    namespace: Any,
    sid: str,
    session_data: dict[str, Any],
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> bool:
    """Save a Socket.IO session if the connection is still present."""
    try:
        await namespace.save_session(sid, session_data)
    except KeyError as exc:
        logger.info(
            "%s Connection disappeared before session save; sid=%s, error=%s",
            log_prefix,
            sid,
            exc,
        )
        return False

    return True


async def enter_connect_room(
    namespace: Any,
    sid: str,
    room: str,
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> bool:
    """Join a Socket.IO room if the connection is still present."""
    try:
        await namespace.enter_room(sid, room)
    except (KeyError, ValueError) as exc:
        logger.info(
            "%s Connection disappeared before room join; sid=%s, room=%s, error=%s",
            log_prefix,
            sid,
            room,
            exc,
        )
        return False

    return True
