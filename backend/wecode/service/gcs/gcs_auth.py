# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""GCS gateway TAuth2 authentication helpers.

Extracted from ``gcs_gateway_service.py``. Provides TAuth2 header
construction and token-cache invalidation.
"""

import logging

from app.services.tauth import auth_headers
from app.services.weibo_account_binding import WEIBO_VIDEO_UID
from wecode.service.gcs.gcs_models import GcsGatewayError

logger = logging.getLogger(__name__)


def get_auth_headers() -> dict[str, str]:
    """Get TAuth2 headers for GCS gateway, raising on missing auth.

    On missing auth the cache is invalidated before raising so the next
    request re-fetches a fresh token.
    """
    headers = auth_headers(WEIBO_VIDEO_UID)
    if "Authorization" not in headers:
        invalidate_tauth_cache()
        raise GcsGatewayError("gcs_auth_failed", "TAuth token unavailable")
    return headers


def invalidate_tauth_cache() -> None:
    """Force TAuth token refresh on next request after 401/403.

    TAuth module (app.services.tauth) is open-source and does not expose a
    public cache-invalidation method. We access its private ``_cached_token``
    as a known coupling — if tauth is refactored, this is the single place
    to update. A future open-source PR adding ``tauth.invalidate_cache()``
    would let us remove this entirely.
    """
    from app.services import tauth as _tauth_mod

    # Prefer a public API if one becomes available.
    if hasattr(_tauth_mod, "invalidate_cache"):
        _tauth_mod.invalidate_cache()
        return

    # Fallback: clear the known private cache attribute.
    if hasattr(_tauth_mod, "_cached_token"):
        _tauth_mod._cached_token = None  # noqa: SLF001
    else:
        logger.warning(
            "[GCS] tauth module has neither invalidate_cache() nor "
            "_cached_token — token refresh may be delayed"
        )
