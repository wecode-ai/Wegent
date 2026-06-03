# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Sequence
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

MAX_QUICK_PHRASES = 6
MAX_QUICK_PHRASE_LENGTH = 120


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


class QuickLaunchFunctionConfig(QuickPhraseMixin):
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


class QuickLaunchFavoriteAgent(QuickPhraseMixin):
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


class QuickLaunchFunctionsUpdate(BaseModel):
    functions: list[QuickLaunchFunctionConfig] = Field(default_factory=list)


class QuickLaunchFunctionsResponse(QuickLaunchFunctionsUpdate):
    version: int
