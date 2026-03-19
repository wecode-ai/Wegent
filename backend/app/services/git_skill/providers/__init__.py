# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git repository providers package.

This module provides factory functions for creating Git repository providers
and exports all provider classes.
"""

from app.services.git_skill.providers.base import GitRepoProvider
from app.services.git_skill.providers.gitea import GiteaProvider
from app.services.git_skill.providers.gitee import GiteeProvider
from app.services.git_skill.providers.github import GitHubProvider
from app.services.git_skill.providers.gitlab import GitLabProvider

__all__ = [
    "GitRepoProvider",
    "GitHubProvider",
    "GitLabProvider",
    "GiteeProvider",
    "GiteaProvider",
    "get_provider_by_type",
    "get_provider_by_host",
]

# Provider type to class mapping
PROVIDER_TYPE_MAP = {
    "github": GitHubProvider,
    "gitlab": GitLabProvider,
    "gitee": GiteeProvider,
    "gitea": GiteaProvider,
}

# Host pattern to provider class mapping
HOST_PROVIDER_MAP = {
    "github.com": GitHubProvider,
    "gitlab.com": GitLabProvider,
    "gitee.com": GiteeProvider,
}


def _is_same_domain_or_subdomain(host: str, domain: str) -> bool:
    """Check whether host equals domain or is one of its subdomains."""
    return host == domain or host.endswith(f".{domain}")


def _has_domain_label(host: str, label: str) -> bool:
    """Check whether a specific DNS label exists in host."""
    return label in [part for part in host.split(".") if part]


def get_provider_by_type(git_type: str, host: str, base_url: str) -> GitRepoProvider:
    """
    Get the appropriate Git provider based on the configured type.

    Args:
        git_type: Git provider type (github, gitlab, gitee, gitea)
        host: Git host domain
        base_url: Full base URL with protocol and port

    Returns:
        GitRepoProvider instance
    """
    provider_class = PROVIDER_TYPE_MAP.get(git_type, GiteaProvider)
    return provider_class(host, base_url)


def get_provider_by_host(host: str, base_url: str) -> GitRepoProvider:
    """
    Get the appropriate Git provider based on the host domain.

    Args:
        host: Git host domain (e.g., "github.com", "gitlab.company.com")
        base_url: Full base URL with protocol and port

    Returns:
        GitRepoProvider instance
    """
    # Check for known hosts first (exact/contains match)
    for known_host, provider_class in HOST_PROVIDER_MAP.items():
        if _is_same_domain_or_subdomain(host, known_host):
            return provider_class(host, base_url)

    # Self-hosted GitLab domains (e.g. gitlab.company.com)
    if _has_domain_label(host, "gitlab"):
        return GitLabProvider(host, base_url)

    # Default to Gitea for unknown hosts
    return GiteaProvider(host, base_url)
