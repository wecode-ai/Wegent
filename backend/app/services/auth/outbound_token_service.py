# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Outbound token service backed by the existing kinds table."""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.token_issuer import (
    SigningKeyCreateRequest,
    SigningKeyKind,
    SigningKeyResponse,
    TokenIssuerCreateRequest,
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
        private_key_pem, public_key_pem = self._generate_rsa_keypair()
        kid = self._generate_kid()
        resource = SigningKeyKind(
            metadata={
                "name": payload.name,
                "namespace": SYSTEM_NAMESPACE,
            },
            spec={
                "algorithm": "RS256",
                "kid": kid,
                "privateKeyEncrypted": encrypt_sensitive_data(private_key_pem),
                "publicKeyPem": public_key_pem,
                "description": payload.description or "",
            },
            status={"state": "Available"},
        )
        row = Kind(
            user_id=SYSTEM_USER_ID,
            kind=SIGNING_KEY_KIND,
            name=payload.name,
            namespace=SYSTEM_NAMESPACE,
            json=resource.model_dump(),
            is_active=True,
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
        in_use = (
            db.query(Kind)
            .filter(
                Kind.kind == TOKEN_ISSUER_KIND,
                Kind.user_id == SYSTEM_USER_ID,
                Kind.namespace == SYSTEM_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )
        for issuer in in_use:
            issuer_resource = TokenIssuerKind.model_validate(issuer.json)
            if issuer_resource.spec.signingKeyRef.kindId == key_id:
                raise OutboundTokenValidationError(
                    f"Signing key '{row.name}' is still referenced by token issuer '{issuer.name}'",
                    error_code="SIGNING_KEY_DELETE_BLOCKED_BY_ACTIVE_ISSUER",
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
        resource = TokenIssuerKind(
            metadata={
                "name": payload.name,
                "namespace": SYSTEM_NAMESPACE,
            },
            spec={
                "signingKeyRef": {"kindId": payload.signing_key_id},
                "issuer": payload.issuer,
                "audience": payload.audience,
                "defaultTtlSeconds": payload.default_ttl_seconds,
                "maxTtlSeconds": payload.max_ttl_seconds,
                "enabled": payload.enabled,
                "description": payload.description or "",
            },
            status={"state": "Available" if payload.enabled else "Disabled"},
        )
        row = Kind(
            user_id=SYSTEM_USER_ID,
            kind=TOKEN_ISSUER_KIND,
            name=payload.name,
            namespace=SYSTEM_NAMESPACE,
            json=resource.model_dump(),
            is_active=payload.enabled,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._to_token_issuer_response(db, row)

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
            if (payload.enabled is True or row.is_active) and not signing_key.is_active:
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
        db.delete(row)
        db.commit()

    def issue_token(
        self,
        db: Session,
        issuer_id: int,
        user: User,
        expires_in: Optional[int] = None,
    ) -> TokenIssueResponse:
        issuer_row = self._get_kind_or_raise(
            db, TOKEN_ISSUER_KIND, issuer_id, TokenIssuerNotFoundError
        )
        issuer = TokenIssuerKind.model_validate(issuer_row.json)
        if not issuer.spec.enabled or not issuer_row.is_active:
            raise OutboundTokenValidationError("Token issuer is disabled")

        ttl = expires_in or issuer.spec.defaultTtlSeconds
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
