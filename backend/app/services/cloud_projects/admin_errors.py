# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable errors shared by project configuration transports."""

from fastapi import HTTPException


def config_error(
    reason_code: str, message: str, *, field: str = "", status_code: int = 422
) -> HTTPException:
    detail: dict[str, object] = {"reason_code": reason_code, "message": message}
    if field:
        detail["fields"] = [{"path": field, "message": message}]
    return HTTPException(status_code, detail)
