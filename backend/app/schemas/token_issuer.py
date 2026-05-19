# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for outbound token signing keys and token issuers."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, model_validator

from app.schemas.kind import ObjectMeta, Status


class SigningKeySpec(BaseModel):
    """Kind spec for an outbound-token signing key."""

    algorithm: str = Field(..., description="Signing algorithm, fixed to RS256")
    kid: str = Field(..., min_length=1, max_length=100)
    privateKeyEncrypted: str = Field(..., min_length=1)
    publicKeyPem: str = Field(..., min_length=1)
    description: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_algorithm(self) -> "SigningKeySpec":
        if self.algorithm != "RS256":
            raise ValueError("SigningKey algorithm must be RS256")
        return self


class SigningKeyStatus(Status):
    """Status payload for signing key kinds."""

    state: str = "Available"


class SigningKeyKind(BaseModel):
    """CRD payload for a signing key stored in kinds."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "SigningKey"
    metadata: ObjectMeta
    spec: SigningKeySpec
    status: Optional[SigningKeyStatus] = None


class SigningKeyCreateRequest(BaseModel):
    """Admin request for creating a signing key."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)


class SigningKeyResponse(BaseModel):
    """Admin response for a signing key."""

    id: int
    name: str
    namespace: str
    kid: str
    algorithm: str
    description: str
    public_key_pem: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class SigningKeyListResponse(BaseModel):
    """List response for signing keys."""

    items: List[SigningKeyResponse]
    total: int


class SigningKeyRef(BaseModel):
    """Reference to a SigningKey kind."""

    kindId: int = Field(..., gt=0)


class TokenIssuerSpec(BaseModel):
    """Kind spec for a token issuer."""

    signingKeyRef: SigningKeyRef
    issuer: str = Field(..., min_length=1, max_length=100)
    audience: str = Field(..., min_length=1, max_length=200)
    defaultTtlSeconds: int = Field(..., ge=60, le=86400)
    maxTtlSeconds: int = Field(..., ge=60, le=86400)
    enabled: bool = True
    description: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_ttls(self) -> "TokenIssuerSpec":
        if self.defaultTtlSeconds > self.maxTtlSeconds:
            raise ValueError("defaultTtlSeconds must be <= maxTtlSeconds")
        return self


class TokenIssuerStatus(Status):
    """Status payload for token issuer kinds."""

    state: str = "Available"


class TokenIssuerKind(BaseModel):
    """CRD payload for a token issuer stored in kinds."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "TokenIssuer"
    metadata: ObjectMeta
    spec: TokenIssuerSpec
    status: Optional[TokenIssuerStatus] = None


class TokenIssuerCreateRequest(BaseModel):
    """Admin request for creating a token issuer."""

    name: str = Field(..., min_length=1, max_length=100)
    signing_key_id: int = Field(..., gt=0)
    issuer: str = Field(..., min_length=1, max_length=100)
    audience: str = Field(..., min_length=1, max_length=200)
    default_ttl_seconds: int = Field(..., ge=60, le=86400)
    max_ttl_seconds: int = Field(..., ge=60, le=86400)
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_ttls(self) -> "TokenIssuerCreateRequest":
        if self.default_ttl_seconds > self.max_ttl_seconds:
            raise ValueError("default_ttl_seconds must be <= max_ttl_seconds")
        return self


class TokenIssuerUpdateRequest(BaseModel):
    """Admin request for updating a token issuer."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    signing_key_id: Optional[int] = Field(default=None, gt=0)
    issuer: Optional[str] = Field(default=None, min_length=1, max_length=100)
    audience: Optional[str] = Field(default=None, min_length=1, max_length=200)
    default_ttl_seconds: Optional[int] = Field(default=None, ge=60, le=86400)
    max_ttl_seconds: Optional[int] = Field(default=None, ge=60, le=86400)
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None

    @model_validator(mode="after")
    def validate_ttls(self) -> "TokenIssuerUpdateRequest":
        if (
            self.default_ttl_seconds is not None
            and self.max_ttl_seconds is not None
            and self.default_ttl_seconds > self.max_ttl_seconds
        ):
            raise ValueError("default_ttl_seconds must be <= max_ttl_seconds")
        return self


class TokenIssuerResponse(BaseModel):
    """Admin response for a token issuer."""

    id: int
    name: str
    namespace: str
    issuer: str
    audience: str
    default_ttl_seconds: int
    max_ttl_seconds: int
    description: str
    signing_key_id: int
    signing_key_name: str
    signing_key_kid: str
    public_key_pem: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class TokenIssuerListResponse(BaseModel):
    """List response for token issuers."""

    items: List[TokenIssuerResponse]
    total: int


class TokenIssueRequest(BaseModel):
    """Public issue request."""

    expires_in: Optional[int] = Field(default=None, ge=60, le=86400)


class TokenIssueResponse(BaseModel):
    """Public issue response."""

    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    issuer_id: int
    kid: str
    issued_at: int
    expires_at: int
