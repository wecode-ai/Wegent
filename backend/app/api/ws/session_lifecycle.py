# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO connection lifecycle helpers.
"""

import logging
from typing import Any, Mapping


def _is_missing_socket_session_error(error: Exception) -> bool:
    if isinstance(error, KeyError):
        return True

    return isinstance(error, ValueError) and "not connected" in str(error)


def _reject_disconnected_client(
    logger: logging.Logger,
    prefix: str,
    sid: str,
    error: Exception,
) -> None:
    if not _is_missing_socket_session_error(error):
        raise error

    logger.info(
        "%s Client disconnected before connection setup completed sid=%s",
        prefix,
        sid,
    )
    raise ConnectionRefusedError(
        "Client disconnected during connection setup"
    ) from error


async def save_connect_session(
    namespace: Any,
    sid: str,
    session: Mapping[str, Any],
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> None:
    try:
        await namespace.save_session(sid, dict(session))
    except (KeyError, ValueError) as error:
        _reject_disconnected_client(logger, log_prefix, sid, error)


async def enter_connect_room(
    namespace: Any,
    sid: str,
    room: str,
    *,
    logger: logging.Logger,
    log_prefix: str,
) -> None:
    try:
        await namespace.enter_room(sid, room)
    except (KeyError, ValueError) as error:
        _reject_disconnected_client(logger, log_prefix, sid, error)
