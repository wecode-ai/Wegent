#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Feature Manager - Manages feature directories for cross-repository development.

A feature represents a business requirement that may span multiple repositories.
All repositories in a feature share the same branch name.
"""

import os
import json
import shutil
from datetime import datetime
from typing import Optional, Tuple, List, Dict, Any
from dataclasses import dataclass, asdict

from shared.logger import setup_logger
from executor.workspace.repo_manager import RepoManager
from executor.workspace.worktree_manager import WorktreeManager

logger = setup_logger("feature_manager")


@dataclass
class RepositoryConfig:
    """Configuration for a repository in a feature."""
    name: str
    git_url: str
    branch: str
    worktree_path: str


@dataclass
class FeatureMetadata:
    """Metadata for a feature directory."""
    name: str
    created_at: str
    created_by_task: int
    repositories: List[Dict[str, str]]
    tasks: List[int]
    last_accessed: str


class FeatureManager:
    """
    Manages feature directories for cross-repository development.
    
    Feature directories are organized as:
    /workspace/features/{feature-name}/
    ├── .feature.json           # Feature metadata
    ├── {repo1}/                # Worktree for repository 1
    ├── {repo2}/                # Worktree for repository 2
    └── _workspace/             # Claude's working directory
    """
    
    METADATA_FILE = ".feature.json"
    WORKSPACE_DIR = "_workspace"
    
    def __init__(
        self,
        features_root: str = "/workspace/features",
        repos_root: str = "/workspace/repos"
    ):
        """
        Initialize the feature manager.
        
        Args:
            features_root: Root directory for feature directories
            repos_root: Root directory for bare repositories
        """
        self.features_root = features_root
        self.repo_manager = RepoManager(repos_root)
        self.worktree_manager = WorktreeManager()
        
        os.makedirs(features_root, exist_ok=True)
    
    def get_feature_path(self, feature_name: str) -> str:
        """Get the path to a feature directory."""
        return os.path.join(self.features_root, feature_name)
    
    def feature_exists(self, feature_name: str) -> bool:
        """Check if a feature directory exists."""
        feature_path = self.get_feature_path(feature_name)
        metadata_path = os.path.join(feature_path, self.METADATA_FILE)
        return os.path.exists(feature_path) and os.path.exists(metadata_path)
    
    def create_feature(
        self,
        feature_name: str,
        repositories: List[Dict[str, str]],
        task_id: int,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None,
        source_branch: Optional[str] = None
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Create a new feature directory with worktrees for all repositories.
        
        Args:
            feature_name: Name of the feature (used as the new branch name)
            repositories: List of repository configs, each with 'git_url' and optional 'name'
            task_id: ID of the task creating this feature
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            source_branch: Source branch to create the feature branch from (e.g., 'develop', 'main')
            
        Returns:
            Tuple of (success, feature_path, error_message)
        """
        feature_path = self.get_feature_path(feature_name)
        
        # Check if feature already exists
        if self.feature_exists(feature_name):
            logger.info(f"Feature {feature_name} already exists, updating access time")
            self._update_access_time(feature_name)
            self._add_task_to_feature(feature_name, task_id)
            return True, feature_path, None
        
        try:
            # Create feature directory
            os.makedirs(feature_path, exist_ok=True)
            
            # Create workspace directory for Claude
            workspace_path = os.path.join(feature_path, self.WORKSPACE_DIR)
            os.makedirs(workspace_path, exist_ok=True)
            
            # Initialize metadata
            metadata = FeatureMetadata(
                name=feature_name,
                created_at=datetime.now().isoformat(),
                created_by_task=task_id,
                repositories=[],
                tasks=[task_id],
                last_accessed=datetime.now().isoformat()
            )
            
            # Create worktrees for each repository
            for repo_config in repositories:
                git_url = repo_config["git_url"]
                repo_name = repo_config.get("name") or self.repo_manager.extract_repo_name(git_url)
                
                # Ensure bare repository exists
                success, bare_path, error = self.repo_manager.ensure_bare_repo(
                    git_url, git_token, git_login
                )
                if not success:
                    logger.error(f"Failed to ensure bare repo for {git_url}: {error}")
                    # Continue with other repos, don't fail completely
                    continue
                
                # Create worktree with feature branch based on source branch
                # The worktree will create a new branch (feature_name) from source_branch
                worktree_path = os.path.join(feature_path, repo_name)
                base_branch = source_branch or "main"  # Default to main if not specified
                success, error = self.worktree_manager.create_worktree(
                    bare_repo_path=bare_path,
                    worktree_path=worktree_path,
                    branch_name=feature_name,
                    create_branch=True,
                    base_branch=base_branch  # Create feature branch from source branch
                )
                
                if success:
                    metadata.repositories.append({
                        "name": repo_name,
                        "git_url": git_url,
                        "branch": feature_name,
                        "worktree_path": repo_name,
                        "bare_repo_path": bare_path,
                        "source_branch": source_branch  # Store source branch for reference
                    })
                    logger.info(f"Created worktree for {repo_name} at {worktree_path} (feature: {feature_name}, base: {base_branch})")
                else:
                    logger.error(f"Failed to create worktree for {repo_name}: {error}")
            
            # Save metadata
            self._save_metadata(feature_path, metadata)
            
            logger.info(f"Created feature {feature_name} with {len(metadata.repositories)} repositories (source: {source_branch})")
            return True, feature_path, None
            
        except Exception as e:
            error_msg = f"Failed to create feature {feature_name}: {e}"
            logger.error(error_msg)
            # Cleanup on failure
            if os.path.exists(feature_path):
                shutil.rmtree(feature_path, ignore_errors=True)
            return False, feature_path, error_msg
    
    def get_or_create_feature(
        self,
        feature_name: str,
        repositories: List[Dict[str, str]],
        task_id: int,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None,
        source_branch: Optional[str] = None
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Get an existing feature or create a new one.
        
        Args:
            feature_name: Name of the feature (used as the new branch name)
            repositories: List of repository configs
            task_id: ID of the task
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            source_branch: Source branch to create the feature branch from (e.g., 'develop', 'main')
            
        Returns:
            Tuple of (success, feature_path, error_message)
        """
        if self.feature_exists(feature_name):
            feature_path = self.get_feature_path(feature_name)
            self._update_access_time(feature_name)
            self._add_task_to_feature(feature_name, task_id)
            
            # Check if we need to add any new repositories
            metadata = self._load_metadata(feature_path)
            if metadata:
                existing_urls = {r["git_url"] for r in metadata.repositories}
                new_repos = [r for r in repositories if r["git_url"] not in existing_urls]
                
                if new_repos:
                    # Add new repositories to existing feature
                    for repo_config in new_repos:
                        self._add_repository_to_feature(
                            feature_name, repo_config, git_token, git_login, source_branch
                        )
            
            return True, feature_path, None
        
        return self.create_feature(
            feature_name, repositories, task_id, git_token, git_login, source_branch
        )
    
    def _add_repository_to_feature(
        self,
        feature_name: str,
        repo_config: Dict[str, str],
        git_token: Optional[str] = None,
        git_login: Optional[str] = None,
        source_branch: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        Add a new repository to an existing feature.
        
        Args:
            feature_name: Name of the feature
            repo_config: Repository configuration with 'git_url' and optional 'name'
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            source_branch: Source branch to create the feature branch from
        """
        feature_path = self.get_feature_path(feature_name)
        metadata = self._load_metadata(feature_path)
        
        if not metadata:
            return False, "Feature metadata not found"
        
        git_url = repo_config["git_url"]
        repo_name = repo_config.get("name") or self.repo_manager.extract_repo_name(git_url)
        
        # Ensure bare repository exists
        success, bare_path, error = self.repo_manager.ensure_bare_repo(
            git_url, git_token, git_login
        )
        if not success:
            return False, error
        
        # Create worktree with feature branch based on source branch
        worktree_path = os.path.join(feature_path, repo_name)
        base_branch = source_branch or "main"
        success, error = self.worktree_manager.create_worktree(
            bare_repo_path=bare_path,
            worktree_path=worktree_path,
            branch_name=feature_name,
            create_branch=True,
            base_branch=base_branch
        )
        
        if success:
            metadata.repositories.append({
                "name": repo_name,
                "git_url": git_url,
                "branch": feature_name,
                "worktree_path": repo_name,
                "bare_repo_path": bare_path,
                "source_branch": source_branch
            })
            self._save_metadata(feature_path, metadata)
            logger.info(f"Added repository {repo_name} to feature {feature_name} (base: {base_branch})")
            return True, None
        
        return False, error
    
    def delete_feature(self, feature_name: str, force: bool = False) -> Tuple[bool, Optional[str]]:
        """
        Delete a feature directory and its worktrees.
        
        Args:
            feature_name: Name of the feature to delete
            force: Force deletion even if there are uncommitted changes
            
        Returns:
            Tuple of (success, error_message)
        """
        feature_path = self.get_feature_path(feature_name)
        
        if not os.path.exists(feature_path):
            return True, None
        
        try:
            # Load metadata to get worktree info
            metadata = self._load_metadata(feature_path)
            
            if metadata:
                # Remove worktrees properly
                for repo in metadata.repositories:
                    bare_path = repo.get("bare_repo_path")
                    worktree_path = os.path.join(feature_path, repo["worktree_path"])
                    
                    if bare_path and os.path.exists(bare_path):
                        self.worktree_manager.remove_worktree(
                            bare_path, worktree_path, force=force
                        )
            
            # Remove feature directory
            shutil.rmtree(feature_path)
            logger.info(f"Deleted feature {feature_name}")
            return True, None
            
        except Exception as e:
            error_msg = f"Failed to delete feature {feature_name}: {e}"
            logger.error(error_msg)
            return False, error_msg
    
    def list_features(self) -> List[Dict[str, Any]]:
        """
        List all features.
        
        Returns:
            List of feature information dictionaries
        """
        features = []
        
        if not os.path.exists(self.features_root):
            return features
        
        for name in os.listdir(self.features_root):
            feature_path = os.path.join(self.features_root, name)
            if os.path.isdir(feature_path):
                metadata = self._load_metadata(feature_path)
                if metadata:
                    features.append({
                        "name": metadata.name,
                        "created_at": metadata.created_at,
                        "last_accessed": metadata.last_accessed,
                        "repository_count": len(metadata.repositories),
                        "task_count": len(metadata.tasks),
                        "path": feature_path
                    })
        
        return features
    
    def get_feature_info(self, feature_name: str) -> Optional[FeatureMetadata]:
        """
        Get detailed information about a feature.
        
        Args:
            feature_name: Name of the feature
            
        Returns:
            FeatureMetadata or None if not found
        """
        feature_path = self.get_feature_path(feature_name)
        return self._load_metadata(feature_path)
    
    def get_workspace_path(self, feature_name: str) -> str:
        """
        Get the Claude workspace path for a feature.
        
        Args:
            feature_name: Name of the feature
            
        Returns:
            Path to the workspace directory
        """
        return os.path.join(self.get_feature_path(feature_name), self.WORKSPACE_DIR)
    
    def _save_metadata(self, feature_path: str, metadata: FeatureMetadata) -> None:
        """Save feature metadata to file."""
        metadata_path = os.path.join(feature_path, self.METADATA_FILE)
        with open(metadata_path, "w") as f:
            json.dump(asdict(metadata), f, indent=2)
    
    def _load_metadata(self, feature_path: str) -> Optional[FeatureMetadata]:
        """Load feature metadata from file."""
        metadata_path = os.path.join(feature_path, self.METADATA_FILE)
        
        if not os.path.exists(metadata_path):
            return None
        
        try:
            with open(metadata_path, "r") as f:
                data = json.load(f)
                return FeatureMetadata(**data)
        except Exception as e:
            logger.warning(f"Failed to load metadata from {metadata_path}: {e}")
            return None
    
    def _update_access_time(self, feature_name: str) -> None:
        """Update the last accessed time for a feature."""
        feature_path = self.get_feature_path(feature_name)
        metadata = self._load_metadata(feature_path)
        
        if metadata:
            metadata.last_accessed = datetime.now().isoformat()
            self._save_metadata(feature_path, metadata)
    
    def _add_task_to_feature(self, feature_name: str, task_id: int) -> None:
        """Add a task ID to the feature's task list."""
        feature_path = self.get_feature_path(feature_name)
        metadata = self._load_metadata(feature_path)
        
        if metadata and task_id not in metadata.tasks:
            metadata.tasks.append(task_id)
            self._save_metadata(feature_path, metadata)
    
    def cleanup_old_features(self, max_age_days: int = 7) -> List[str]:
        """
        Clean up features that haven't been accessed recently.
        
        Args:
            max_age_days: Maximum age in days before cleanup
            
        Returns:
            List of deleted feature names
        """
        deleted = []
        now = datetime.now()
        
        for feature_info in self.list_features():
            try:
                last_accessed = datetime.fromisoformat(feature_info["last_accessed"])
                age_days = (now - last_accessed).days
                
                if age_days > max_age_days:
                    success, _ = self.delete_feature(feature_info["name"], force=True)
                    if success:
                        deleted.append(feature_info["name"])
                        logger.info(f"Cleaned up old feature: {feature_info['name']} (age: {age_days} days)")
            except Exception as e:
                logger.warning(f"Error checking feature age: {e}")
        
        return deleted