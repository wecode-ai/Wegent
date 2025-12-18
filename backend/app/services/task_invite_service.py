# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for task invite link functionality.
Reuses existing AES encryption from SharedTaskService.
"""

import base64
import logging
import urllib.parse
from datetime import datetime, timedelta
from typing import Optional

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.core.config import settings

logger = logging.getLogger(__name__)


class TaskInviteService:
    """Service for generating and validating group chat invite links."""

    def __init__(self):
        # Reuse existing AES key configuration from settings
        self.aes_key = settings.SHARE_TOKEN_AES_KEY.encode("utf-8")
        self.aes_iv = settings.SHARE_TOKEN_AES_IV.encode("utf-8")

    def _aes_encrypt(self, data: str) -> str:
        """Encrypt data using AES-256-CBC"""
        cipher = Cipher(
            algorithms.AES(self.aes_key),
            modes.CBC(self.aes_iv),
            backend=default_backend(),
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(data.encode("utf-8")) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode("utf-8")

    def _aes_decrypt(self, encrypted_data: str) -> Optional[str]:
        """Decrypt data using AES-256-CBC"""
        try:
            # Decode base64 encrypted data
            encrypted_bytes = base64.b64decode(encrypted_data.encode("utf-8"))

            # Create cipher object
            cipher = Cipher(
                algorithms.AES(self.aes_key),
                modes.CBC(self.aes_iv),
                backend=default_backend(),
            )
            decryptor = cipher.decryptor()

            # Decrypt the data
            decrypted_padded_bytes = (
                decryptor.update(encrypted_bytes) + decryptor.finalize()
            )

            # Unpad the data
            unpadder = padding.PKCS7(128).unpadder()
            decrypted_bytes = (
                unpadder.update(decrypted_padded_bytes) + unpadder.finalize()
            )

            # Return decrypted string
            return decrypted_bytes.decode("utf-8")
        except Exception as e:
            logger.warning(f"Failed to decrypt invite token: {e}")
            return None

    def generate_invite_token(
        self, task_id: int, inviter_id: int, expires_hours: int = 0
    ) -> str:
        """
        Generate a group chat invite token.
        Format: "invite#{task_id}#{inviter_id}#{expire_timestamp}"

        expires_hours=0 means permanent link (set to 10 years from now)
        """
        if expires_hours == 0:
            # Permanent link: set expiration to 10 years from now
            expire_time = datetime.utcnow() + timedelta(days=3650)
        else:
            expire_time = datetime.utcnow() + timedelta(hours=expires_hours)

        expire_ts = int(expire_time.timestamp())
        invite_data = f"invite#{task_id}#{inviter_id}#{expire_ts}"
        encrypted = self._aes_encrypt(invite_data)
        return urllib.parse.quote(encrypted)

    def decode_invite_token(self, token: str) -> Optional[dict]:
        """
        Decode an invite token.
        Returns: {"task_id": int, "inviter_id": int, "expires_at": datetime, "is_expired": bool}
        """
        try:
            decoded_token = urllib.parse.unquote(token)
            decrypted = self._aes_decrypt(decoded_token)

            if not decrypted or not decrypted.startswith("invite#"):
                return None

            parts = decrypted.split("#")
            if len(parts) != 4:
                return None

            _, task_id_str, inviter_id_str, expire_ts_str = parts
            expires_at = datetime.fromtimestamp(int(expire_ts_str))

            return {
                "task_id": int(task_id_str),
                "inviter_id": int(inviter_id_str),
                "expires_at": expires_at,
                "is_expired": datetime.utcnow() > expires_at,
            }
        except Exception as e:
            logger.warning(f"Failed to decode invite token: {e}")
            return None

    def generate_invite_url(self, token: str) -> str:
        """Generate the full invite URL"""
        base_url = settings.TASK_SHARE_BASE_URL
        return f"{base_url}/chat?invite={token}"


task_invite_service = TaskInviteService()
