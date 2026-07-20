# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for Wegent connector applications."""

from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

AuthType = Literal["none", "bearer", "oauth2"]
Visibility = Literal["all", "roles"]
Transport = Literal["streamable-http", "sse"]
OAuthClientAuthMethod = Literal["client_secret_post", "client_secret_basic", "none"]


def _validate_http_url(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError("URL is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must use http or https and include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain embedded credentials")
    return value


class ConnectorAppWrite(BaseModel):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)
    icon_url: str | None = Field(default=None, max_length=2048)
    enabled: bool = True
    visibility: Visibility = "all"
    allowed_roles: list[str] = Field(default_factory=list)
    auth_type: AuthType = "none"
    transport: Transport = "streamable-http"
    mcp_url: str = Field(min_length=1, max_length=2048)
    oauth_authorization_url: str | None = Field(default=None, max_length=2048)
    oauth_token_url: str | None = Field(default=None, max_length=2048)
    oauth_client_id: str | None = Field(default=None, max_length=512)
    oauth_client_auth_method: OAuthClientAuthMethod = "client_secret_post"
    oauth_client_secret: str | None = Field(default=None, min_length=1, max_length=4096)
    oauth_scopes: list[str] = Field(default_factory=list)
    provider_headers: dict[str, str] = Field(default_factory=dict)
    tool_allowlist: list[str] = Field(default_factory=list)

    @field_validator("mcp_url", "oauth_authorization_url", "oauth_token_url")
    @classmethod
    def validate_http_url(cls, value: str | None) -> str | None:
        return _validate_http_url(value)

    @model_validator(mode="after")
    def validate_auth_configuration(self) -> "ConnectorAppWrite":
        if self.visibility == "roles" and not self.allowed_roles:
            raise ValueError("allowed_roles is required for role visibility")
        if self.auth_type == "oauth2" and not all(
            (
                self.oauth_authorization_url,
                self.oauth_token_url,
                self.oauth_client_id,
            )
        ):
            raise ValueError("OAuth URLs and client ID are required for oauth2")
        if (
            self.auth_type == "oauth2"
            and self.oauth_client_auth_method != "none"
            and not self.oauth_client_secret
        ):
            raise ValueError("OAuth client secret is required for confidential clients")
        return self


class ConnectorAppUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)
    icon_url: str | None = Field(default=None, max_length=2048)
    enabled: bool | None = None
    visibility: Visibility | None = None
    allowed_roles: list[str] | None = None
    auth_type: AuthType | None = None
    transport: Transport | None = None
    mcp_url: str | None = Field(default=None, min_length=1, max_length=2048)
    oauth_authorization_url: str | None = Field(default=None, max_length=2048)
    oauth_token_url: str | None = Field(default=None, max_length=2048)
    oauth_client_id: str | None = Field(default=None, max_length=512)
    oauth_client_auth_method: OAuthClientAuthMethod | None = None
    oauth_client_secret: str | None = Field(default=None, min_length=1, max_length=4096)
    clear_oauth_client_secret: bool = False
    oauth_scopes: list[str] | None = None
    provider_headers: dict[str, str] | None = None
    clear_provider_headers: bool = False
    tool_allowlist: list[str] | None = None

    @field_validator("mcp_url", "oauth_authorization_url", "oauth_token_url")
    @classmethod
    def validate_http_url(cls, value: str | None) -> str | None:
        return _validate_http_url(value)

    @model_validator(mode="after")
    def reject_null_for_required_fields(self) -> "ConnectorAppUpdate":
        required_fields = {
            "name",
            "description",
            "enabled",
            "visibility",
            "allowed_roles",
            "auth_type",
            "transport",
            "mcp_url",
            "oauth_client_auth_method",
            "oauth_scopes",
            "tool_allowlist",
        }
        null_fields = {
            field
            for field in self.model_fields_set & required_fields
            if getattr(self, field) is None
        }
        if null_fields:
            raise ValueError(f"Fields cannot be null: {', '.join(sorted(null_fields))}")
        return self


class ConnectorAppAdminResponse(BaseModel):
    id: int
    slug: str
    name: str
    description: str
    icon_url: str | None
    enabled: bool
    visibility: str
    allowed_roles: list[str]
    auth_type: str
    transport: str
    mcp_url: str
    oauth_authorization_url: str | None
    oauth_token_url: str | None
    oauth_client_id: str | None
    oauth_client_auth_method: str
    oauth_client_secret_configured: bool
    oauth_scopes: list[str]
    provider_header_names: list[str]
    provider_headers_configured: bool
    tool_allowlist: list[str]
    connection_count: int = 0
    created_at: datetime
    updated_at: datetime


class ConnectorConnectionResponse(BaseModel):
    status: Literal["disconnected", "pending", "connected", "expired", "error"]
    external_account_name: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None


class ConnectorAppResponse(BaseModel):
    id: int
    slug: str
    name: str
    description: str
    icon_url: str | None
    auth_type: str
    connection: ConnectorConnectionResponse


class ConnectorAuthorizeResponse(BaseModel):
    authorization_url: str | None = None
    status: Literal["connected", "pending"]


class ConnectorBearerCredentialRequest(BaseModel):
    token: str = Field(min_length=1, max_length=16384)
    account_name: str | None = Field(default=None, max_length=512)


class ConnectorTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class ConnectorTool(BaseModel):
    name: str
    title: str | None = None
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    annotations: dict[str, Any] | None = None
    app_id: int
    app_slug: str
    app_name: str


class ConnectorToolListResponse(BaseModel):
    tools: list[ConnectorTool]


class ConnectorToolCallRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ConnectorToolCallResponse(BaseModel):
    content: Any
    structured_content: dict[str, Any] | None = None
    is_error: bool = False
