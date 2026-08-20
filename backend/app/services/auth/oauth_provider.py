# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Constrained OAuth 2 provider for external user identity."""

import base64
import hashlib
import logging
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import jwt
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.models.oauth_refresh_token import OAuthRefreshToken
from app.models.user import User
from app.schemas.oauth_provider import (
    OAUTH_AUDIENCE,
    OAUTH_CLIENT_KIND,
    OAUTH_SCOPE,
    OAuthAuthorizationDecisionResponse,
    OAuthAuthorizationRequestResponse,
    OAuthClientCreateRequest,
    OAuthClientKind,
    OAuthClientResponse,
    OAuthClientStatus,
    OAuthClientUpdateRequest,
    OAuthTokenResponse,
    OAuthUserInfoResponse,
)
from app.schemas.token_issuer import SigningKeyKind, TokenIssuerKind
from app.services.auth.outbound_token_service import (
    SIGNING_KEY_KIND,
    SYSTEM_NAMESPACE,
    SYSTEM_USER_ID,
    TOKEN_ISSUER_KIND,
    OutboundTokenError,
    outbound_token_service,
)

AUTH_REQUEST_TTL_SECONDS = 10 * 60
AUTH_CODE_TTL_SECONDS = 5 * 60
AUTH_REQUEST_PREFIX = "oauth_authorization_request:"
AUTH_CODE_PREFIX = "oauth_authorization_code:"
PKCE_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")

logger = logging.getLogger(__name__)


class OAuthProviderError(Exception):
    def __init__(self, error: str, description: str, status_code: int = 400):
        super().__init__(description)
        self.error = error
        self.description = description
        self.status_code = status_code


