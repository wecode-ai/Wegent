# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the constrained external OAuth provider."""

from datetime import datetime
from typing import Annotated, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, HttpUrl

from app.schemas.kind import ObjectMeta, Status

OAUTH_CLIENT_KIND = "OAuthClient"
OAUTH_AUDIENCE = "wegent-userinfo"
OAUTH_SCOPE = "userinfo.read"
OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS = 2592000

OAuthClientType = Literal["public", "confidential"]


def _validate_redirect_uri(value: HttpUrl) -> HttpUrl:
    if value.fragment is not None:
        raise ValueError("redirect_uri must not contain a fragment")
    return value


OAuthRedirectUri = Annotated[HttpUrl, AfterValidator(_validate_redirect_uri)]


class OAuthTokenIssuerRef(BaseModel):
    kindId: int = Field(..., gt=0)


class OAuthClientSpec(BaseModel):
    clientId: str = Field(..., min_length=8, max_length=100)
    clientType: OAuthClientType
    clientSecretHash: Optional[str] = None
    redirectUris: list[str] = Field(..., min_length=1, max_length=20)
    tokenIssuerRef: OAuthTokenIssuerRef
    accessTtlSeconds: int = Field(
        default=OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        ge=60,
        le=OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    )
    refreshTtlSeconds: int = Field(
        default=OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        ge=3600,
        le=7776000,
    )
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
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=100)
    client_type: OAuthClientType = "public"
    redirect_uris: list[OAuthRedirectUri] = Field(..., min_length=1, max_length=20)
    description: Optional[str] = Field(default=None, max_length=500)


class OAuthClientUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    client_type: Optional[OAuthClientType] = None
    redirect_uris: Optional[list[OAuthRedirectUri]] = Field(
        default=None, min_length=1, max_length=20
    )
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None


class OAuthClientAdminUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class OAuthClientResponse(BaseModel):
    id: int
    name: str
    namespace: str
    owner_user_id: int
    owner_user_name: Optional[str] = None
    client_id: str
    client_type: OAuthClientType
    redirect_uris: list[str]
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
    jwks_uri: str
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
    revocation_endpoint_auth_methods_supported: list[str] = Field(
        default_factory=lambda: [
            "none",
            "client_secret_basic",
            "client_secret_post",
        ]
    )
    authorization_response_iss_parameter_supported: bool = True


class OAuthJwk(BaseModel):
    kty: str = "RSA"
    use: str = "sig"
    alg: str = "RS256"
    kid: str
    n: str
    e: str


class OAuthJwks(BaseModel):
    keys: list[OAuthJwk]
