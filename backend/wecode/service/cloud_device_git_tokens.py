# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for passing user Git accounts into cloud devices."""

from typing import Any, Dict, Iterable

GIT_TOKEN_ENV_BY_DOMAIN: Dict[str, str] = {
    "git.intra.weibo.com": "GIT_INTRA_WEIBO_COM_TOKEN",
    "git.staff.sina.com.cn": "GIT_STAFF_SINA_COM_CN_TOKEN",
    "gitlab.weibo.cn": "GITLAB_WEIBO_CN_TOKEN",
}
DEFAULT_GITLAB_USERNAME = "oauth2"


def _single_line(value: object, *, field: str, domain: str) -> str:
    normalized = str(value or "").strip()
    if any(character in normalized for character in ("\x00", "\r", "\n")):
        raise ValueError(f"Git account {field} is invalid for domain {domain}")
    return normalized


def build_cloud_device_git_accounts(
    git_tokens: Iterable[Dict[str, Any]] | None,
) -> list[Dict[str, Any]]:
    """Build managed-device account payloads from validated GitLab tokens."""
    accounts: list[Dict[str, Any]] = []
    for item in git_tokens or []:
        if item.get("type") != "gitlab":
            continue

        domain = str(item.get("git_domain") or "").strip().lower()
        token = _single_line(item.get("git_token"), field="credential", domain=domain)
        if domain not in GIT_TOKEN_ENV_BY_DOMAIN or not token or token == "***":
            continue

        identity_name = _single_line(
            item.get("git_login"), field="identity name", domain=domain
        )
        identity_email = _single_line(
            item.get("git_email"), field="identity email", domain=domain
        )
        accounts.append(
            {
                "domain": domain,
                "host": domain,
                "provider": "gitlab",
                "token": token,
                "username": identity_name or DEFAULT_GITLAB_USERNAME,
                "identity_name": identity_name or None,
                "identity_email": identity_email or None,
            }
        )
    return accounts


def build_git_token_envs(git_tokens: Iterable[Dict[str, Any]] | None) -> Dict[str, str]:
    """Build Nevis/script environment variables from supported git token entries."""
    envs: Dict[str, str] = {}
    if not git_tokens:
        return envs

    for item in git_tokens:
        provider = item.get("provider") or item.get("type")
        if provider != "gitlab":
            continue

        domain = item.get("domain") or item.get("git_domain", "")
        env_name = GIT_TOKEN_ENV_BY_DOMAIN.get(domain)
        token = item.get("token") or item.get("git_token")
        if env_name and token and token != "***":
            envs[env_name] = token

    return envs
