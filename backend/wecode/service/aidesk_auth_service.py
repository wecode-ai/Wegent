# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Aidesk authentication service.

Provides signature verification for 口袋 App WebView SSO authentication.
Similar to DingTalk authentication service pattern.
"""

import hashlib
import hmac
import logging
import time
from typing import Optional, Tuple

from wecode.config.aidesk_config import aidesk_config

logger = logging.getLogger(__name__)


class AideskAuthService:
    """Service for Aidesk signature verification."""

    def __init__(self):
        self.config = aidesk_config

    def verify_signature(
        self,
        source: str,
        username: str,
        timestamp: str,
        sign: str,
    ) -> Tuple[bool, Optional[str]]:
        """
        Verify Aidesk signature.

        Args:
            source: Source identifier (should be "aidesk")
            username: User login name
            timestamp: Unix timestamp in seconds
            sign: MD5 signature (32-char lowercase hex)

        Returns:
            Tuple[bool, Optional[str]]: (is_valid, error_message)
        """
        # Check if secret key is configured
        if not self.config.secret_key:
            logger.error("[Aidesk] SECRET key not configured")
            return False, "Aidesk authentication not configured"

        # Validate timestamp window
        try:
            ts = int(timestamp)
            current_time = int(time.time())
            time_diff = abs(current_time - ts)
            if time_diff > self.config.timestamp_window:
                logger.warning(
                    f"[Aidesk] Timestamp out of window: "
                    f"request={ts}, server={current_time}, diff={time_diff}"
                )
                return False, "Timestamp expired"
        except ValueError:
            logger.error(f"[Aidesk] Invalid timestamp format: {timestamp}")
            return False, "Invalid timestamp format"

        # Calculate expected signature
        expected_sign = self._calculate_signature(source, username, timestamp)

        # Constant-time comparison to prevent timing attacks
        if not hmac.compare_digest(sign.lower(), expected_sign.lower()):
            logger.warning(f"[Aidesk] Signature mismatch for user={username}")
            return False, "Invalid signature"

        logger.info(f"[Aidesk] Signature verified for user={username}")
        return True, None

    def _calculate_signature(
        self,
        source: str,
        username: str,
        timestamp: str,
    ) -> str:
        """
        Calculate MD5 signature.

        Signature rules:
        1. Fields sorted alphabetically: source, timestamp, username
        2. Format: key1=value1&key2=value2&secret_key=<secret>
        3. MD5 hash, returned as 32-char lowercase hex

        Args:
            source: Source identifier
            username: User login name
            timestamp: Unix timestamp string

        Returns:
            32-character lowercase hex MD5 signature
        """
        # Strip whitespace from values
        source = source.strip()
        username = username.strip()
        timestamp = timestamp.strip()

        # Build signature string (fields sorted alphabetically)
        sign_str = (
            f"source={source}&timestamp={timestamp}&username={username}"
            f"&secret_key={self.config.secret_key}"
        )

        # Calculate MD5 hash
        md5_hash = hashlib.md5(sign_str.encode("utf-8")).hexdigest()
        return md5_hash.lower()


# Singleton instance
aidesk_auth_service = AideskAuthService()
