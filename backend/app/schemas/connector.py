# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for Wegent connector applications."""

import re
from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator, SchemaError
from pydantic import BaseModel, Field, field_validator, model_validator

AuthType = Literal["none"]
Visibility = Literal["all", "roles"]
Transport = Literal["streamable-http", "sse", "http"]
OAuthClientAuthMethod = Literal["client_secret_post", "client_secret_basic", "none"]
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
HttpArgumentLocation = Literal["path", "query", "body"]


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


class ConnectorHttpToolDefinition(BaseModel):
    """One HTTP operation exposed as an MCP tool by Connector Runtime."""

    name: str = Field(
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$",
    )
    description: str = Field(default="", max_length=10000)
    method: HttpMethod = "POST"
    path: str = Field(min_length=1, max_length=2048)
    input_schema: dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    argument_locations: dict[str, HttpArgumentLocation] = Field(default_factory=dict)
    timeout_seconds: int = Field(default=30, ge=1, le=120)

    @field_validator("path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme
            or parsed.netloc
            or parsed.query
            or parsed.fragment
            or not value.startswith("/")
        ):
            raise ValueError("HTTP tool path must be an absolute-path reference")
        return value

    @field_validator("input_schema")
    @classmethod
    def validate_input_schema(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("type", "object") != "object":
            raise ValueError("HTTP tool input_schema must describe an object")
        properties = value.get("properties", {})
        if not isinstance(properties, dict):
            raise ValueError("HTTP tool input_schema properties must be an object")
        try:
            Draft202012Validator.check_schema(value)
        except SchemaError as exc:
            raise ValueError(
                "HTTP tool input_schema must be valid JSON Schema"
            ) from exc
        return value

    @model_validator(mode="after")
    def validate_argument_locations(self) -> "ConnectorHttpToolDefinition":
        properties = self.input_schema.get("properties", {})
        unknown = set(self.argument_locations) - set(properties)
        if unknown:
            raise ValueError(
                "argument_locations must reference input_schema properties: "
                + ", ".join(sorted(unknown))
            )
        path_arguments = {
            name
            for name, location in self.argument_locations.items()
            if location == "path"
        }
        missing_placeholders = {
            name for name in path_arguments if "{" + name + "}" not in self.path
        }
        if missing_placeholders:
            raise ValueError(
                "path arguments require matching placeholders: "
                + ", ".join(sorted(missing_placeholders))
            )
        placeholders = set(re.findall(r"\{([A-Za-z0-9_.-]+)\}", self.path))
        required = set(self.input_schema.get("required", []))
        invalid_placeholders = placeholders - set(properties)
        optional_placeholders = placeholders - required
        if invalid_placeholders or optional_placeholders:
            raise ValueError(
                "path placeholders must be required input_schema properties"
            )
        return self


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
    http_tools: list[ConnectorHttpToolDefinition] = Field(
        default_factory=list, max_length=100
    )

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
        if self.transport == "http" and not self.http_tools:
            raise ValueError("http_tools is required for HTTP connectors")
        if self.transport != "http" and self.http_tools:
            raise ValueError("http_tools is only supported by HTTP connectors")
        names = [tool.name for tool in self.http_tools]
        if len(names) != len(set(names)):
            raise ValueError("HTTP tool names must be unique")
        if self.transport == "http" and set(self.tool_allowlist) - set(names):
            raise ValueError("tool_allowlist must reference configured HTTP tools")
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
    http_tools: list[ConnectorHttpToolDefinition] | None = Field(
        default=None, max_length=100
    )

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
            "http_tools",
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
    http_tools: list[ConnectorHttpToolDefinition]
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


class ConnectorAppListItem(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    logo_url: str | None = None
    install_url: str | None = None
    auth_type: str
    is_accessible: bool
    is_enabled: bool
    callable: bool = False
    runtime_name: str | None = None
    connection: ConnectorConnectionResponse


class ConnectorAppListResponse(BaseModel):
    data: list[ConnectorAppListItem]
    next_cursor: str | None = None


class ConnectorAppReadRequest(BaseModel):
    app_ids: list[str] = Field(default_factory=list, max_length=100)
    include_tools: bool = False


class ConnectorToolSummary(BaseModel):
    name: str
    title: str | None = None
    description: str = ""
    raw_tool_name: str | None = None


class ConnectorAppReadItem(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    icon_url: str | None = None
    auth_type: str
    tool_summaries: list[ConnectorToolSummary] = Field(default_factory=list)


class ConnectorAppReadResponse(BaseModel):
    apps: list[ConnectorAppReadItem]
    missing_app_ids: list[str] = Field(default_factory=list)


class ConnectorInstalledApp(BaseModel):
    id: str
    slug: str
    name: str
    description: str = ""
    icon_url: str | None = None
    runtime_name: str | None = None
    enabled: bool
    callable: bool
    connection: ConnectorConnectionResponse
    tool_summaries: list[ConnectorToolSummary] = Field(default_factory=list)


class ConnectorInstalledResponse(BaseModel):
    apps: list[ConnectorInstalledApp]


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
    connector_id: str
    connector_slug: str
    connector_name: str
    raw_tool_name: str
    model_visible: bool = True
    risk_hints: dict[str, Any] = Field(default_factory=dict)
    source_transport: str
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
