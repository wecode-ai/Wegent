# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.jose import jwt
from authlib.oidc.core import CodeIDToken
from fastapi import HTTPException
from shared.utils.sensitive_data_masker import mask_sensitive_data

from ..core.config import settings

logger = logging.getLogger(__name__)


class OIDCService:
    """OpenID Connect Authentication Service"""

    def __init__(self):
        self.client_id = settings.OIDC_CLIENT_ID
        self.client_secret = settings.OIDC_CLIENT_SECRET
        self.discovery_url = settings.OIDC_DISCOVERY_URL
        self.redirect_uri = settings.OIDC_REDIRECT_URI
        self.cli_redirect_uri = settings.OIDC_CLI_REDIRECT_URI

        self._metadata: Optional[Dict[str, Any]] = None
        self._jwks: Optional[Dict[str, Any]] = None

    async def get_metadata(self) -> Dict[str, Any]:
        """Get OpenID Connect Provider Metadata"""
        if self._metadata is None:
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(self.discovery_url, timeout=10)
                    response.raise_for_status()
                    self._metadata = response.json()
                    logger.info(
                        f"Successfully retrieved OIDC metadata: {self.discovery_url}"
                    )
            except Exception as e:
                logger.error(f"Failed to retrieve OIDC metadata: {e}")
                raise HTTPException(
                    status_code=502, detail=f"Unable to retrieve OIDC metadata: {e}"
                )

        return self._metadata

    async def get_jwks(self) -> Dict[str, Any]:
        """Get JSON Web Key Set"""
        if self._jwks is None:
            metadata = await self.get_metadata()
            jwks_uri = metadata.get("jwks_uri")

            if not jwks_uri:
                raise HTTPException(
                    status_code=502, detail="Missing jwks_uri in OIDC metadata"
                )

            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(jwks_uri, timeout=10)
                    response.raise_for_status()
                    jwks = response.json()

                    if not jwks.get("keys"):
                        logger.error(
                            f"JWKS response missing non-empty 'keys' array: {jwks}"
                        )
                        raise HTTPException(
                            status_code=502, detail="OIDC JWKS payload invalid"
                        )

                    self._jwks = jwks
                    key_ids = [key.get("kid") for key in jwks["keys"] if key.get("kid")]
                    logger.info(
                        f"Successfully retrieved JWKS: {jwks_uri}; kids={key_ids}"
                    )
            except Exception as e:
                logger.error(f"Failed to retrieve JWKS: {e}")
                raise HTTPException(
                    status_code=502, detail=f"Unable to retrieve JWKS: {e}"
                )
        else:
            key_ids = [
                key.get("kid") for key in self._jwks.get("keys", []) if key.get("kid")
            ]
            logger.info(f"Using cached JWKS; kids={key_ids}")

        return self._jwks

    async def get_authorization_url(self, state: str, nonce: str) -> str:
        """Generate Authorization URL"""
        metadata = await self.get_metadata()
        authorization_endpoint = metadata.get("authorization_endpoint")

        if not authorization_endpoint:
            raise HTTPException(
                status_code=502,
                detail="Missing authorization_endpoint in OIDC metadata",
            )

        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
        }

        auth_url = f"{authorization_endpoint}?{urlencode(params)}"
        logger.info(f"Generated authorization URL: {auth_url}")
        return auth_url

    async def get_authorization_url_for_cli(self, state: str, nonce: str) -> str:
        """Generate Authorization URL for CLI login (uses CLI redirect URI)"""
        metadata = await self.get_metadata()
        authorization_endpoint = metadata.get("authorization_endpoint")

        if not authorization_endpoint:
            raise HTTPException(
                status_code=502,
                detail="Missing authorization_endpoint in OIDC metadata",
            )

        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.cli_redirect_uri,
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
        }

        auth_url = f"{authorization_endpoint}?{urlencode(params)}"
        logger.info(f"Generated CLI authorization URL: {auth_url}")
        return auth_url

    async def exchange_code_for_tokens(self, code: str, state: str) -> Dict[str, Any]:
        """Exchange Authorization Code for Tokens"""
        metadata = await self.get_metadata()
        token_endpoint = metadata.get("token_endpoint")

        if not token_endpoint:
            raise HTTPException(
                status_code=502, detail="Missing token_endpoint in OIDC metadata"
            )

        client = AsyncOAuth2Client(
            client_id=self.client_id, client_secret=self.client_secret
        )

        try:
            token = await client.fetch_token(
                token_endpoint, code=code, redirect_uri=self.redirect_uri
            )
            logger.info(
                f"Successfully obtained access token, token:{mask_sensitive_data(token)}"
            )
            return token
        except Exception as e:
            logger.error(f"Token exchange failed: {e}")
            raise HTTPException(status_code=400, detail=f"Token exchange failed: {e}")

    async def verify_id_token(self, id_token: str, nonce: str) -> Dict[str, Any]:
        """Verify ID Token"""
        metadata = await self.get_metadata()
        last_error: Optional[Exception] = None
        header = self._parse_jwt_header(id_token)
        logger.info(
            "ID token header parsed: alg=%s, kid=%s",
            header.get("alg"),
            header.get("kid"),
        )

        for attempt in (1, 2):
            try:
                jwks = await self.get_jwks()
                logger.info(
                    "Attempt %s verifying ID token with JWKS kids=%s",
                    attempt,
                    [key.get("kid") for key in jwks.get("keys", []) if key.get("kid")],
                )
                claims = jwt.decode(
                    id_token,
                    jwks,
                    claims_options={
                        "iss": {"essential": True, "value": metadata["issuer"]},
                        "aud": {"essential": True, "value": self.client_id},
                        "nonce": {"essential": True, "value": nonce},
                    },
                )
                logger.info(
                    f"ID Token verification successful: sub={claims.get('sub')}"
                )
                return claims
            except Exception as e:
                last_error = e

                should_retry = attempt == 1 and "Invalid JSON Web Key Set" in str(e)

                if should_retry:
                    logger.warning(
                        "Cached JWKS appears invalid, forcing refresh before retrying decode"
                    )
                    self._jwks = None
                    continue

                break

        logger.error(
            f"ID Token verification id_token: {id_token}, failed: {last_error}"
        )
        raise HTTPException(
            status_code=400, detail=f"ID Token verification failed: {last_error}"
        )

    @staticmethod
    def _parse_jwt_header(token: str) -> Dict[str, Any]:
        try:
            header_segment = token.split(".")[0]
            padded_segment = header_segment + "=" * (-len(header_segment) % 4)
            decoded = base64.urlsafe_b64decode(padded_segment.encode("utf-8"))
            return json.loads(decoded)
        except Exception as exc:
            logger.info(f"Failed to parse JWT header: {exc}")
            return {}

    async def get_user_info(self, access_token: str) -> Dict[str, Any]:
        """Get User Information"""
        metadata = await self.get_metadata()
        userinfo_endpoint = metadata.get("userinfo_endpoint")

        if not userinfo_endpoint:
            logger.warning(
                "Missing userinfo_endpoint in OIDC metadata, skipping user info retrieval"
            )
            return {}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    userinfo_endpoint,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
                response.raise_for_status()
                user_info = response.json()
                logger.info("Successfully obtained user information")
                return user_info
        except Exception as e:
            logger.warning(f"Failed to obtain user information: {e}")
            return {}


oidc_service = OIDCService()
