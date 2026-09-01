# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Outbound token service backed by the existing kinds table."""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.oauth_provider import (
    OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    OAUTH_AUDIENCE,
    OAUTH_CLIENT_KIND,
)
from app.schemas.token_issuer import (
    SigningKeyCreateRequest,
    SigningKeyKind,
    SigningKeyResponse,
    TokenIssuerCreateRequest,
    TokenIssueRequest,
    TokenIssueResponse,
    TokenIssuerKind,
    TokenIssuerResponse,
    TokenIssuerStatus,
    TokenIssuerUpdateRequest,
)
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

logger = logging.getLogger(__name__)

SYSTEM_NAMESPACE = "system"
SYSTEM_USER_ID = 0
SIGNING_KEY_KIND = "SigningKey"
TOKEN_ISSUER_KIND = "TokenIssuer"


class OutboundTokenError(Exception):
    """Base exception for outbound-token errors."""


class SigningKeyNotFoundError(OutboundTokenError):
    """Signing key not found."""


class TokenIssuerNotFoundError(OutboundTokenError):
    """Token issuer not found."""


class OutboundTokenValidationError(OutboundTokenError):
    """Outbound-token validation error."""

    def __init__(self, message: str, error_code: str | None = None):
        super().__init__(message)
        self.error_code = error_code


@dataclass
class _ResolvedSigningKey:
    """Decrypted signing key used for issuance."""

    kind: Kind
    resource: SigningKeyKind
    private_key_pem: str


