# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the constrained external OAuth provider."""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, HttpUrl

from app.schemas.kind import ObjectMeta, Status

OAUTH_CLIENT_KIND = "OAuthClient"
OAUTH_AUDIENCE = "wegent-userinfo"
OAUTH_SCOPE = "userinfo.read"

OAuthClientType = Literal["public", "confidential"]


class OAuthTokenIssuerRef(BaseModel):
    kindId: int = Field(..., gt=0)


class OAuthClientSpec(BaseModel):
    clientId: str = Field(..., min_length=8, max_length=100)
    clientType: OAuthClientType
    clientSecretHash: Optional[str] = None
    redirectUris: list[str] = Field(..., min_length=1, max_length=20)
    tokenIssuerRef: OAuthTokenIssuerRef
    accessTtlSeconds: int = Field(default=600, ge=60, le=3600)
    refreshTtlSeconds: int = Field(default=2592000, ge=3600, le=7776000)
    enabled: bool = True
    description: str = Field(default="", max_length=500)


class OAuthClientStatus(Status):
    state: str = "Available"


class OAuthClientKind(BaseModel):
    apiVersion: str = "agent.wecode.io/v1"
    kind: str = OAUTH_CLIENT_KIND
    metadata: ObjectMeta
    spec: OAuthClientSpec
    status: Optional[OAuthClientStatus] = None


class OAuthClientCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    client_type: OAuthClientType = "confidential"
    redirect_uris: list[HttpUrl] = Field(..., min_length=1, max_length=20)
    token_issuer_id: int = Field(..., gt=0)
    access_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    refresh_ttl_seconds: int = Field(default=2592000, ge=3600, le=7776000)
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: bool = True


class OAuthClientUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    client_type: Optional[OAuthClientType] = None
    redirect_uris: Optional[list[HttpUrl]] = Field(
        default=None, min_length=1, max_length=20
    )
    token_issuer_id: Optional[int] = Field(default=None, gt=0)
    access_ttl_seconds: Optional[int] = Field(default=None, ge=60, le=3600)
    refresh_ttl_seconds: Optional[int] = Field(default=None, ge=3600, le=7776000)
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None


class OAuthClientResponse(BaseModel):
    id: int
    name: str
    namespace: str
    client_id: str
    client_type: OAuthClientType
    redirect_uris: list[str]
    token_issuer_id: int
    token_issuer_name: str
    access_ttl_seconds: int
    refresh_ttl_seconds: int
    description: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    client_secret: Optional[str] = None


class OAuthClientListResponse(BaseModel):
    items: list[OAuthClientResponse]
    total: int


class OAuthAuthorizationRequestResponse(BaseModel):
    request_id: str
    client_name: str
    client_id: str
    scope: str
    redirect_uri: str


class OAuthAuthorizationDecisionResponse(BaseModel):
    redirect_url: str


class OAuthTokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    refresh_token: str
    scope: str = OAUTH_SCOPE


class OAuthUserInfoResponse(BaseModel):
    id: int
    user_name: str
    email: Optional[str] = None


class OAuthProviderMetadata(BaseModel):
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    revocation_endpoint: str
    userinfo_endpoint: str
    response_types_supported: list[str] = Field(default_factory=lambda: ["code"])
    grant_types_supported: list[str] = Field(
        default_factory=lambda: ["authorization_code", "refresh_token"]
    )
    code_challenge_methods_supported: list[str] = Field(
        default_factory=lambda: ["S256"]
    )
    scopes_supported: list[str] = Field(default_factory=lambda: [OAUTH_SCOPE])
    token_endpoint_auth_methods_supported: list[str] = Field(
        default_factory=lambda: [
            "none",
            "client_secret_basic",
            "client_secret_post",
        ]
    )
