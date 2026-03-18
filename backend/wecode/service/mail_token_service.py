# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for exchanging client tokens for mail tokens via KMS API
and storing them encrypted in user preferences.
"""

import json
import logging
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from app.models.user import User
from shared.utils.crypto import encrypt_sensitive_data

logger = logging.getLogger(__name__)


class MailTokenService:
    """Service for managing company mail tokens."""

    KMS_URL = "https://kms.weibo.com/api/wegent/mail/token"

    async def exchange_and_save(
        self, db: Session, user: User, client_token: str
    ) -> None:
        """
        Exchange a client_token for a mail_token via KMS API,
        encrypt and store in user preferences.

        Args:
            db: Database session
            user: Current user
            client_token: Token obtained from DingTalk bot

        Raises:
            httpx.HTTPStatusError: When KMS API returns non-2xx
            ValueError: When KMS response is missing token
        """
        # Call KMS API to exchange client_token for mail_token
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.KMS_URL,
                json={
                    "client_token": client_token,
                    "user_id": user.user_name,
                },
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()

        mail_token = data.get("token")
        if not mail_token:
            raise ValueError("KMS response missing 'token' field")

        # Encrypt and store in preferences
        encrypted_token = encrypt_sensitive_data(mail_token)
        self._update_preferences(db, user, "sina_mail_token", encrypted_token)

    def get_status(self, user: User) -> bool:
        """Check whether a mail token is configured for the user."""
        prefs = self._parse_preferences(user)
        return bool(prefs.get("sina_mail_token"))

    async def delete(self, db: Session, user: User) -> None:
        """Remove the mail token from user preferences."""
        self._update_preferences(db, user, "sina_mail_token", None)

    @staticmethod
    def _parse_preferences(user: User) -> dict:
        """Parse user.preferences JSON string to dict."""
        if not user.preferences:
            return {}
        if isinstance(user.preferences, str):
            try:
                return json.loads(user.preferences)
            except (json.JSONDecodeError, TypeError):
                return {}
        if isinstance(user.preferences, dict):
            return user.preferences
        return {}

    @staticmethod
    def _update_preferences(
        db: Session, user: User, key: str, value: Optional[str]
    ) -> None:
        """Update a single key in user preferences JSON."""
        prefs = MailTokenService._parse_preferences(user)
        if value is None:
            prefs.pop(key, None)
        else:
            prefs[key] = value
        user.preferences = json.dumps(prefs)
        db.commit()
        db.refresh(user)


# Global instance
mail_token_service = MailTokenService()