class OutboundTokenService:
    """Service for managing outbound token signing keys and issuers."""

    def list_signing_keys(self, db: Session) -> list[SigningKeyResponse]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == SIGNING_KEY_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return [self._to_signing_key_response(row) for row in rows]

    def create_signing_key(
        self, db: Session, payload: SigningKeyCreateRequest
    ) -> SigningKeyResponse:
        self._ensure_unique_name(db, SIGNING_KEY_KIND, payload.name)
        row = self._build_signing_key_row(
            name=payload.name,
            description=payload.description or "",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._to_signing_key_response(row)

    def toggle_signing_key_status(self, db: Session, key_id: int) -> SigningKeyResponse:
        row = self._get_kind_or_raise(
            db, SIGNING_KEY_KIND, key_id, SigningKeyNotFoundError
        )
        if row.is_active:
            active_issuers = (
                db.query(Kind)
                .filter(
                    Kind.kind == TOKEN_ISSUER_KIND,
                    Kind.user_id == SYSTEM_USER_ID,
                    Kind.namespace == SYSTEM_NAMESPACE,
                    Kind.is_active == True,  # noqa: E712
                )
                .all()
            )
            for issuer_row in active_issuers:
                issuer_resource = TokenIssuerKind.model_validate(issuer_row.json)
                if issuer_resource.spec.signingKeyRef.kindId == key_id:
                    raise OutboundTokenValidationError(
                        "Disable dependent token issuers before disabling this signing key",
                        error_code="SIGNING_KEY_DISABLE_BLOCKED_BY_ACTIVE_ISSUER",
                    )
        row.is_active = not row.is_active
        self._set_resource_state(
            row,
            "Available" if row.is_active else "Disabled",
        )
        db.commit()
        db.refresh(row)
        return self._to_signing_key_response(row)

    def delete_signing_key(self, db: Session, key_id: int) -> None:
        row = self._get_kind_or_raise(
            db, SIGNING_KEY_KIND, key_id, SigningKeyNotFoundError
        )
        referenced_issuers = (
            db.query(Kind)
            .filter(
                Kind.kind == TOKEN_ISSUER_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .all()
        )
        for issuer in referenced_issuers:
            issuer_resource = TokenIssuerKind.model_validate(issuer.json)
            if issuer_resource.spec.signingKeyRef.kindId == key_id:
                raise OutboundTokenValidationError(
                    f"Signing key '{row.name}' is still referenced by token issuer '{issuer.name}'",
                    error_code="SIGNING_KEY_DELETE_BLOCKED_BY_ISSUER",
                )
        db.delete(row)
        db.commit()

    def list_token_issuers(self, db: Session) -> list[TokenIssuerResponse]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == TOKEN_ISSUER_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return [self._to_token_issuer_response(db, row) for row in rows]

    def create_token_issuer(
        self, db: Session, payload: TokenIssuerCreateRequest
    ) -> TokenIssuerResponse:
        self._ensure_unique_name(db, TOKEN_ISSUER_KIND, payload.name)
        signing_key = self._get_kind_or_raise(
            db, SIGNING_KEY_KIND, payload.signing_key_id, SigningKeyNotFoundError
        )
        if payload.enabled and not signing_key.is_active:
            raise OutboundTokenValidationError(
                "Cannot enable token issuer with a disabled signing key",
                error_code="TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY",
            )
        row = self._build_token_issuer_row(
            name=payload.name,
            signing_key_id=payload.signing_key_id,
            issuer=payload.issuer,
            audience=payload.audience,
            default_ttl_seconds=payload.default_ttl_seconds,
            max_ttl_seconds=payload.max_ttl_seconds,
            enabled=payload.enabled,
            description=payload.description or "",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._to_token_issuer_response(db, row)

    def ensure_oauth_provider_token_issuer(
        self,
        db: Session,
        *,
        issuer: str,
        audience: str,
    ) -> int:
        issuer_rows = (
            db.query(Kind)
            .filter(
                Kind.kind == TOKEN_ISSUER_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .order_by(Kind.created_at.asc())
            .all()
        )
        for issuer_row in issuer_rows:
            resource = TokenIssuerKind.model_validate(issuer_row.json)
            if (
                not resource.spec.enabled
                or resource.spec.issuer != issuer
                or resource.spec.audience != audience
            ):
                continue
            signing_key = (
                db.query(Kind)
                .filter(
                    Kind.id == resource.spec.signingKeyRef.kindId,
                    Kind.kind == SIGNING_KEY_KIND,
                    Kind.user_id == SYSTEM_USER_ID,
                    Kind.namespace == SYSTEM_NAMESPACE,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if signing_key:
                if resource.spec.maxTtlSeconds < OAUTH_ACCESS_TOKEN_TTL_SECONDS:
                    resource.spec.maxTtlSeconds = OAUTH_ACCESS_TOKEN_TTL_SECONDS
                    issuer_row.json = resource.model_dump()
                    db.flush()
                return issuer_row.id

        suffix = uuid.uuid4().hex[:8]
        signing_key = self._build_signing_key_row(
            name=f"oauth-provider-key-{suffix}",
            description="Managed automatically for the external OAuth provider",
        )
        db.add(signing_key)
        db.flush()
        token_issuer = self._build_token_issuer_row(
            name=f"oauth-provider-issuer-{suffix}",
            signing_key_id=signing_key.id,
            issuer=issuer,
            audience=audience,
            default_ttl_seconds=OAUTH_ACCESS_TOKEN_TTL_SECONDS,
            max_ttl_seconds=OAUTH_ACCESS_TOKEN_TTL_SECONDS,
            enabled=True,
            description="Managed automatically for the external OAuth provider",
        )
        db.add(token_issuer)
        db.flush()
        return token_issuer.id

    def update_token_issuer(
        self, db: Session, issuer_id: int, payload: TokenIssuerUpdateRequest
    ) -> TokenIssuerResponse:
        row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        resource = TokenIssuerKind.model_validate(row.json)
        if payload.name and payload.name != row.name:
            self._ensure_unique_name(
                db, TOKEN_ISSUER_KIND, payload.name, exclude_id=issuer_id
            )
            row.name = payload.name
            resource.metadata.name = payload.name

        if payload.signing_key_id is not None:
            signing_key = self._get_kind_or_raise(
                db, SIGNING_KEY_KIND, payload.signing_key_id, SigningKeyNotFoundError
            )
            effective_enabled = (
                payload.enabled if payload.enabled is not None else row.is_active
            )
            if effective_enabled and not signing_key.is_active:
                raise OutboundTokenValidationError(
                    "Cannot use a disabled signing key for an enabled token issuer",
                    error_code="TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY",
                )
            resource.spec.signingKeyRef.kindId = payload.signing_key_id
        if payload.issuer is not None:
            resource.spec.issuer = payload.issuer
        if payload.audience is not None:
            resource.spec.audience = payload.audience
        default_ttl = (
            payload.default_ttl_seconds
            if payload.default_ttl_seconds is not None
            else resource.spec.defaultTtlSeconds
        )
        max_ttl = (
            payload.max_ttl_seconds
            if payload.max_ttl_seconds is not None
            else resource.spec.maxTtlSeconds
        )
        if default_ttl > max_ttl:
            raise OutboundTokenValidationError(
                "default_ttl_seconds must be <= max_ttl_seconds"
            )
        self._validate_oauth_client_issuer_policy(
            db,
            issuer_id=issuer_id,
            audience=payload.audience or resource.spec.audience,
            max_ttl_seconds=max_ttl,
        )
        resource.spec.defaultTtlSeconds = default_ttl
        resource.spec.maxTtlSeconds = max_ttl
        if payload.description is not None:
            resource.spec.description = payload.description
        if payload.enabled is not None:
            signing_key = self._get_kind_or_raise(
                db,
                SIGNING_KEY_KIND,
                resource.spec.signingKeyRef.kindId,
                SigningKeyNotFoundError,
            )
            if payload.enabled and not signing_key.is_active:
                raise OutboundTokenValidationError(
                    "Cannot enable token issuer with a disabled signing key",
                    error_code="TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY",
                )
            resource.spec.enabled = payload.enabled
            row.is_active = payload.enabled
            if resource.status is None:
                resource.status = TokenIssuerStatus()
            resource.status.state = "Available" if payload.enabled else "Disabled"

        row.json = resource.model_dump()
        if payload.enabled is not None:
            row.is_active = payload.enabled
        db.commit()
        db.refresh(row)
        return self._to_token_issuer_response(db, row)

    def toggle_token_issuer_status(
        self, db: Session, issuer_id: int
    ) -> TokenIssuerResponse:
        row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        resource = TokenIssuerKind.model_validate(row.json)
        if not resource.spec.enabled:
            signing_key = self._get_kind_or_raise(
                db,
                SIGNING_KEY_KIND,
                resource.spec.signingKeyRef.kindId,
                SigningKeyNotFoundError,
            )
            if not signing_key.is_active:
                raise OutboundTokenValidationError(
                    "Cannot enable token issuer with a disabled signing key",
                    error_code="TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY",
                )
        resource.spec.enabled = not resource.spec.enabled
        row.is_active = resource.spec.enabled
        if resource.status is None:
            resource.status = TokenIssuerStatus()
        resource.status.state = "Available" if row.is_active else "Disabled"
        row.json = resource.model_dump()
        db.commit()
        db.refresh(row)
        return self._to_token_issuer_response(db, row)

    def delete_token_issuer(self, db: Session, issuer_id: int) -> None:
        row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        referenced_clients = self._get_oauth_client_references(db, issuer_id)
        if referenced_clients:
            names = ", ".join(client.name for client in referenced_clients[:3])
            raise OutboundTokenValidationError(
                f"Token issuer '{row.name}' is still referenced by OAuth client(s): {names}",
                error_code="TOKEN_ISSUER_DELETE_BLOCKED_BY_OAUTH_CLIENT",
            )
        db.delete(row)
        db.commit()

    def _validate_oauth_client_issuer_policy(
        self,
        db: Session,
        *,
        issuer_id: int,
        audience: str,
        max_ttl_seconds: int,
    ) -> None:
        clients = self._get_oauth_client_references(db, issuer_id)
        if not clients:
            return
        if audience != OAUTH_AUDIENCE:
            raise OutboundTokenValidationError(
                f"OAuth client TokenIssuer audience must remain '{OAUTH_AUDIENCE}'",
                error_code="TOKEN_ISSUER_AUDIENCE_REQUIRED_BY_OAUTH_CLIENT",
            )
        client_ttls: list[int] = []
        for client in clients:
            spec = client.json.get("spec") if isinstance(client.json, dict) else None
            access_ttl = (
                spec.get("accessTtlSeconds") if isinstance(spec, dict) else None
            )
            if (
                isinstance(access_ttl, bool)
                or not isinstance(access_ttl, int)
                or access_ttl < 60
                or access_ttl > OAUTH_ACCESS_TOKEN_TTL_SECONDS
            ):
                raise OutboundTokenValidationError(
                    f"OAuth client '{client.name}' has an invalid access TTL",
                    error_code="OAUTH_CLIENT_INVALID_ACCESS_TTL",
                )
            client_ttls.append(access_ttl)
        largest_client_ttl = max(client_ttls)
        if max_ttl_seconds < largest_client_ttl:
            raise OutboundTokenValidationError(
                "TokenIssuer maximum TTL cannot be lower than a referenced OAuth client TTL",
                error_code="TOKEN_ISSUER_MAX_TTL_REQUIRED_BY_OAUTH_CLIENT",
            )

    def _get_oauth_client_references(self, db: Session, issuer_id: int) -> list[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == OAUTH_CLIENT_KIND,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .all()
        )
        return [
            row
            for row in rows
            if row.json.get("spec", {}).get("tokenIssuerRef", {}).get("kindId")
            == issuer_id
        ]

    def issue_token(
        self,
        db: Session,
        issuer_id: int,
        user: User,
        expires_in: Optional[int] = None,
        request: Optional[TokenIssueRequest] = None,
    ) -> TokenIssueResponse:
        issuer_row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        issuer = TokenIssuerKind.model_validate(issuer_row.json)
        if not issuer.spec.enabled or not issuer_row.is_active:
            raise OutboundTokenValidationError("Token issuer is disabled")

        effective_expires_in = expires_in
        if request is not None and request.expires_in is not None:
            effective_expires_in = request.expires_in
        ttl = (
            issuer.spec.defaultTtlSeconds
            if effective_expires_in is None
            else effective_expires_in
        )
        if ttl <= 0:
            raise OutboundTokenValidationError("Requested TTL must be positive")
        if ttl > issuer.spec.maxTtlSeconds:
            raise OutboundTokenValidationError("Requested TTL exceeds issuer policy")

        signing_key = self._resolve_signing_key_for_issuance(
            db, issuer.spec.signingKeyRef.kindId
        )
        issued_at = datetime.now(timezone.utc)
        expires_at = issued_at + timedelta(seconds=ttl)
        claims = {
            "iss": issuer.spec.issuer,
            "sub": f"user:{user.id}",
            "aud": issuer.spec.audience,
            "iat": int(issued_at.timestamp()),
            "exp": int(expires_at.timestamp()),
            "jti": str(uuid.uuid4()),
            "user_id": user.id,
            "user_name": user.user_name,
            "issuer_id": issuer_row.id,
        }
        extra_claims = self._collect_extra_claims(
            db, user=user, issuer=issuer, request=request
        )
        for key, value in extra_claims.items():
            if key not in claims:  # standard reserved claims are never overridden
                claims[key] = value
        token = jwt.encode(
            claims,
            signing_key.private_key_pem,
            algorithm="RS256",
            headers={"kid": signing_key.resource.spec.kid},
        )
        logger.info(
            "Issued outbound token issuer_id=%s kid=%s aud=%s user_id=%s user_name=%s exp=%s",
            issuer_row.id,
            signing_key.resource.spec.kid,
            issuer.spec.audience,
            user.id,
            user.user_name,
            claims["exp"],
        )
        return TokenIssueResponse(
            access_token=token,
            expires_in=ttl,
            issuer_id=issuer_row.id,
            kid=signing_key.resource.spec.kid,
            issued_at=claims["iat"],
            expires_at=claims["exp"],
        )

    def sign_claims(
        self,
        db: Session,
        *,
        issuer_id: int,
        subject: str,
        expires_in: int,
        claims: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> TokenIssueResponse:
        """Sign constrained deployment claims with an existing TokenIssuer."""
        issuer_row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        issuer = TokenIssuerKind.model_validate(issuer_row.json)
        if not issuer.spec.enabled or not issuer_row.is_active:
            raise OutboundTokenValidationError("Token issuer is disabled")
        if expires_in <= 0 or expires_in > issuer.spec.maxTtlSeconds:
            raise OutboundTokenValidationError("Requested TTL exceeds issuer policy")

        signing_key = self._resolve_signing_key_for_issuance(
            db, issuer.spec.signingKeyRef.kindId
        )
        issued_at = datetime.now(timezone.utc)
        expires_at = issued_at + timedelta(seconds=expires_in)
        reserved = {
            "iss": issuer.spec.issuer,
            "sub": subject,
            "aud": issuer.spec.audience,
            "iat": int(issued_at.timestamp()),
            "exp": int(expires_at.timestamp()),
            "jti": str(uuid.uuid4()),
            "issuer_id": issuer_row.id,
        }
        reserved.update(
            {key: value for key, value in claims.items() if key not in reserved}
        )
        token = jwt.encode(
            reserved,
            signing_key.private_key_pem,
            algorithm="RS256",
            headers={
                **(headers or {}),
                "alg": signing_key.resource.spec.algorithm,
                "kid": signing_key.resource.spec.kid,
            },
        )
        return TokenIssueResponse(
            access_token=token,
            expires_in=expires_in,
            issuer_id=issuer_row.id,
            kid=signing_key.resource.spec.kid,
            issued_at=reserved["iat"],
            expires_at=reserved["exp"],
        )

    def _collect_extra_claims(
        self,
        db: Session,
        *,
        user: User,
        issuer: TokenIssuerKind,
        request: Optional[TokenIssueRequest] = None,
    ) -> dict:
        """Extension point for deployment-specific extra JWT claims.

        Open-source core contributes none. Deployments may patch this to
        inject additional claims (e.g. an employee id). The caller merges the
        returned mapping into the token but never lets it override standard
        reserved claims.
        """
        return {}

    def _to_signing_key_response(self, row: Kind) -> SigningKeyResponse:
        resource = SigningKeyKind.model_validate(row.json)
        return SigningKeyResponse(
            id=row.id,
            name=row.name,
            namespace=row.namespace,
            kid=resource.spec.kid,
            algorithm=resource.spec.algorithm,
            description=resource.spec.description,
            public_key_pem=resource.spec.publicKeyPem,
            is_active=row.is_active,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    def _to_token_issuer_response(self, db: Session, row: Kind) -> TokenIssuerResponse:
        resource = TokenIssuerKind.model_validate(row.json)
        signing_key = self._get_kind_or_raise(
            db,
            SIGNING_KEY_KIND,
            resource.spec.signingKeyRef.kindId,
            SigningKeyNotFoundError,
        )
        signing_key_resource = SigningKeyKind.model_validate(signing_key.json)
        return TokenIssuerResponse(
            id=row.id,
            name=row.name,
            namespace=row.namespace,
            issuer=resource.spec.issuer,
            audience=resource.spec.audience,
            default_ttl_seconds=resource.spec.defaultTtlSeconds,
            max_ttl_seconds=resource.spec.maxTtlSeconds,
            description=resource.spec.description,
            signing_key_id=signing_key.id,
            signing_key_name=signing_key.name,
            signing_key_kid=signing_key_resource.spec.kid,
            public_key_pem=signing_key_resource.spec.publicKeyPem,
            is_active=row.is_active and resource.spec.enabled,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    def _build_signing_key_row(self, *, name: str, description: str) -> Kind:
        private_key_pem, public_key_pem = self._generate_rsa_keypair()
        resource = SigningKeyKind(
            metadata={"name": name, "namespace": SYSTEM_NAMESPACE},
            spec={
                "algorithm": "RS256",
                "kid": self._generate_kid(),
                "privateKeyEncrypted": encrypt_sensitive_data(private_key_pem),
                "publicKeyPem": public_key_pem,
                "description": description,
            },
            status={"state": "Available"},
        )
        return Kind(
            user_id=SYSTEM_USER_ID,
            kind=SIGNING_KEY_KIND,
            name=name,
            namespace=SYSTEM_NAMESPACE,
            json=resource.model_dump(),
            is_active=True,
        )

    @staticmethod
    def _build_token_issuer_row(
        *,
        name: str,
        signing_key_id: int,
        issuer: str,
        audience: str,
        default_ttl_seconds: int,
        max_ttl_seconds: int,
        enabled: bool,
        description: str,
    ) -> Kind:
        resource = TokenIssuerKind(
            metadata={"name": name, "namespace": SYSTEM_NAMESPACE},
            spec={
                "signingKeyRef": {"kindId": signing_key_id},
                "issuer": issuer,
                "audience": audience,
                "defaultTtlSeconds": default_ttl_seconds,
                "maxTtlSeconds": max_ttl_seconds,
                "enabled": enabled,
                "description": description,
            },
            status={"state": "Available" if enabled else "Disabled"},
        )
        return Kind(
            user_id=SYSTEM_USER_ID,
            kind=TOKEN_ISSUER_KIND,
            name=name,
            namespace=SYSTEM_NAMESPACE,
            json=resource.model_dump(),
            is_active=enabled,
        )

    def _resolve_signing_key_for_issuance(
        self, db: Session, key_id: int
    ) -> _ResolvedSigningKey:
        row = self._get_kind_or_raise(
            db, SIGNING_KEY_KIND, key_id, SigningKeyNotFoundError
        )
        if not row.is_active:
            raise OutboundTokenValidationError("Signing key is disabled")
        resource = SigningKeyKind.model_validate(row.json)
        private_key_pem = decrypt_sensitive_data(resource.spec.privateKeyEncrypted)
        if not private_key_pem:
            raise OutboundTokenValidationError("Signing key private key is unavailable")
        return _ResolvedSigningKey(
            kind=row,
            resource=resource,
            private_key_pem=private_key_pem,
        )

    def _get_kind_or_raise(
        self,
        db: Session,
        kind: str,
        resource_id: int,
        exc_type: type[OutboundTokenError],
    ) -> Kind:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == kind,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
            )
            .first()
        )
        if not row:
            raise exc_type(f"{kind} '{resource_id}' not found")
        return row

    def _ensure_unique_name(
        self,
        db: Session,
        kind: str,
        name: str,
        exclude_id: Optional[int] = None,
    ) -> None:
        query = db.query(Kind).filter(
            Kind.kind == kind,
            Kind.user_id == SYSTEM_USER_ID,
            Kind.namespace == SYSTEM_NAMESPACE,
            Kind.name == name,
        )
        if exclude_id is not None:
            query = query.filter(Kind.id != exclude_id)
        if query.first():
            raise OutboundTokenValidationError(f"{kind} '{name}' already exists")

    @staticmethod
    def _generate_rsa_keypair() -> tuple[str, str]:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")
        public_key_pem = (
            private_key.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("utf-8")
        )
        return private_key_pem, public_key_pem

    @staticmethod
    def _generate_kid() -> str:
        return f"key-{datetime.now(timezone.utc):%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"

    @staticmethod
    def _set_resource_state(
        row: Kind,
        state: str,
        *,
        mutate_json: bool = True,
    ) -> None:
        resource_json = row.json if mutate_json else dict(row.json)
        resource_json.setdefault("status", {})
        resource_json["status"]["state"] = state
        row.json = resource_json


outbound_token_service = OutboundTokenService()