class OAuthProviderService:
    def list_clients(self, db: Session) -> list[OAuthClientResponse]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == OAUTH_CLIENT_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return [self._to_client_response(db, row) for row in rows]

    def create_client(
        self, db: Session, request: OAuthClientCreateRequest
    ) -> OAuthClientResponse:
        self._ensure_unique_name(db, request.name)
        self._validate_issuer(
            db,
            request.token_issuer_id,
            enabled=request.enabled,
            access_ttl_seconds=request.access_ttl_seconds,
        )
        client_id = f"wgo_{secrets.token_urlsafe(24)}"
        client_secret = (
            f"wgos_{secrets.token_urlsafe(36)}"
            if request.client_type == "confidential"
            else None
        )
        resource = OAuthClientKind(
            metadata={"name": request.name, "namespace": SYSTEM_NAMESPACE},
            spec={
                "clientId": client_id,
                "clientType": request.client_type,
                "clientSecretHash": (
                    self._hash_secret(client_secret) if client_secret else None
                ),
                "redirectUris": [str(uri) for uri in request.redirect_uris],
                "tokenIssuerRef": {"kindId": request.token_issuer_id},
                "accessTtlSeconds": request.access_ttl_seconds,
                "refreshTtlSeconds": request.refresh_ttl_seconds,
                "enabled": request.enabled,
                "description": request.description or "",
            },
            status={"state": "Available" if request.enabled else "Disabled"},
        )
        row = Kind(
            user_id=SYSTEM_USER_ID,
            kind=OAUTH_CLIENT_KIND,
            name=request.name,
            namespace=SYSTEM_NAMESPACE,
            json=resource.model_dump(),
            is_active=request.enabled,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._to_client_response(db, row, client_secret=client_secret)

    def update_client(
        self, db: Session, client_id: int, request: OAuthClientUpdateRequest
    ) -> OAuthClientResponse:
        row = self._get_client_row(db, client_id)
        resource = OAuthClientKind.model_validate(row.json)
        generated_secret = None
        revoke_existing_tokens = False
        if request.name is not None and request.name != row.name:
            self._ensure_unique_name(db, request.name, exclude_id=row.id)
            row.name = request.name
            resource.metadata.name = request.name
        if request.redirect_uris is not None:
            resource.spec.redirectUris = [str(uri) for uri in request.redirect_uris]
        if request.token_issuer_id is not None:
            revoke_existing_tokens = (
                request.token_issuer_id != resource.spec.tokenIssuerRef.kindId
            )
            resource.spec.tokenIssuerRef.kindId = request.token_issuer_id
        if request.client_type is not None:
            revoke_existing_tokens = (
                revoke_existing_tokens
                or request.client_type != resource.spec.clientType
            )
            resource.spec.clientType = request.client_type
            if request.client_type == "public":
                resource.spec.clientSecretHash = None
            elif not resource.spec.clientSecretHash:
                generated_secret = f"wgos_{secrets.token_urlsafe(36)}"
                resource.spec.clientSecretHash = self._hash_secret(generated_secret)
        if request.access_ttl_seconds is not None:
            resource.spec.accessTtlSeconds = request.access_ttl_seconds
        if request.refresh_ttl_seconds is not None:
            resource.spec.refreshTtlSeconds = request.refresh_ttl_seconds
        if request.description is not None:
            resource.spec.description = request.description
        if request.enabled is not None:
            resource.spec.enabled = request.enabled
            row.is_active = request.enabled
            if resource.status is None:
                resource.status = OAuthClientStatus()
            resource.status.state = "Available" if request.enabled else "Disabled"
            if not request.enabled:
                revoke_existing_tokens = True
        self._validate_issuer(
            db,
            resource.spec.tokenIssuerRef.kindId,
            enabled=row.is_active,
            access_ttl_seconds=resource.spec.accessTtlSeconds,
        )
        if revoke_existing_tokens:
            self._revoke_client_tokens(db, row.id)
        row.json = resource.model_dump()
        db.commit()
        db.refresh(row)
        return self._to_client_response(db, row, client_secret=generated_secret)

    def rotate_client_secret(self, db: Session, client_id: int) -> OAuthClientResponse:
        row = self._get_client_row(db, client_id)
        resource = OAuthClientKind.model_validate(row.json)
        if resource.spec.clientType != "confidential":
            raise OAuthProviderError(
                "invalid_client", "Public clients do not have client secrets"
            )
        client_secret = f"wgos_{secrets.token_urlsafe(36)}"
        resource.spec.clientSecretHash = self._hash_secret(client_secret)
        row.json = resource.model_dump()
        self._revoke_client_tokens(db, row.id)
        db.commit()
        db.refresh(row)
        return self._to_client_response(db, row, client_secret=client_secret)

    def delete_client(self, db: Session, client_id: int) -> None:
        row = self._get_client_row(db, client_id)
        self._revoke_client_tokens(db, row.id)
        db.delete(row)
        db.commit()

    async def begin_authorization(
        self,
        db: Session,
        *,
        response_type: str,
        client_id: str,
        redirect_uri: str,
        scope: str,
        state: str,
        code_challenge: str,
        code_challenge_method: str,
    ) -> str:
        client_row, _ = self._get_active_client_by_public_id(db, client_id)
        self._validate_authorization_request(
            client_row,
            response_type=response_type,
            redirect_uri=redirect_uri,
            scope=scope,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )
        request_id = secrets.token_urlsafe(32)
        stored = await cache_manager.set(
            f"{AUTH_REQUEST_PREFIX}{request_id}",
            {
                "client_kind_id": client_row.id,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "scope": scope,
                "state": state,
                "code_challenge": code_challenge,
                "created_at": int(time.time()),
            },
            expire=AUTH_REQUEST_TTL_SECONDS,
        )
        if not stored:
            raise OAuthProviderError(
                "server_error", "Unable to create authorization request", 500
            )
        return (
            f"{settings.FRONTEND_URL.rstrip('/')}/auth/oauth/authorize?"
            f"{urlencode({'request_id': request_id})}"
        )

    def authorization_error_redirect(
        self,
        db: Session,
        *,
        client_id: str,
        redirect_uri: str,
        state: str,
        error: str,
        description: str,
    ) -> str | None:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == OAUTH_CLIENT_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )
        for row in rows:
            client = OAuthClientKind.model_validate(row.json)
            if (
                client.spec.enabled
                and client.spec.clientId == client_id
                and redirect_uri in client.spec.redirectUris
            ):
                query = {"error": error, "error_description": description}
                if state:
                    query["state"] = state
                return self._append_query(redirect_uri, query)
        return None

    async def get_authorization_request(
        self, db: Session, request_id: str
    ) -> OAuthAuthorizationRequestResponse:
        payload = await cache_manager.get(f"{AUTH_REQUEST_PREFIX}{request_id}")
        if not isinstance(payload, dict):
            raise OAuthProviderError(
                "invalid_request", "Authorization request expired or not found", 404
            )
        row = self._get_client_row(db, int(payload["client_kind_id"]), active=True)
        return OAuthAuthorizationRequestResponse(
            request_id=request_id,
            client_name=row.name,
            client_id=str(payload["client_id"]),
            scope=str(payload["scope"]),
            redirect_uri=str(payload["redirect_uri"]),
        )

    async def decide_authorization(
        self,
        db: Session,
        *,
        request_id: str,
        user: User,
        approved: bool,
    ) -> OAuthAuthorizationDecisionResponse:
        payload = await cache_manager.pop(f"{AUTH_REQUEST_PREFIX}{request_id}")
        if not isinstance(payload, dict):
            raise OAuthProviderError(
                "invalid_request", "Authorization request expired or already used", 404
            )
        self._get_client_row(db, int(payload["client_kind_id"]), active=True)
        redirect_uri = str(payload["redirect_uri"])
        state = str(payload.get("state") or "")
        if not approved:
            query = {"error": "access_denied"}
            if state:
                query["state"] = state
            return OAuthAuthorizationDecisionResponse(
                redirect_url=self._append_query(redirect_uri, query)
            )
        code = f"wgoac_{secrets.token_urlsafe(32)}"
        stored = await cache_manager.set(
            f"{AUTH_CODE_PREFIX}{self._hash_secret(code)}",
            {
                **payload,
                "user_id": user.id,
                "issued_at": int(time.time()),
            },
            expire=AUTH_CODE_TTL_SECONDS,
        )
        if not stored:
            raise OAuthProviderError("server_error", "Unable to issue code", 500)
        query = {"code": code}
        if state:
            query["state"] = state
        return OAuthAuthorizationDecisionResponse(
            redirect_url=self._append_query(redirect_uri, query)
        )

    async def exchange_code(
        self,
        db: Session,
        *,
        client_id: str,
        client_secret: str | None,
        code: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> OAuthTokenResponse:
        client_row, client = self.authenticate_client(
            db, client_id=client_id, client_secret=client_secret
        )
        payload = await cache_manager.pop(
            f"{AUTH_CODE_PREFIX}{self._hash_secret(code)}"
        )
        if not isinstance(payload, dict):
            raise OAuthProviderError("invalid_grant", "Invalid or expired code")
        if (
            int(payload["client_kind_id"]) != client_row.id
            or payload["redirect_uri"] != redirect_uri
            or not self._verify_pkce(
                code_verifier, str(payload.get("code_challenge") or "")
            )
        ):
            raise OAuthProviderError("invalid_grant", "Authorization code is invalid")
        user = db.query(User).filter(User.id == int(payload["user_id"])).first()
        if not user or not user.is_active:
            raise OAuthProviderError("invalid_grant", "User is inactive")
        return self._issue_token_pair(db, client_row, client, user)

    def refresh(
        self,
        db: Session,
        *,
        client_id: str,
        client_secret: str | None,
        refresh_token: str,
    ) -> OAuthTokenResponse:
        client_row, client = self.authenticate_client(
            db, client_id=client_id, client_secret=client_secret
        )
        token_hash = self._hash_secret(refresh_token)
        record = (
            db.query(OAuthRefreshToken)
            .filter(OAuthRefreshToken.token_hash == token_hash)
            .with_for_update()
            .first()
        )
        if not record or record.client_kind_id != client_row.id:
            raise OAuthProviderError("invalid_grant", "Invalid refresh token")
        now = self._utcnow()
        if record.used_at is not None:
            self._revoke_family(db, record.family_id, now)
            db.commit()
            logger.warning(
                "OAuth refresh token replay detected client_kind_id=%s user_id=%s",
                record.client_kind_id,
                record.user_id,
            )
            raise OAuthProviderError("invalid_grant", "Refresh token replay detected")
        if record.revoked_at is not None or record.expires_at <= now:
            raise OAuthProviderError("invalid_grant", "Refresh token is inactive")
        user = db.query(User).filter(User.id == record.user_id).first()
        if not user or not user.is_active:
            raise OAuthProviderError("invalid_grant", "User is inactive")
        record.used_at = now
        response, replacement = self._new_token_pair(
            db, client_row, client, user, family_id=record.family_id
        )
        db.flush()
        record.replaced_by_id = replacement.id
        db.commit()
        return response

    def revoke(
        self,
        db: Session,
        *,
        client_id: str,
        client_secret: str | None,
        refresh_token: str,
    ) -> None:
        client_row, _ = self.authenticate_client(
            db, client_id=client_id, client_secret=client_secret
        )
        record = (
            db.query(OAuthRefreshToken)
            .filter(OAuthRefreshToken.token_hash == self._hash_secret(refresh_token))
            .first()
        )
        if record and record.client_kind_id == client_row.id:
            self._revoke_family(db, record.family_id, self._utcnow())
            db.commit()

    def userinfo(self, db: Session, access_token: str) -> OAuthUserInfoResponse:
        try:
            unverified = jwt.decode(access_token, options={"verify_signature": False})
            issuer_id = int(unverified["issuer_id"])
            issuer_row = self._get_issuer_row(db, issuer_id, active=True)
            issuer = TokenIssuerKind.model_validate(issuer_row.json)
            key_row = (
                db.query(Kind)
                .filter(
                    Kind.id == issuer.spec.signingKeyRef.kindId,
                    Kind.kind == SIGNING_KEY_KIND,
                    Kind.user_id == SYSTEM_USER_ID,
                    Kind.namespace == SYSTEM_NAMESPACE,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if not key_row:
                raise ValueError("Signing key unavailable")
            key = SigningKeyKind.model_validate(key_row.json)
            claims = jwt.decode(
                access_token,
                key.spec.publicKeyPem,
                algorithms=["RS256"],
                audience=OAUTH_AUDIENCE,
                issuer=issuer.spec.issuer,
            )
            if (
                claims.get("token_use") != "external_userinfo"
                or claims.get("scope") != OAUTH_SCOPE
            ):
                raise ValueError("Token is not valid for userinfo")
            client_row = self._get_client_row(
                db, int(claims["client_kind_id"]), active=True
            )
            client = OAuthClientKind.model_validate(client_row.json)
            if client.spec.clientId != claims.get("client_id"):
                raise ValueError("Client binding is invalid")
            user = db.query(User).filter(User.id == int(claims["user_id"])).first()
            if not user or not user.is_active:
                raise ValueError("User is inactive")
            return OAuthUserInfoResponse(
                id=user.id, user_name=user.user_name, email=user.email
            )
        except (
            jwt.PyJWTError,
            KeyError,
            TypeError,
            ValueError,
            ValidationError,
            OAuthProviderError,
        ) as exc:
            raise OAuthProviderError(
                "invalid_token", "Invalid external access token", 401
            ) from exc

    def authenticate_client(
        self, db: Session, *, client_id: str, client_secret: str | None
    ) -> tuple[Kind, OAuthClientKind]:
        row, client = self._get_active_client_by_public_id(db, client_id)
        if client.spec.clientType == "confidential":
            expected = client.spec.clientSecretHash or ""
            actual = self._hash_secret(client_secret or "")
            if not secrets.compare_digest(expected, actual):
                raise OAuthProviderError(
                    "invalid_client", "Client authentication failed", 401
                )
        return row, client

    def _issue_token_pair(
        self, db: Session, row: Kind, client: OAuthClientKind, user: User
    ) -> OAuthTokenResponse:
        response, _ = self._new_token_pair(
            db, row, client, user, family_id=str(uuid.uuid4())
        )
        db.commit()
        return response

    def _new_token_pair(
        self,
        db: Session,
        row: Kind,
        client: OAuthClientKind,
        user: User,
        *,
        family_id: str,
    ) -> tuple[OAuthTokenResponse, OAuthRefreshToken]:
        self._validate_issuer(
            db,
            client.spec.tokenIssuerRef.kindId,
            enabled=True,
            access_ttl_seconds=client.spec.accessTtlSeconds,
        )
        try:
            issued = outbound_token_service.sign_claims(
                db,
                issuer_id=client.spec.tokenIssuerRef.kindId,
                subject=f"user:{user.id}",
                expires_in=client.spec.accessTtlSeconds,
                claims={
                    "token_use": "external_userinfo",
                    "scope": OAUTH_SCOPE,
                    "client_id": client.spec.clientId,
                    "client_kind_id": row.id,
                    "user_id": user.id,
                },
            )
        except OutboundTokenError as exc:
            raise OAuthProviderError(
                "temporarily_unavailable", "Token issuer is unavailable", 503
            ) from exc
        refresh_token = f"wgrt_{secrets.token_urlsafe(48)}"
        refresh_record = OAuthRefreshToken(
            token_hash=self._hash_secret(refresh_token),
            token_prefix=refresh_token[:16],
            family_id=family_id,
            client_kind_id=row.id,
            user_id=user.id,
            expires_at=self._utcnow()
            + timedelta(seconds=client.spec.refreshTtlSeconds),
        )
        db.add(refresh_record)
        return (
            OAuthTokenResponse(
                access_token=issued.access_token,
                expires_in=issued.expires_in,
                refresh_token=refresh_token,
            ),
            refresh_record,
        )

    def _validate_authorization_request(
        self,
        client_row: Kind,
        *,
        response_type: str,
        redirect_uri: str,
        scope: str,
        code_challenge: str,
        code_challenge_method: str,
    ) -> None:
        client = OAuthClientKind.model_validate(client_row.json)
        if response_type != "code":
            raise OAuthProviderError(
                "unsupported_response_type", "Only response_type=code is supported"
            )
        if redirect_uri not in client.spec.redirectUris:
            raise OAuthProviderError(
                "invalid_request", "redirect_uri is not registered"
            )
        if scope != OAUTH_SCOPE:
            raise OAuthProviderError("invalid_scope", "Only userinfo.read is supported")
        if (
            code_challenge_method != "S256"
            or PKCE_CHALLENGE_PATTERN.fullmatch(code_challenge) is None
        ):
            raise OAuthProviderError(
                "invalid_request", "PKCE S256 code_challenge is required"
            )

    def _validate_issuer(
        self,
        db: Session,
        issuer_id: int,
        *,
        enabled: bool,
        access_ttl_seconds: int,
    ) -> None:
        row = self._get_issuer_row(db, issuer_id, active=enabled)
        issuer = TokenIssuerKind.model_validate(row.json)
        if issuer.spec.audience != OAUTH_AUDIENCE:
            raise OAuthProviderError(
                "invalid_request",
                f"TokenIssuer audience must be '{OAUTH_AUDIENCE}'",
            )
        if access_ttl_seconds > issuer.spec.maxTtlSeconds:
            raise OAuthProviderError(
                "invalid_request",
                "OAuth access token TTL exceeds TokenIssuer maximum",
            )

    def _get_issuer_row(self, db: Session, issuer_id: int, active: bool) -> Kind:
        query = db.query(Kind).filter(
            Kind.id == issuer_id,
            Kind.kind == TOKEN_ISSUER_KIND,
            Kind.user_id == SYSTEM_USER_ID,
            Kind.namespace == SYSTEM_NAMESPACE,
        )
        if active:
            query = query.filter(Kind.is_active == True)  # noqa: E712
        row = query.first()
        if not row:
            raise OAuthProviderError("invalid_request", "TokenIssuer is unavailable")
        return row

    def _get_client_row(
        self, db: Session, client_kind_id: int, active: bool = False
    ) -> Kind:
        query = db.query(Kind).filter(
            Kind.id == client_kind_id,
            Kind.kind == OAUTH_CLIENT_KIND,
            Kind.user_id == SYSTEM_USER_ID,
            Kind.namespace == SYSTEM_NAMESPACE,
        )
        if active:
            query = query.filter(Kind.is_active == True)  # noqa: E712
        row = query.first()
        if not row:
            raise OAuthProviderError("invalid_client", "OAuth client not found", 404)
        resource = OAuthClientKind.model_validate(row.json)
        if active and not resource.spec.enabled:
            raise OAuthProviderError("invalid_client", "OAuth client is disabled", 401)
        return row

    def _get_active_client_by_public_id(
        self, db: Session, client_id: str
    ) -> tuple[Kind, OAuthClientKind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == OAUTH_CLIENT_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )
        for row in rows:
            client = OAuthClientKind.model_validate(row.json)
            if client.spec.enabled and client.spec.clientId == client_id:
                self._validate_issuer(
                    db,
                    client.spec.tokenIssuerRef.kindId,
                    enabled=True,
                    access_ttl_seconds=client.spec.accessTtlSeconds,
                )
                return row, client
        raise OAuthProviderError("invalid_client", "OAuth client is invalid", 401)

    def _to_client_response(
        self, db: Session, row: Kind, client_secret: str | None = None
    ) -> OAuthClientResponse:
        client = OAuthClientKind.model_validate(row.json)
        issuer = self._get_issuer_row(
            db, client.spec.tokenIssuerRef.kindId, active=False
        )
        return OAuthClientResponse(
            id=row.id,
            name=row.name,
            namespace=row.namespace,
            client_id=client.spec.clientId,
            client_type=client.spec.clientType,
            redirect_uris=client.spec.redirectUris,
            token_issuer_id=issuer.id,
            token_issuer_name=issuer.name,
            access_ttl_seconds=client.spec.accessTtlSeconds,
            refresh_ttl_seconds=client.spec.refreshTtlSeconds,
            description=client.spec.description,
            is_active=row.is_active and client.spec.enabled,
            created_at=row.created_at,
            updated_at=row.updated_at,
            client_secret=client_secret,
        )

    def _ensure_unique_name(
        self, db: Session, name: str, exclude_id: int | None = None
    ) -> None:
        query = db.query(Kind).filter(
            Kind.kind == OAUTH_CLIENT_KIND,
            Kind.user_id == SYSTEM_USER_ID,
            Kind.namespace == SYSTEM_NAMESPACE,
            Kind.name == name,
        )
        if exclude_id is not None:
            query = query.filter(Kind.id != exclude_id)
        if query.first():
            raise OAuthProviderError("invalid_request", "OAuth client name exists")

    def _revoke_client_tokens(self, db: Session, client_kind_id: int) -> None:
        now = self._utcnow()
        db.query(OAuthRefreshToken).filter(
            OAuthRefreshToken.client_kind_id == client_kind_id,
            OAuthRefreshToken.revoked_at.is_(None),
        ).update({"revoked_at": now}, synchronize_session=False)

    def _revoke_family(self, db: Session, family_id: str, now: datetime) -> None:
        db.query(OAuthRefreshToken).filter(
            OAuthRefreshToken.family_id == family_id,
            OAuthRefreshToken.revoked_at.is_(None),
        ).update({"revoked_at": now}, synchronize_session=False)

    @staticmethod
    def _hash_secret(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def _verify_pkce(verifier: str, challenge: str) -> bool:
        if PKCE_VERIFIER_PATTERN.fullmatch(verifier) is None:
            return False
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        actual = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        return secrets.compare_digest(actual, challenge)

    @staticmethod
    def _utcnow() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)

    @staticmethod
    def _append_query(url: str, params: dict[str, str]) -> str:
        separator = "&" if "?" in url else "?"
        return f"{url}{separator}{urlencode(params)}"


oauth_provider_service = OAuthProviderService()
