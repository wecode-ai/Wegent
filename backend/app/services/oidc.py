# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
import logging
from functools import partial
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from fastapi import HTTPException

from ..core.config import settings
from ..core.payload_codec import decode_sync_response_json, run_payload_codec

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
                client = await self._build_http_client()
                async with client:
                    response = await client.get(self.discovery_url, timeout=10)
                    response.raise_for_status()
                    self._metadata = await decode_sync_response_json(response)
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
                client = await self._build_http_client()
                async with client:
                    response = await client.get(jwks_uri, timeout=10)
                    response.raise_for_status()
                    jwks = await decode_sync_response_json(response)

                    if not jwks.get("keys"):
                        logger.error("JWKS response missing non-empty 'keys' array")
                        raise HTTPException(
                            status_code=502, detail="OIDC JWKS payload invalid"
                        )

                    self._jwks = jwks
                    key_ids = await run_payload_codec(
                        self._jwks_key_ids,
                        jwks,
                        payload_hint=jwks,
                        force_offload=True,
                    )
                    logger.info(
                        f"Successfully retrieved JWKS: {jwks_uri}; kids={key_ids}"
                    )
            except Exception as e:
                logger.error(f"Failed to retrieve JWKS: {e}")
                raise HTTPException(
                    status_code=502, detail=f"Unable to retrieve JWKS: {e}"
                )
        else:
            key_ids = await run_payload_codec(
                self._jwks_key_ids,
                self._jwks,
                payload_hint=self._jwks,
                force_offload=True,
            )
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

        request = await run_payload_codec(
            self._build_token_exchange_request,
            token_endpoint,
            code,
            self.redirect_uri,
            self.client_id,
            self.client_secret,
            payload_hint=(token_endpoint, code, self.redirect_uri),
            force_offload=True,
        )
        client = await self._build_http_client()

        try:
            async with client:
                response = await client.send(request)
                token = await run_payload_codec(
                    self._parse_token_response,
                    response,
                    payload_hint=response.content,
                    force_offload=True,
                )
            logger.info("Successfully obtained OIDC tokens")
            return token
        except Exception as e:
            logger.error(f"Token exchange failed: {e}")
            raise HTTPException(status_code=400, detail=f"Token exchange failed: {e}")

    async def verify_id_token(self, id_token: str, nonce: str) -> Dict[str, Any]:
        """Verify ID Token"""
        metadata = await self.get_metadata()
        last_error: Optional[Exception] = None
        header = await run_payload_codec(
            self._parse_jwt_header,
            id_token,
            payload_hint=id_token,
            force_offload=True,
        )
        logger.info(
            "ID token header parsed: alg=%s, kid=%s",
            header.get("alg"),
            header.get("kid"),
        )

        for attempt in (1, 2):
            try:
                jwks = await self.get_jwks()
                key_ids = await run_payload_codec(
                    self._jwks_key_ids,
                    jwks,
                    payload_hint=jwks,
                    force_offload=True,
                )
                logger.info(
                    "Attempt %s verifying ID token with JWKS kids=%s",
                    attempt,
                    key_ids,
                )
                claims = await run_payload_codec(
                    self._decode_id_token,
                    id_token,
                    jwks,
                    metadata["issuer"],
                    self.client_id,
                    nonce,
                    payload_hint=id_token,
                    force_offload=True,
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

        logger.error("ID Token verification failed: %s", last_error)
        raise HTTPException(
            status_code=400, detail=f"ID Token verification failed: {last_error}"
        )

    @staticmethod
    async def _build_http_client() -> httpx.AsyncClient:
        """Construct HTTPX outside the event loop because it loads TLS state."""
        return await run_payload_codec(
            partial(httpx.AsyncClient),
            payload_hint=(),
            force_offload=True,
        )

    @staticmethod
    def _build_token_exchange_request(
        token_endpoint: str,
        code: str,
        redirect_uri: str,
        client_id: str,
        client_secret: str,
    ) -> httpx.Request:
        credentials = base64.b64encode(
            f"{client_id}:{client_secret}".encode("utf-8")
        ).decode("ascii")
        return httpx.Request(
            "POST",
            token_endpoint,
            content=urlencode(
                {
                    "grant_type": "authorization_code",
                    "redirect_uri": redirect_uri,
                    "code": code,
                }
            ),
            headers={
                "Accept": "application/json",
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
        )

    @staticmethod
    def _parse_token_response(response: httpx.Response) -> Dict[str, Any]:
        if response.status_code >= 500:
            response.raise_for_status()
        token = response.json()
        if "error" in token:
            description = token.get("error_description") or token["error"]
            raise ValueError(str(description))
        return token

    @staticmethod
    def _jwks_key_ids(jwks: Dict[str, Any]) -> list[str]:
        return [
            key["kid"]
            for key in jwks.get("keys", [])
            if isinstance(key, dict) and isinstance(key.get("kid"), str)
        ]

    @staticmethod
    def _decode_id_token(
        id_token: str,
        jwks: Dict[str, Any],
        issuer: str,
        client_id: str,
        nonce: str,
    ) -> Dict[str, Any]:
        """Load Authlib and verify one token in the bounded codec worker."""
        from authlib.jose import jwt

        return jwt.decode(
            id_token,
            jwks,
            claims_options={
                "iss": {"essential": True, "value": issuer},
                "aud": {"essential": True, "value": client_id},
                "nonce": {"essential": True, "value": nonce},
            },
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
            client = await self._build_http_client()
            async with client:
                response = await client.get(
                    userinfo_endpoint,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
                response.raise_for_status()
                user_info = await decode_sync_response_json(response)
                logger.info("Successfully obtained user information")
                return user_info
        except Exception as e:
            logger.warning(f"Failed to obtain user information: {e}")
            return {}


oidc_service = OIDCService()
