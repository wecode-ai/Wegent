# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Validation at the model response boundary."""

from collections.abc import Mapping
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import ChatGeneration, LLMResult


class MalformedModelResponseError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(
            "The model returned a malformed response (MALFORMED_RESPONSE). Please retry."
        )


def validate_response_metadata(metadata: Mapping[str, Any]) -> None:
    reason = metadata.get("finish_reason") or metadata.get("stop_reason")
    if reason == "MALFORMED_RESPONSE":
        raise MalformedModelResponseError()


class ModelResponseValidator(BaseCallbackHandler):
    # The model call must fail before LangGraph can route the result to a tool.
    raise_error = True
    run_inline = True

    @staticmethod
    def _validate_generation(generation: ChatGeneration) -> None:
        validate_response_metadata(
            {
                **(generation.generation_info or {}),
                **generation.message.response_metadata,
            }
        )

    def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        chunk = kwargs.get("chunk")
        if isinstance(chunk, ChatGeneration):
            # Stream aggregation can concatenate duplicate finish reason strings.
            self._validate_generation(chunk)

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        for candidates in response.generations:
            if candidates and isinstance(candidates[0], ChatGeneration):
                self._validate_generation(candidates[0])
