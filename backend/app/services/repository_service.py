# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Repository aggregation service for handling multiple repository providers
"""
import asyncio
import logging
from typing import List, Dict, Any, Optional
from fastapi import HTTPException

from app.models.user import User
from app.repository.github_provider import GitHubProvider
from app.repository.gitlab_provider import GitLabProvider
from app.schemas.github import RepositoryResult, Branch, TokenValidationResponse


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
        if not user_providers:
            raise HTTPException(
                status_code=400,
                detail="No git token configured. Please add your git token."
            )
        
        all_repos = []
        
        # Fetch repositories from all configured providers concurrently
        tasks = []
        for provider_type in user_providers:
            provider = self.providers[provider_type]
            task = provider.get_repositories(user, page=1, limit=100)  # Get more to ensure pagination
            tasks.append(task)
        
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            for idx, result in enumerate(results):
                provider_type = user_providers[idx]
                if isinstance(result, Exception):
                    self.logger.error(f"Error fetching repositories from {provider_type}: {result}")
                    raise HTTPException(
                        status_code=502,
                        detail="Failed to fetch repositories. Please check if your token is correct or has expired."
                    )
                
                # Add provider type to each repository
                for repo in result:
                    repo["provider_type"] = provider_type
                    repo["git_domain"] = self.providers[provider_type].domain
                
                all_repos.extend(result)
            
        except Exception as e:
            self.logger.error(f"Error fetching repositories: {e}")
            raise HTTPException(
                status_code=502,
                detail=f"Error fetching repositories: {str(e)}"
            )
        
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
        provider_type: Optional[str] = None
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
        user_providers = self._get_user_providers(user)
        if not user_providers:
            return []
        
        # If provider_type is specified, use only that provider
        if provider_type and provider_type in user_providers:
            provider = self.providers[provider_type]
            return await provider.get_branches(user, repo_name)
        
        # Try all providers until we find the repository
        for provider_type in user_providers:
            provider = self.providers[provider_type]
            try:
                branches = await provider.get_branches(user, repo_name)
                if branches:
                    # Add provider info to branches
                    for branch in branches:
                        branch["provider_type"] = provider_type
                    return branches
            except Exception as e:
                self.logger.warning(f"Error getting branches from {provider_type}: {e}")
                continue
        
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
        
        # Search in all configured providers concurrently
        tasks = []
        for provider_type in user_providers:
            provider = self.providers[provider_type]
            task = provider.search_repositories(user, query, timeout)
            tasks.append(task)
        
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            for idx, result in enumerate(results):
                provider_type = user_providers[idx]
                if isinstance(result, Exception):
                    self.logger.error(f"Error searching repositories in {provider_type}: {result}")
                    continue
                
                # Add provider type to each repository
                for repo in result:
                    repo["provider_type"] = provider_type
                    repo["git_domain"] = self.providers[provider_type].domain
                
                all_results.extend(result)
            
        except Exception as e:
            self.logger.error(f"Error searching repositories: {e}")
            raise HTTPException(
                status_code=502,
                detail=f"Error searching repositories: {str(e)}"
            )
        
        # Sort by relevance (basic sorting by name match)
        query_lower = query.lower()
        all_results.sort(
            key=lambda x: (
                not (query_lower in x["name"].lower() or query_lower in x["full_name"].lower()),
                -len(x["name"])
            )
        )
        
        return all_results
    
    def get_repo_id_by_fullname(
        self,
        user: User,
        fullname: str,
        provider_type: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get repository ID and provider info by full name
        
        Args:
            user: User object
            fullname: Full name of the repository
            provider_type: Specific provider type, if None try all providers
            
        Returns:
            Dictionary with repo_id and provider_type, or None if not found
        """
        user_providers = self._get_user_providers(user)
        if not user_providers:
            return None
        
        # If provider_type is specified, use only that provider
        if provider_type and provider_type in user_providers:
            provider = self.providers[provider_type]
            repo_id = provider.get_repo_id_by_fullname(user, fullname)
            if repo_id:
                return {"repo_id": repo_id, "provider_type": provider_type}
            return None
        
        # Try all providers
        for provider_type in user_providers:
            provider = self.providers[provider_type]
            try:
                repo_id = provider.get_repo_id_by_fullname(user, fullname)
                if repo_id:
                    return {"repo_id": repo_id, "provider_type": provider_type}
            except Exception as e:
                self.logger.warning(f"Error getting repo ID from {provider_type}: {e}")
                continue
        
        return None


# Global service instance
repository_service = RepositoryService()