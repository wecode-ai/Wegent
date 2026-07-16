# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Sequence
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.subtask_context import AttachmentDetailResponse

MAX_QUICK_PHRASES = 6
MAX_QUICK_PHRASE_LENGTH = 120
MAX_INPUT_PRESETS = 6
MAX_INPUT_PRESET_PROMPT_LENGTH = 2000
MAX_INPUT_PRESET_ATTACHMENTS = 10


def normalize_quick_phrases(
    value: Sequence[object] | None,
    *,
    max_items: int | None = MAX_QUICK_PHRASES,
) -> list[str]:
    if not value:
        return []
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError("quick_phrases must be a list of strings")

    phrases: list[str] = []
    for index, phrase in enumerate(value):
        if not isinstance(phrase, str):
            raise ValueError(f"quick_phrases[{index}] must be a string, got {phrase!r}")

        trimmed = phrase.strip()
        if trimmed:
            phrases.append(trimmed)
            if max_items is not None and len(phrases) >= max_items:
                break
    return phrases


class QuickPhraseMixin(BaseModel):
    quick_phrases: list[str] = Field(default_factory=list)

    @field_validator("quick_phrases", mode="before")
    @classmethod
    def validate_quick_phrases(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("quick_phrases must be a list")

        phrases = normalize_quick_phrases(value, max_items=None)
        if len(phrases) > MAX_QUICK_PHRASES:
            raise ValueError(
                f"quick_phrases supports at most {MAX_QUICK_PHRASES} items"
            )
        for phrase in phrases:
            if len(phrase) > MAX_QUICK_PHRASE_LENGTH:
                raise ValueError(
                    f"quick phrase must be at most {MAX_QUICK_PHRASE_LENGTH} characters"
                )
        return phrases


def _preset_id_from_index(index: int) -> str:
    return f"preset_{index + 1}"


def input_presets_from_phrases(
    phrases: Sequence[object] | None,
) -> list["QuickLaunchInputPreset"]:
    return [
        QuickLaunchInputPreset(
            id=_preset_id_from_index(index),
            title=phrase,
            prompt=phrase,
        )
        for index, phrase in enumerate(normalize_quick_phrases(phrases))
    ]


class QuickLaunchInputOptions(BaseModel):
    enable_deep_thinking: Optional[bool] = None
    enable_clarification: Optional[bool] = None
    force_override: Optional[bool] = None
    selected_skill_names: list[str] = Field(default_factory=list)

    @field_validator("selected_skill_names", mode="before")
    @classmethod
    def validate_selected_skill_names(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("selected_skill_names must be a list")

        names: list[str] = []
        for index, item in enumerate(value):
            if not isinstance(item, str):
                raise ValueError(
                    f"selected_skill_names[{index}] must be a string, got {item!r}"
                )
            trimmed = item.strip()
            if trimmed and trimmed not in names:
                names.append(trimmed)
        return names


class QuickLaunchInputPreset(BaseModel):
    id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    prompt: Optional[str] = None
    options: QuickLaunchInputOptions = Field(default_factory=QuickLaunchInputOptions)
    source_attachment_ids: list[int] = Field(default_factory=list)

    @field_validator("id", "title", mode="before")
    @classmethod
    def trim_required_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("prompt", mode="before")
    @classmethod
    def normalize_prompt(cls, value: object) -> Optional[str]:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("prompt must be a string")
        prompt = value.strip()
        if len(prompt) > MAX_INPUT_PRESET_PROMPT_LENGTH:
            raise ValueError(
                f"input preset prompt must be at most "
                f"{MAX_INPUT_PRESET_PROMPT_LENGTH} characters"
            )
        return prompt or None

    @field_validator("source_attachment_ids", mode="before")
    @classmethod
    def validate_source_attachment_ids(cls, value: object) -> list[int]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("source_attachment_ids must be a list")

        ids: list[int] = []
        for index, item in enumerate(value):
            if isinstance(item, bool) or not isinstance(item, int):
                raise ValueError(
                    f"source_attachment_ids[{index}] must be a positive integer"
                )
            if item <= 0:
                raise ValueError(
                    f"source_attachment_ids[{index}] must be a positive integer"
                )
            if item not in ids:
                ids.append(item)
            if len(ids) > MAX_INPUT_PRESET_ATTACHMENTS:
                raise ValueError(
                    f"source_attachment_ids supports at most "
                    f"{MAX_INPUT_PRESET_ATTACHMENTS} items"
                )
        return ids


class InputPresetMixin(BaseModel):
    input_presets: list[QuickLaunchInputPreset] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def migrate_quick_phrases_to_input_presets(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        if value.get("input_presets"):
            return value
        quick_phrases = value.get("quick_phrases")
        if not quick_phrases:
            return value

        migrated = dict(value)
        migrated["input_presets"] = [
            preset.model_dump() for preset in input_presets_from_phrases(quick_phrases)
        ]
        return migrated

    @field_validator("input_presets", mode="before")
    @classmethod
    def validate_input_presets(cls, value: object) -> list[object]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("input_presets must be a list")
        if len(value) > MAX_INPUT_PRESETS:
            raise ValueError(
                f"input_presets supports at most {MAX_INPUT_PRESETS} items"
            )
        return value


class QuickLaunchFunctionConfig(InputPresetMixin):
    id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    description: Optional[str] = None
    icon: Optional[str] = None
    team_id: int
    enabled: bool = True
    order: int = 0


class QuickLaunchFunctionResponse(QuickLaunchFunctionConfig):
    type: Literal["system_function"] = "system_function"
    name: str


class QuickLaunchFavoriteAgent(QuickPhraseMixin, InputPresetMixin):
    type: Literal["favorite_agent"] = "favorite_agent"
    id: int
    team_id: int
    name: str
    title: str
    description: Optional[str] = None
    icon: Optional[str] = None
    recommended_mode: Optional[Literal["chat", "code", "both"]] = "both"
    agent_type: Optional[str] = None


class QuickLaunchResponse(BaseModel):
    system_functions: list[QuickLaunchFunctionResponse] = Field(default_factory=list)
    favorite_agents: list[QuickLaunchFavoriteAgent] = Field(default_factory=list)


class QuickLaunchPreparePresetRequest(BaseModel):
    function_id: str = Field(..., min_length=1)
    preset_id: str = Field(..., min_length=1)

    @field_validator("function_id", "preset_id", mode="before")
    @classmethod
    def trim_required_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


class QuickLaunchPreparePresetResponse(BaseModel):
    function_id: str
    preset_id: str
    attachments: list[AttachmentDetailResponse] = Field(default_factory=list)


class QuickLaunchFunctionsUpdate(BaseModel):
    functions: list[QuickLaunchFunctionConfig] = Field(default_factory=list)


class QuickLaunchFunctionsResponse(QuickLaunchFunctionsUpdate):
    version: int
