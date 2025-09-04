# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Provider factory class for creating repository provider instances
"""
from typing import Dict, Any, Type

from app.core.interfaces.repository_provider import RepositoryProvider
from app.core.config import settings

from app.repository.github_provider import GitHubProvider
# from app.internal.repository.gitlab_provider import GitLabProvider

class ProviderFactory:
    """
    Provider factory class for creating repository provider instances
    """
    
    # Repository provider mapping
    _repository_providers: Dict[str, Type[RepositoryProvider]] = {
        "github": GitHubProvider,
        # "gitlab": GitLabProvider
    }
    
    @classmethod
    def get_repository_provider(cls) -> RepositoryProvider:
        """
        Get repository provider instance
        
        Returns:
            Repository provider instance
        """
        provider_type = settings.REPOSITORY_PROVIDER_TYPE or "github"
        
        provider_class = cls._repository_providers.get(provider_type)
        if not provider_class:
            raise ValueError(f"Unsupported repository provider type: {provider_type}")
        
        return provider_class()


# Global provider instance
repository_provider = ProviderFactory.get_repository_provider()