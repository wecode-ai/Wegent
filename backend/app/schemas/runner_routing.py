"""Non-secret collaboration execution policies and runner capabilities."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExecutionPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["project_pool", "fixed", "user_select"]
    environment_id: str | None = Field(default=None, pattern=r"^[1-9][0-9]*$")

    @model_validator(mode="after")
    def validate_target(self) -> "ExecutionPolicy":
        if (self.mode == "fixed") != (self.environment_id is not None):
            raise ValueError("Only a fixed policy must specify an environment")
        return self


class CloudModelReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    type: Literal["public", "user", "group"]
    namespace: str = Field(min_length=1, max_length=255)
    resource_user_id: int = Field(ge=0)


class ModelIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtime: Literal["codex", "claude_code"]
    provider: str = Field(min_length=1, max_length=200)
    model_id: str = Field(min_length=1, max_length=255)
    source: Literal["native", "cloud"] | None = None
    cloud_model: CloudModelReference | None = None

    @model_validator(mode="after")
    def validate_source(self) -> "ModelIdentity":
        if (self.source == "cloud") != (self.cloud_model is not None):
            raise ValueError("Only cloud models must include a resource reference")
        return self


class ModelPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["fixed", "user_select"]
    model: ModelIdentity | None = None

    @model_validator(mode="after")
    def validate_model(self) -> "ModelPolicy":
        if (self.mode == "fixed") != (self.model is not None):
            raise ValueError("Only a fixed model policy must specify a model")
        return self


class RunnerModel(ModelIdentity):
    label: str = Field(min_length=1, max_length=255)
    # This is a device-local selector, never a creator's credential reference.
    local_model_id: str = Field(min_length=1, max_length=255)
    account_label: str = Field(default="", max_length=255)
    is_default: bool = False


class RunnerCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    errors: list[str] = Field(default_factory=list, max_length=10)
    runtimes: list[Literal["codex", "claude_code"]] = Field(default_factory=list)
    models: list[RunnerModel] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def unique_models(self) -> "RunnerCatalog":
        if any(model.source == "cloud" for model in self.models):
            raise ValueError("Runner reports must contain only native models")
        keys = [(m.runtime, m.provider, m.model_id) for m in self.models]
        if len(keys) != len(set(keys)):
            raise ValueError("Runner model identities must be unique")
        for runtime in {m.runtime for m in self.models}:
            if sum(m.is_default for m in self.models if m.runtime == runtime) > 1:
                raise ValueError("A runtime can have only one default model")
        return self


class RunnerSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    execution_policy: ExecutionPolicy | None = None
    model: ModelIdentity | None = None


class WorkspaceRunnerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
