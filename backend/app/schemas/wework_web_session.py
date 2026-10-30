# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import re
from typing import Annotated
from urllib.parse import parse_qsl, unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

Nonce = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Token = Annotated[str, Field(min_length=1, max_length=8192)]


class WeworkWebSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nonce: Nonce
    redirect: str = Field(min_length=1, max_length=1024)

    @field_validator("redirect")
    @classmethod
    def validate_redirect(cls, value: str) -> str:
        """Restrict handoff destinations to one collaboration Issue/comment."""
        url = urlsplit(value)
        if (
            not value.startswith("/collaboration/")
            or re.search(r"[\\\x00-\x1f\x7f]", value)
            or url.scheme
            or url.netloc
            or url.fragment
            or not re.fullmatch(r"/collaboration/[1-9]\d*/issues/[^/?#]+", url.path)
        ):
            raise ValueError("Invalid Issue redirect")
        item_id = unquote(url.path.rsplit("/", 1)[1])
        if item_id in {".", ".."} or re.search(r"[\x00-\x1f\x7f]", item_id):
            raise ValueError("Invalid Issue identifier")
        query = parse_qsl(url.query, keep_blank_values=True)
        keys = [key for key, _value in query]
        if len(keys) != len(set(keys)) or any(
            key not in {"commentId", "focusRequest"} or not value
            for key, value in query
        ):
            raise ValueError("Invalid Issue comment")
        return value


class WeworkWebSessionCreateResponse(BaseModel):
    code: str
    user_id: int
    expires_at: int


class WeworkWebSessionExchangeRequest(WeworkWebSessionRequest):
    code: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    existing_tokens: list[Token] = Field(default_factory=list, max_length=4)


class WeworkWebSessionExchangeResponse(BaseModel):
    access_token: str
    user_id: int
    username: str
    expires_at: int
