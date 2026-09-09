"""Versioned contracts for account-owned plugin credentials."""

import re
from pathlib import PurePosixPath
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer,
    model_validator,
)

CredentialType = Literal["password", "bearer", "oauth2"]


class PluginAuthLocalDirectory(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["directory"]


class PluginAuthLocalEnum(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["enum"]
    values: list[str] = Field(min_length=1, max_length=16)

    @field_validator("values")
    @classmethod
    def validate_values(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or any(
            not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value) for value in values
        ):
            raise ValueError("Local configuration requires distinct public enum values")
        return values


class PluginAccountAuthDefinition(BaseModel):
    """A declaration of adapter support, never a grant to read credentials."""

    model_config = ConfigDict(extra="forbid", strict=True)

    protocolVersion: Literal[1] = 1
    credentialType: CredentialType
    adapter: str = Field(min_length=1, max_length=256)
    oauth2: list[Literal["authorize", "refresh", "revoke"]] | None = None
    exportMode: Literal["exclusive"] | None = None
    localEnvironment: (
        dict[str, PluginAuthLocalDirectory | PluginAuthLocalEnum] | None
    ) = Field(default=None, min_length=1, max_length=16)

    @field_validator("localEnvironment")
    @classmethod
    def validate_local_environment(
        cls, value: dict[str, PluginAuthLocalDirectory | PluginAuthLocalEnum] | None
    ) -> dict[str, PluginAuthLocalDirectory | PluginAuthLocalEnum] | None:
        if value is not None and any(
            not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", name) for name in value
        ):
            raise ValueError("Local configuration requires uppercase environment names")
        return value

    @model_serializer(mode="wrap")
    def serialize_definition(self, handler: SerializerFunctionWrapHandler) -> dict:
        result = handler(self)
        if self.oauth2 is None:
            result.pop("oauth2", None)
        if self.exportMode is None:
            result.pop("exportMode", None)
        if self.localEnvironment is None:
            result.pop("localEnvironment", None)
        return result

    @model_validator(mode="after")
    def validate_oauth_operations(self) -> "PluginAccountAuthDefinition":
        if self.exportMode is not None and self.credentialType != "oauth2":
            raise ValueError("Exclusive export requires OAuth credentials")
        if self.oauth2 is not None and (
            self.credentialType != "oauth2"
            or not self.oauth2
            or len(set(self.oauth2)) != len(self.oauth2)
        ):
            raise ValueError(
                "OAuth operations must be distinct and require OAuth credentials"
            )
        return self

    @field_validator("protocolVersion", mode="before")
    @classmethod
    def validate_protocol_version(cls, value: object) -> int:
        if type(value) is not int or value != 1:
            raise ValueError("Unsupported account auth protocol version")
        return value

    @field_validator("adapter")
    @classmethod
    def validate_adapter(cls, value: str) -> str:
        parts = PurePosixPath(value).parts
        if (
            value.startswith(("/", "~"))
            or "\\" in value
            or ":" in value
            or ".." in parts
            or not re.fullmatch(r"[A-Za-z0-9_./-]+", value)
            or not value.endswith((".py", ".mjs", ".sh", ".ps1"))
        ):
            raise ValueError("Account auth adapter must be a relative script path")
        return value


class PluginCredentialWrite(BaseModel):
    """Internal enrollment input; never returned by a model-visible tool."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    installed_plugin_id: int = Field(gt=0)
    connector_slug: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$")
    account_id: str = Field(min_length=1, max_length=256)
    account_label: str = Field(default="", max_length=256)
    credential: SecretStr = Field(repr=False)
    expected_revision: int = Field(ge=0)

    @field_validator("credential")
    @classmethod
    def limit_credential_size(cls, value: SecretStr) -> SecretStr:
        if not 1 <= len(value.get_secret_value().encode("utf-8")) <= 65536:
            raise ValueError("Credential payload must contain 1 to 65536 bytes")
        return value


class PluginDeviceGrantWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=256)
    expected_revision: int = Field(ge=1)


class PluginConnectionRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)


class PluginDisconnectRequest(PluginConnectionRevision):
    device_id: str | None = Field(default=None, min_length=1, max_length=256)


class PluginProviderRevocationConfirmation(PluginConnectionRevision):
    confirmed: Literal[True]


class PluginAccountConnectionResponse(BaseModel):
    """Public metadata intentionally excludes ciphertext and device secrets."""

    id: str
    installed_plugin_id: int
    plugin_key: str
    connector_slug: str
    account_id: str
    account_label: str
    credential_type: CredentialType
    status: Literal["connected", "disconnected"]
    revision: int
    device_ids: list[str]
    provider_revocation: (
        Literal["pending", "revoked", "attention", "unsupported", "confirmed"] | None
    ) = None

    @model_serializer(mode="wrap")
    def serialize_metadata(self, handler: SerializerFunctionWrapHandler) -> dict:
        result = handler(self)
        if self.provider_revocation is None:
            result.pop("provider_revocation", None)
        return result


class PluginMigrationCreate(BaseModel):
    """Explicit user intent, containing no provider credential."""

    model_config = ConfigDict(extra="forbid", strict=True)
    installed_plugin_id: int = Field(gt=0)
    connector_slug: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$")
    device_id: str = Field(min_length=1, max_length=256)
    expected_revision: int = Field(ge=0)
    expected_account_id: str | None = Field(default=None, min_length=1, max_length=256)
    operation: Literal["export", "authorize"] = "export"

    @model_validator(mode="after")
    def require_update_account(self) -> "PluginMigrationCreate":
        if (self.expected_revision > 0) != (self.expected_account_id is not None):
            raise ValueError("Updating authentication requires the selected account")
        return self


class PluginMigrationResponse(BaseModel):
    id: str
    expires_at: int


class PluginNativeEnrollment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    migration_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    account_id: str = Field(min_length=1, max_length=256)
    account_label: str = Field(default="", max_length=256)
    credential: SecretStr = Field(repr=False)

    _limit_size = field_validator("credential")(
        PluginCredentialWrite.limit_credential_size.__func__
    )


class PluginNativeRead(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    connection_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    installed_plugin_id: int = Field(gt=0)
    expected_revision: int = Field(ge=1)


class PluginNativePreparation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    migration_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class PluginNativeExecution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    installed_plugin_id: int = Field(gt=0)
    connector_slug: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$")
    account_id: str | None = Field(default=None, min_length=1, max_length=256)


class PluginOAuthFinish(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    connection_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    operation_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    succeeded: bool
    attempted: bool = True
    account_id: str | None = Field(default=None, min_length=1, max_length=256)
    credential: SecretStr | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def require_result(self) -> "PluginOAuthFinish":
        if self.succeeded and not self.attempted:
            raise ValueError("A successful operation must have been attempted")
        if (
            self.succeeded and (self.credential is None or self.account_id is None)
        ) or (
            not self.succeeded
            and (self.credential is not None or self.account_id is not None)
        ):
            raise ValueError("Successful refresh requires an account and credential")
        if self.credential is not None:
            PluginCredentialWrite.limit_credential_size(self.credential)
        return self


class PluginRevocationBegin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    connection_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class PluginRevocationFinish(PluginRevocationBegin):
    operation_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    succeeded: bool


class PluginAuthAutomationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool


class PluginNativeAutomation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    installed_plugin_ids: list[int] = Field(max_length=256)

    @field_validator("installed_plugin_ids")
    @classmethod
    def validate_ids(cls, value: list[int]) -> list[int]:
        if any(item <= 0 for item in value) or len(set(value)) != len(value):
            raise ValueError("Installed plugin IDs must be positive and distinct")
        return value


class PluginNativeLocalLifecycle(BaseModel):
    """Public local-login lifecycle; credentials never enter this request."""

    model_config = ConfigDict(extra="forbid", strict=True)
    installed_plugin_id: int = Field(gt=0)
    connector_slug: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$")
    action: Literal["status", "logout", "login"]
