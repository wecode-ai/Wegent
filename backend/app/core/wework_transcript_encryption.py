# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Per-transcript encryption keys for native Wework transcript segments."""

import base64
import hashlib
import hmac

from app.core.config import settings

KEY_VERSION = 1
KEY_ALGORITHM = "aes-256-gcm"


def transcript_encryption_key(user_id: int, transcript_id: str) -> str:
    """Derive a stable transcript key without persisting plaintext key material."""
    master = hashlib.sha256(
        f"wegent-wework-transcript-master:{settings.SECRET_KEY}".encode()
    ).digest()
    context = (
        f"wegent-wework-transcript:{user_id}:{transcript_id}:v{KEY_VERSION}"
    ).encode()
    key = hmac.new(master, context, hashlib.sha256).digest()
    return base64.b64encode(key).decode("ascii")
