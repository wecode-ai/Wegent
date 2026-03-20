# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for exchanging client tokens for mail tokens via KMS API
and storing them encrypted in user preferences.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from jose import jwt
from sqlalchemy.orm import Session

from app.models.user import User
from shared.utils.crypto import encrypt_sensitive_data
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = logging.getLogger(__name__)

# JWT configuration for KMS API authentication (from environment variables)
KMS_SECRET_KEY = os.environ.get("KMS_SECRET_KEY", "").strip()
KMS_BASE_URL = os.environ.get("KMS_BASE_URL", "").strip()
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = 5


class KMSNotConfiguredError(Exception):
    """Raised when KMS environment variables are not configured."""

    pass


class MailTokenService:
    """Service for managing company mail tokens."""

    @property
    def KMS_TOKEN_URL(self) -> str:
        """Get the KMS token exchange URL."""
        return f"{KMS_BASE_URL}/mail/token"

    @property
    def KMS_TOKEN_A_URL(self) -> str:
        """Get the KMS token_a application URL."""
        return f"{KMS_BASE_URL}/mail/token_a"

    @staticmethod
    def _check_kms_config() -> None:
        """Check if KMS environment variables are configured.

        Raises:
            KMSNotConfiguredError: When KMS_SECRET_KEY or KMS_BASE_URL is not set
        """
        if not KMS_SECRET_KEY or not KMS_BASE_URL:
            raise KMSNotConfiguredError(
                "KMS service is not configured. "
                "Please set KMS_SECRET_KEY and KMS_BASE_URL environment variables."
            )

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
            KMSNotConfiguredError: When KMS is not configured
            httpx.HTTPStatusError: When KMS API returns non-2xx
            ValueError: When KMS response is missing token
        """
        self._check_kms_config()

        request_body = {
            "client_token": client_token,
            "user_id": user.user_name,
        }

        logger.info(
            f"KMS /mail/token request: user={user.user_name}, "
            f"body={mask_sensitive_data(request_body)}"
        )

        # Call KMS API to exchange client_token for mail_token
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.KMS_TOKEN_URL,
                json=request_body,
                headers={"Content-Type": "application/json"},
            )

            try:
                response_data = response.json()
            except Exception:
                response_data = response.text

            logger.info(
                f"KMS /mail/token response: status={response.status_code}, "
                f"body={mask_sensitive_data(response_data)}"
            )

            response.raise_for_status()
            data = response_data if isinstance(response_data, dict) else {}

        mail_token = data.get("token")
        if not mail_token:
            raise ValueError("KMS response missing 'token' field")

        # Encrypt and store in preferences
        encrypted_token = encrypt_sensitive_data(mail_token)
        self._set_nested_preference(db, user, ["sina_mail", "token"], encrypted_token)

    def get_status(self, user: User) -> bool:
        """Check whether a mail token is configured for the user."""
        prefs = self._parse_preferences(user)
        return bool(prefs.get("sina_mail", {}).get("token"))

    async def delete(self, db: Session, user: User) -> None:
        """Remove the mail token from user preferences."""
        self._set_nested_preference(db, user, ["sina_mail", "token"], None)

    def generate_jwt(self, user: User) -> str:
        """
        Generate a JWT token for KMS API authentication.

        Args:
            user: Current user

        Returns:
            JWT token string

        Raises:
            KMSNotConfiguredError: When KMS is not configured
        """
        self._check_kms_config()

        expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)

        payload = {
            "sub": user.user_name,
            "user_id": user.id,
            "exp": expire,
        }

        token = jwt.encode(payload, KMS_SECRET_KEY, algorithm=JWT_ALGORITHM)
        return token

    async def apply_token_a(
        self, user: User, client_data: Optional[str] = None
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """
        Apply for client token (token_a) from KMS.

        This combines JWT generation and KMS API call into a single operation,
        keeping the KMS URL and JWT key private to the backend.

        Args:
            user: Current user
            client_data: Optional client information (browser info, etc.)

        Returns:
            Tuple of (success, token_a, error_message)
            - success: True if token_a was obtained
            - token_a: The client token if successful, None otherwise
            - error_message: Error message if failed, None otherwise
        """
        try:
            self._check_kms_config()
        except KMSNotConfiguredError as e:
            return False, None, str(e)

        jwt_token = self.generate_jwt(user)

        # Use default client data if not provided
        if client_data is None:
            client_data = json.dumps({"source": "wegent-backend"})

        request_body = {
            "jwt_token": jwt_token,
            "client-data": client_data,
        }

        logger.info(
            f"KMS /mail/token_a request: user={user.user_name}, "
            f"body={mask_sensitive_data(request_body)}"
        )

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.KMS_TOKEN_A_URL,
                json=request_body,
                headers={"Content-Type": "application/json"},
            )

            try:
                response_data = response.json()
            except Exception:
                response_data = response.text

            logger.info(
                f"KMS /mail/token_a response: status={response.status_code}, "
                f"body={mask_sensitive_data(response_data)}"
            )

            response.raise_for_status()
            data = response_data if isinstance(response_data, dict) else {}

        if not data.get("success"):
            return False, None, data.get("message", "Unknown error from KMS")

        token_a = data.get("token_a")
        if not token_a:
            return False, None, "KMS response missing token_a"

        return True, token_a, None

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
        """Update a single top-level key in user preferences JSON."""
        prefs = MailTokenService._parse_preferences(user)
        if value is None:
            prefs.pop(key, None)
        else:
            prefs[key] = value
        user.preferences = json.dumps(prefs)
        db.commit()
        db.refresh(user)

    @staticmethod
    def _set_nested_preference(
        db: Session, user: User, keys: list[str], value: Optional[str]
    ) -> None:
        """Set or remove a nested key in user preferences JSON.

        Args:
            db: Database session
            user: User model
            keys: Path segments, e.g. ["sina_mail", "token"]
            value: Value to set, or None to remove the leaf key.
                   Empty parent dicts are cleaned up automatically.
        """
        prefs = MailTokenService._parse_preferences(user)
        if value is not None:
            # Set nested value, creating intermediate dicts as needed
            target = prefs
            for k in keys[:-1]:
                target = target.setdefault(k, {})
            target[keys[-1]] = value
        else:
            # Remove nested key and clean up empty parent dicts
            target = prefs
            parents: list[tuple[dict, str]] = []
            for k in keys[:-1]:
                if not isinstance(target.get(k), dict):
                    break
                parents.append((target, k))
                target = target[k]
            else:
                target.pop(keys[-1], None)
                # Remove empty parent dicts bottom-up
                for parent, k in reversed(parents):
                    if not parent[k]:
                        del parent[k]
        user.preferences = json.dumps(prefs)
        db.commit()
        db.refresh(user)


# Global instance
mail_token_service = MailTokenService()
