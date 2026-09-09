# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Per-user encryption keys for native Wework transcript segments."""

import base64
import hashlib
import hmac

from app.core.config import settings

KEY_ALGORITHM = "aes-256-gcm"


def transcript_encryption_key(user_id: int) -> str:
    """Derive one stable key per user without persisting plaintext key material."""
    configured_secret = (
        settings.WEWORK_TRANSCRIPT_ENCRYPTION_SECRET or settings.SECRET_KEY
    )
    master = hashlib.sha256(
        f"wegent-wework-transcript-master:{configured_secret}".encode()
    ).digest()
    context = f"wegent-wework-transcript:user:{user_id}".encode()
    key = hmac.new(master, context, hashlib.sha256).digest()
    return base64.b64encode(key).decode("ascii")
