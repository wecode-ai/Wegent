# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Repository aggregation service for handling multiple repository providers
"""
import asyncio
import logging
from typing import List, Dict, Any
from fastapi import HTTPException

from app.models.user import User
from app.repository.github_provider import GitHubProvider
from app.repository.gitlab_provider import GitLabProvider


class RepositoryService:
    """
    Service for aggregating results from multiple repository providers
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.providers = {
            "github": GitHubProvider(),
            "gitlab": GitLabProvider()
        }
    
    def _get_user_providers(self, user: User) -> List[str]:
        """
        Get list of configured providers for user
        
        Args:
            user: User object
            
        Returns:
            List of provider types configured by user
        """
        if not user.git_info:
            return []
        
        providers = []
        for info in user.git_info:
            provider_type = info.get("type")
            if provider_type in self.providers and info.get("git_token"):
                providers.append(provider_type)
        
        return providers
    
    async def get_repositories(
        self,
        user: User,
        page: int = 1,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get repositories from all configured providers
        
        Args:
            user: User object
            page: Page number
            limit: Items per page
            
        Returns:
            Combined repository list from all providers
        """
        user_providers = self._get_user_providers(user)
        if not user_providers or user_providers == []:
            raise HTTPException(
                status_code=400,
                detail="No git token configured. Please add your git token."
            )
        
        all_repos = []
        
        for provider_type in user_providers:
            try:
                provider = self.providers[provider_type]
                repos = await provider.get_repositories(user, page=1, limit=100)
                all_repos.extend(repos)
            except Exception as e:
                try:
                    repos = await provider.get_repositories(user, page=1, limit=100)
                    all_repos.extend(repos)
                except Exception as e:
                    self.logger.error(f"Retrying fetching repositories from {provider_type}: {e}")
                continue

        # Sort by last updated (simulated with basic sorting)
        all_repos.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        
        # Apply pagination
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        
        return all_repos[start_idx:end_idx]
    
    async def get_branches(
        self,
        user: User,
        repo_name: str,
        type: str,
        git_domain: str
    ) -> List[Dict[str, Any]]:
        """
        Get branches for a repository
        
        Args:
            user: User object
            repo_name: Repository name
            provider_type: Specific provider type, if None try to infer from repo_name
            
        Returns:
            Branch list
        """
        for info in user.git_info:
            if info.get("type") == type and info.get("git_domain") == git_domain:
                provider = self.providers[type]
                try:
                    return await provider.get_branches(user, repo_name, git_domain)
                except Exception as e:
                    self.logger.warning(f"Error getting branches from {type}: {e}")
                    raise HTTPException(status_code=500, detail=f"Error getting branches from {type}: {e}")

        return []
    
    async def validate_tokens(
        self,
        user: User
    ) -> Dict[str, Any]:
        """
        Validate tokens for all configured providers
        
        Args:
            user: User object
            
        Returns:
            Validation results for all providers
        """
        user_providers = self._get_user_providers(user)
        if not user_providers:
            return {"providers": {}}
        
        results = {"providers": {}}
        
        for provider_type in user_providers:
            provider = self.providers[provider_type]
            git_info = None
            
            # Get token for this provider
            for info in user.git_info:
                if info.get("type") == provider_type:
                    git_info = info
                    break
            
            if git_info and git_info.get("git_token"):
                try:
                    validation_result = provider.validate_token(git_info["git_token"])
                    results["providers"][provider_type] = validation_result
                except Exception as e:
                    self.logger.error(f"Error validating token for {provider_type}: {e}")
                    results["providers"][provider_type] = {
                        "valid": False,
                        "error": str(e)
                    }
        
        return results
    
    async def search_repositories(
        self,
        user: User,
        query: str,
        timeout: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Search repositories across all configured providers
        
        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            
        Returns:
            Combined search results from all providers
        """
        user_providers = self._get_user_providers(user)
        if not user_providers:
            return []
        
        all_results = []
        
        for provider_type in user_providers:
            try:
                provider = self.providers[provider_type]
                results = await provider.search_repositories(user, query, timeout)
                all_results.extend(results)
            except Exception as e:
                self.logger.error(f"Error searching repositories in {provider_type}: {e}")
                continue
        
        # Sort by relevance (basic sorting by name match)
        query_lower = query.lower()
        all_results.sort(
            key=lambda x: (
                not (query_lower in x["name"].lower() or query_lower in x["full_name"].lower()),
                -len(x["name"])
            )
        )
        
        return all_results
    

# Global service instance
repository_service = RepositoryService()