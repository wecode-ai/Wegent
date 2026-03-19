# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Version checker factory for creating appropriate version checker based on config."""

from executor.config.device_config import UpdateConfig
from executor.services.updater.github_version_checker import GithubVersionChecker
from executor.services.updater.registry_version_checker import RegistryVersionChecker
from executor.services.updater.version_checker import VersionChecker


def create_version_checker(config: UpdateConfig) -> VersionChecker:
    """Create appropriate version checker based on configuration.

    Args:
        config: Update configuration

    Returns:
        Version checker instance

    Raises:
        ValueError: If registry URL is missing when registry is configured
    """
    if config.is_registry():
        registry_url = config.get_registry_url()
        if not registry_url:
            raise ValueError(
                "Registry URL is required. "
                "Please set 'update.registry' in device-config.json or "
                "set REGISTRY environment variable."
            )
        return RegistryVersionChecker(
            registry_url=registry_url,
            auth_token=config.get_token()
        )
    else:
        # Default: GitHub (no token needed for public repo)
        return GithubVersionChecker(github_token=None)
