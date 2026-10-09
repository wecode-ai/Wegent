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

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import fastapi.routing
from fastapi._compat import v2 as _compat_v2
from starlette.responses import JSONResponse

from app.core.config import settings
from app.db.timezone import MYSQL_SESSION_TIMEZONE_OFFSET


def _resolve_suffix() -> str:
    """Pick the offset matching the configured database's naive basis.

    MySQL sessions are pinned to +08:00; SQLite CURRENT_TIMESTAMP is always
    UTC. Labeling SQLite values +08:00 would shift their instant by 8 hours.
    """
    if settings.DATABASE_URL.startswith("sqlite"):
        return "+00:00"
    return MYSQL_SESSION_TIMEZONE_OFFSET


_DATETIME_SUFFIX = _resolve_suffix()


def _encode_datetime(value: datetime) -> str:
    if value.tzinfo is None:
        return value.isoformat() + _DATETIME_SUFFIX
    if value.utcoffset() == timedelta(0):
        # Preserve pydantic's previous 'Z' rendering for aware UTC values.
        return value.isoformat().replace("+00:00", "Z")
    return value.isoformat()


_original_jsonable_encoder = fastapi.routing.jsonable_encoder
_original_model_field_serialize = _compat_v2.ModelField.serialize
_original_json_render = JSONResponse.render


def _python_mode_serialize(self, value: Any, **kwargs: Any) -> Any:
    """Keep datetime objects alive through response-model serialization.

    FastAPI's default mode="json" converts datetimes to plain ISO strings
    before jsonable_encoder runs, which would bypass the timezone suffix.
    ModelField.serialize is only used for HTTP response serialization in
    fastapi.routing, so python mode is safe here; the patched JSONResponse
    renderer performs the final datetime encoding.
    """
    kwargs["mode"] = "python"
    return _original_model_field_serialize(self, value, **kwargs)


def _tz_aware_jsonable_encoder(obj: Any, *args: Any, **kwargs: Any) -> Any:
    custom_encoder = dict(kwargs.pop("custom_encoder", None) or {})
    custom_encoder.setdefault(datetime, _encode_datetime)
    # Python-mode serialization (see _python_mode_serialize) keeps Decimal
    # objects alive; jsonable_encoder would turn them into int/float while
    # pydantic's JSON mode emits strings. Match the pydantic behavior so
    # non-datetime fields keep their response format and precision.
    custom_encoder.setdefault(Decimal, str)
    return _original_jsonable_encoder(
        obj, *args, custom_encoder=custom_encoder, **kwargs
    )


def _tz_aware_render(self: JSONResponse, content: Any) -> bytes:
    """Encode datetimes with the session offset at the final JSON boundary.

    Content may already be jsonable_encoder'd (dict-returning routes) or may
    still hold datetime objects (response-model routes in python mode). The
    timezone-aware encoder covers both.
    """
    return _original_json_render(self, _tz_aware_jsonable_encoder(content))


def patch_response_timezone() -> None:
    """Route HTTP response serialization through the timezone-aware encoder."""
    fastapi.routing.jsonable_encoder = _tz_aware_jsonable_encoder
    _compat_v2.ModelField.serialize = _python_mode_serialize
    JSONResponse.render = _tz_aware_render
