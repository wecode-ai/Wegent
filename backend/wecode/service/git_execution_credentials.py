# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Register internal Git credential resolution for execution requests."""

from app.services.execution.git_credentials import (
    register_placeholder_git_token_resolver,
)
from shared.models.db import User
from wecode.service.token_resolver import token_resolver


def _resolve_internal_git_token(user: User, git_domain: str) -> str:
    return token_resolver.resolve_git_token(
        username=user.user_name,
        git_domain=git_domain,
        fallback_token="***",
    )


register_placeholder_git_token_resolver(_resolve_internal_git_token)
