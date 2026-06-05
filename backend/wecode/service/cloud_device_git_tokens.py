# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for passing user git tokens into cloud devices."""

from typing import Any, Dict, Iterable

GIT_TOKEN_ENV_BY_DOMAIN: Dict[str, str] = {
    "git.intra.weibo.com": "GIT_INTRA_WEIBO_COM_TOKEN",
    "git.staff.sina.com.cn": "GIT_STAFF_SINA_COM_CN_TOKEN",
    "gitlab.weibo.cn": "GITLAB_WEIBO_CN_TOKEN",
}


def build_git_token_envs(git_tokens: Iterable[Dict[str, Any]] | None) -> Dict[str, str]:
    """Build Nevis/script environment variables from supported git token entries."""
    envs: Dict[str, str] = {}
    if not git_tokens:
        return envs

    for item in git_tokens:
        if item.get("type") != "gitlab":
            continue

        env_name = GIT_TOKEN_ENV_BY_DOMAIN.get(item.get("git_domain", ""))
        token = item.get("git_token")
        if env_name and token and token != "***":
            envs[env_name] = token

    return envs
