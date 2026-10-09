# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Response-boundary timezone handling.

Database datetime columns are naive values on the MySQL +08:00 session basis.
HTTP responses must not emit them as bare ISO strings, because consumers
cannot tell the basis apart from UTC (the frontend has historically done
both, which is how the 8-hour display drift appeared).

This module appends the +08:00 offset to every naive datetime at the HTTP
response boundary only:

- ORM objects, cache payloads, cursors and DB JSON fields stay naive.
- The patch targets fastapi.routing.jsonable_encoder (the function the
  routing module binds at import time and uses exclusively for HTTP response
  serialization), so internal call sites of fastapi.encoders are unaffected.
"""

from datetime import datetime
from typing import Any

import fastapi.routing

from app.db.timezone import MYSQL_SESSION_TIMEZONE_OFFSET

_DATETIME_SUFFIX = f"{MYSQL_SESSION_TIMEZONE_OFFSET}"


def _encode_datetime(value: datetime) -> str:
    if value.tzinfo is None:
        return value.isoformat() + _DATETIME_SUFFIX
    return value.isoformat()


_original_jsonable_encoder = fastapi.routing.jsonable_encoder


def _tz_aware_jsonable_encoder(obj: Any, *args: Any, **kwargs: Any) -> Any:
    custom_encoder = dict(kwargs.pop("custom_encoder", None) or {})
    custom_encoder.setdefault(datetime, _encode_datetime)
    return _original_jsonable_encoder(
        obj, *args, custom_encoder=custom_encoder, **kwargs
    )


def patch_response_timezone() -> None:
    """Route HTTP response serialization through the timezone-aware encoder."""
    fastapi.routing.jsonable_encoder = _tz_aware_jsonable_encoder
