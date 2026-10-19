# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The provider-independent decision router request contract."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DecisionQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    type: Literal["noul", "choice", "score"]
    instructions: str | dict[str, Any] | list[Any]
    criteria: dict[str, Any] | list[Any] | None = None

    @model_validator(mode="after")
    def validate_criteria(self) -> "DecisionQuestion":
        if not self.instructions or (
            isinstance(self.instructions, str) and not self.instructions.strip()
        ):
            raise ValueError("Question instructions must not be empty")
        if self.type == "noul":
            if self.criteria is not None and (
                not isinstance(self.criteria, dict)
                or not set(self.criteria).issubset({"true", "false"})
            ):
                raise ValueError("Noul criteria must describe true and false")
        elif self.type == "choice":
            if (
                not isinstance(self.criteria, dict)
                or not 1 <= len(self.criteria) <= 255
                or any(not key.strip() for key in self.criteria)
            ):
                raise ValueError("Choice criteria must contain 1 to 255 options")
        elif not isinstance(self.criteria, list) or not 2 <= len(self.criteria) <= 10:
            raise ValueError("Score criteria must contain 2 to 10 levels")
        return self


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._/:-]+$")
    state: str | dict[str, Any] | list[Any]
    questions: dict[str, DecisionQuestion] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_question_names(self) -> "DecisionRequest":
        if any(not name.strip() for name in self.questions):
            raise ValueError("Question names must not be blank")
        return self
