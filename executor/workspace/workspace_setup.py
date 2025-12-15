#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Workspace Setup - High-level API for setting up task workspaces.

This module provides the main entry point for setting up workspaces
for tasks, handling both feature-based and task-based workflows.
"""

import os
import json
import shutil
from datetime import datetime
from typing import Optional, Tuple, Dict, Any, List
from dataclasses import dataclass, asdict

from shared.logger import setup_logger
from executor.workspace.feature_manager import FeatureManager
from executor.workspace.repo_manager import RepoManager

logger = setup_logger("workspace_setup")


@dataclass
class TaskMetadata:
    """Metadata for a task workspace."""
    task_id: int
    created_at: str
    feature_name: Optional[str]
    status: str
    prompt: str
    git_url: Optional[str]
    branch_name: Optional[str]


@dataclass
class WorkspaceResult:
    """Result of workspace setup."""
    success: bool
    workspace_path: str
    project_path: Optional[str]
    feature_name: Optional[str]
    error_message: Optional[str]
    is_feature_workspace: bool


class WorkspaceSetup:
    """
    High-level API for setting up task workspaces.
    
    Handles two main scenarios:
    1. Feature-based workspace: When branch_name is provided, creates/uses a feature directory
    2. Task-based workspace: When no branch_name, creates a temporary task directory
    """
    
    TASK_METADATA_FILE = ".task.json"
    
    def __init__(
        self,
        workspace_root: str = "/workspace",
        features_dir: str = "features",
        tasks_dir: str = "tasks",
        repos_dir: str = "repos"
    ):
        """
        Initialize workspace setup.
        
        Args:
            workspace_root: Root directory for all workspaces
            features_dir: Subdirectory name for features
            tasks_dir: Subdirectory name for tasks
            repos_dir: Subdirectory name for bare repositories
        """
        self.workspace_root = workspace_root
        self.features_root = os.path.join(workspace_root, features_dir)
        self.tasks_root = os.path.join(workspace_root, tasks_dir)
        self.repos_root = os.path.join(workspace_root, repos_dir)
        
        # Create directories
        os.makedirs(self.features_root, exist_ok=True)
        os.makedirs(self.tasks_root, exist_ok=True)
        os.makedirs(self.repos_root, exist_ok=True)
        
        # Initialize managers
        self.feature_manager = FeatureManager(self.features_root, self.repos_root)
        self.repo_manager = RepoManager(self.repos_root)
    
    def setup_workspace(
        self,
        task_id: int,
        git_url: Optional[str] = None,
        branch_name: Optional[str] = None,
        feature_branch: Optional[str] = None,
        prompt: str = "",
        git_token: Optional[str] = None,
        git_login: Optional[str] = None,
        additional_repos: Optional[List[Dict[str, str]]] = None
    ) -> WorkspaceResult:
        """
        Setup workspace for a task.
        
        Branch naming convention:
        - branch_name: Source branch to checkout from (e.g., 'develop', 'main')
        - feature_branch: Feature branch name for the workspace directory (e.g., 'feature-123-add-login')
        
        If feature_branch is provided, creates/uses a feature directory with that name.
        If only branch_name is provided (source branch), creates a task-specific directory
        and clones the code from that branch.
        
        Args:
            task_id: Task ID
            git_url: Primary Git repository URL
            branch_name: Source branch to checkout from (e.g., 'develop', 'main')
            feature_branch: Feature branch name for workspace directory (optional)
            prompt: Task prompt/description
            git_token: Git authentication token
            git_login: Git login username
            additional_repos: Additional repositories for cross-repo features
            
        Returns:
            WorkspaceResult with workspace information
        """
        # If feature_branch is provided, use it as the feature directory name
        if feature_branch:
            return self._setup_feature_workspace(
                task_id=task_id,
                feature_name=feature_branch,
                source_branch=branch_name,
                git_url=git_url,
                prompt=prompt,
                git_token=git_token,
                git_login=git_login,
                additional_repos=additional_repos
            )
        else:
            # No feature branch specified, use task workspace
            # branch_name here is the source branch to checkout
            return self._setup_task_workspace(
                task_id=task_id,
                git_url=git_url,
                source_branch=branch_name,
                prompt=prompt,
                git_token=git_token,
                git_login=git_login
            )
    
    def _setup_feature_workspace(
        self,
        task_id: int,
        feature_name: str,
        source_branch: Optional[str],
        git_url: Optional[str],
        prompt: str,
        git_token: Optional[str],
        git_login: Optional[str],
        additional_repos: Optional[List[Dict[str, str]]]
    ) -> WorkspaceResult:
        """
        Setup a feature-based workspace.
        
        Args:
            task_id: Task ID
            feature_name: Feature branch name (used as directory name)
            source_branch: Source branch to create feature branch from (e.g., 'develop', 'main')
            git_url: Git repository URL
            prompt: Task prompt
            git_token: Git authentication token
            git_login: Git login username
            additional_repos: Additional repositories
        """
        try:
            # Build repository list
            repositories = []
            if git_url:
                repositories.append({"git_url": git_url})
            if additional_repos:
                repositories.extend(additional_repos)
            
            if not repositories:
                # No repositories, just create feature directory structure
                feature_path = self.feature_manager.get_feature_path(feature_name)
                os.makedirs(feature_path, exist_ok=True)
                workspace_path = os.path.join(feature_path, "_workspace")
                os.makedirs(workspace_path, exist_ok=True)
                
                return WorkspaceResult(
                    success=True,
                    workspace_path=feature_path,
                    project_path=None,
                    feature_name=feature_name,
                    error_message=None,
                    is_feature_workspace=True
                )
            
            # Create or get feature with repositories
            # Pass source_branch so worktree can be created from the correct base
            success, feature_path, error = self.feature_manager.get_or_create_feature(
                feature_name=feature_name,
                repositories=repositories,
                task_id=task_id,
                git_token=git_token,
                git_login=git_login,
                source_branch=source_branch
            )
            
            if not success:
                return WorkspaceResult(
                    success=False,
                    workspace_path="",
                    project_path=None,
                    feature_name=feature_name,
                    error_message=error,
                    is_feature_workspace=True
                )
            
            # Determine project path (first repository's worktree)
            project_path = None
            if git_url:
                repo_name = self.repo_manager.extract_repo_name(git_url)
                project_path = os.path.join(feature_path, repo_name)
            
            logger.info(f"Setup feature workspace for task {task_id}: {feature_path}")
            
            return WorkspaceResult(
                success=True,
                workspace_path=feature_path,
                project_path=project_path,
                feature_name=feature_name,
                error_message=None,
                is_feature_workspace=True
            )
            
        except Exception as e:
            error_msg = f"Failed to setup feature workspace: {e}"
            logger.error(error_msg)
            return WorkspaceResult(
                success=False,
                workspace_path="",
                project_path=None,
                feature_name=feature_name,
                error_message=error_msg,
                is_feature_workspace=True
            )
    
    def _setup_task_workspace(
        self,
        task_id: int,
        git_url: Optional[str],
        source_branch: Optional[str],
        prompt: str,
        git_token: Optional[str],
        git_login: Optional[str]
    ) -> WorkspaceResult:
        """
        Setup a task-specific temporary workspace.
        
        Args:
            task_id: Task ID
            git_url: Git repository URL
            source_branch: Source branch to checkout (e.g., 'develop', 'main')
            prompt: Task prompt
            git_token: Git authentication token
            git_login: Git login username
        """
        try:
            task_path = os.path.join(self.tasks_root, f"task-{task_id}")
            workspace_path = os.path.join(task_path, "_workspace")
            
            os.makedirs(task_path, exist_ok=True)
            os.makedirs(workspace_path, exist_ok=True)
            
            # Save task metadata
            # Note: branch_name here stores the source branch for reference
            metadata = TaskMetadata(
                task_id=task_id,
                created_at=datetime.now().isoformat(),
                feature_name=None,
                status="running",
                prompt=prompt,
                git_url=git_url,
                branch_name=source_branch  # Store source branch for reference
            )
            self._save_task_metadata(task_path, metadata)
            
            # If git_url provided, clone to task directory (traditional way)
            project_path = None
            if git_url:
                repo_name = self.repo_manager.extract_repo_name(git_url)
                project_path = os.path.join(task_path, repo_name)
                
                # Clone repository (not as bare, traditional clone)
                # Use source_branch if specified
                if not os.path.exists(project_path):
                    success, error = self._clone_repo(
                        git_url, project_path, git_token, git_login, source_branch
                    )
                    if not success:
                        logger.warning(f"Failed to clone repo: {error}")
            
            logger.info(f"Setup task workspace for task {task_id}: {task_path}")
            
            return WorkspaceResult(
                success=True,
                workspace_path=task_path,
                project_path=project_path,
                feature_name=None,
                error_message=None,
                is_feature_workspace=False
            )
            
        except Exception as e:
            error_msg = f"Failed to setup task workspace: {e}"
            logger.error(error_msg)
            return WorkspaceResult(
                success=False,
                workspace_path="",
                project_path=None,
                feature_name=None,
                error_message=error_msg,
                is_feature_workspace=False
            )
    
    def _clone_repo(
        self,
        git_url: str,
        target_path: str,
        git_token: Optional[str],
        git_login: Optional[str],
        branch: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        Clone a repository (traditional clone, not bare).
        
        Args:
            git_url: Git repository URL
            target_path: Target directory path
            git_token: Git authentication token
            git_login: Git login username
            branch: Branch to checkout (source branch)
        """
        import subprocess
        from shared.utils.crypto import is_token_encrypted, decrypt_git_token
        
        # Build authenticated URL
        clone_url = git_url
        if git_token:
            if is_token_encrypted(git_token):
                git_token = decrypt_git_token(git_token) or git_token
            
            login = git_login or "oauth2"
            if git_url.startswith("https://"):
                clone_url = git_url.replace("https://", f"https://{login}:{git_token}@", 1)
            elif git_url.startswith("http://"):
                clone_url = git_url.replace("http://", f"http://{login}:{git_token}@", 1)
        
        try:
            # Build clone command with optional branch
            cmd = ["git", "clone"]
            if branch:
                cmd.extend(["-b", branch])
            cmd.extend([clone_url, target_path])
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600
            )
            
            if result.returncode != 0:
                return False, result.stderr or "Clone failed"
            
            return True, None
            
        except Exception as e:
            return False, str(e)
    
    def convert_task_to_feature(
        self,
        task_id: int,
        feature_name: str,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None
    ) -> WorkspaceResult:
        """
        Convert a task workspace to a feature workspace.
        
        This is called when Claude decides on a branch name for a task
        that was initially created without one.
        
        Args:
            task_id: Task ID
            feature_name: Feature/branch name to use
            git_token: Git authentication token
            git_login: Git login username
            
        Returns:
            WorkspaceResult with new workspace information
        """
        task_path = os.path.join(self.tasks_root, f"task-{task_id}")
        
        if not os.path.exists(task_path):
            return WorkspaceResult(
                success=False,
                workspace_path="",
                project_path=None,
                feature_name=feature_name,
                error_message=f"Task workspace not found: {task_path}",
                is_feature_workspace=False
            )
        
        try:
            # Load task metadata
            metadata = self._load_task_metadata(task_path)
            if not metadata:
                return WorkspaceResult(
                    success=False,
                    workspace_path="",
                    project_path=None,
                    feature_name=feature_name,
                    error_message="Task metadata not found",
                    is_feature_workspace=False
                )
            
            # Build repository list from task
            repositories = []
            if metadata.git_url:
                repositories.append({"git_url": metadata.git_url})
            
            # Create feature workspace
            # Use the stored source branch as the base for the new feature branch
            result = self._setup_feature_workspace(
                task_id=task_id,
                feature_name=feature_name,
                source_branch=metadata.branch_name,  # Use stored source branch
                git_url=metadata.git_url,
                prompt=metadata.prompt,
                git_token=git_token,
                git_login=git_login,
                additional_repos=None
            )
            
            if result.success:
                # Update task metadata
                metadata.feature_name = feature_name
                metadata.branch_name = feature_name
                self._save_task_metadata(task_path, metadata)
                
                logger.info(f"Converted task {task_id} to feature {feature_name}")
            
            return result
            
        except Exception as e:
            error_msg = f"Failed to convert task to feature: {e}"
            logger.error(error_msg)
            return WorkspaceResult(
                success=False,
                workspace_path="",
                project_path=None,
                feature_name=feature_name,
                error_message=error_msg,
                is_feature_workspace=False
            )
    
    def cleanup_task_workspace(self, task_id: int) -> bool:
        """
        Clean up a task workspace.
        
        Args:
            task_id: Task ID
            
        Returns:
            True if cleaned up successfully
        """
        task_path = os.path.join(self.tasks_root, f"task-{task_id}")
        
        try:
            if os.path.exists(task_path):
                shutil.rmtree(task_path)
                logger.info(f"Cleaned up task workspace: {task_path}")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to cleanup task workspace: {e}")
            return False
    
    def cleanup_old_task_workspaces(self, max_age_hours: int = 24) -> List[int]:
        """
        Clean up old task workspaces.
        
        Args:
            max_age_hours: Maximum age in hours before cleanup
            
        Returns:
            List of cleaned up task IDs
        """
        cleaned = []
        now = datetime.now()
        
        if not os.path.exists(self.tasks_root):
            return cleaned
        
        for name in os.listdir(self.tasks_root):
            if not name.startswith("task-"):
                continue
            
            task_path = os.path.join(self.tasks_root, name)
            metadata = self._load_task_metadata(task_path)
            
            if metadata:
                try:
                    created = datetime.fromisoformat(metadata.created_at)
                    age_hours = (now - created).total_seconds() / 3600
                    
                    if age_hours > max_age_hours:
                        if self.cleanup_task_workspace(metadata.task_id):
                            cleaned.append(metadata.task_id)
                except Exception as e:
                    logger.warning(f"Error checking task age: {e}")
        
        return cleaned
    
    def _save_task_metadata(self, task_path: str, metadata: TaskMetadata) -> None:
        """Save task metadata to file."""
        metadata_path = os.path.join(task_path, self.TASK_METADATA_FILE)
        with open(metadata_path, "w") as f:
            json.dump(asdict(metadata), f, indent=2)
    
    def _load_task_metadata(self, task_path: str) -> Optional[TaskMetadata]:
        """Load task metadata from file."""
        metadata_path = os.path.join(task_path, self.TASK_METADATA_FILE)
        
        if not os.path.exists(metadata_path):
            return None
        
        try:
            with open(metadata_path, "r") as f:
                data = json.load(f)
                return TaskMetadata(**data)
        except Exception as e:
            logger.warning(f"Failed to load task metadata: {e}")
            return None
    
    def get_workspace_info(self, task_id: int) -> Optional[Dict[str, Any]]:
        """
        Get information about a task's workspace.
        
        Args:
            task_id: Task ID
            
        Returns:
            Dictionary with workspace information or None
        """
        # Check task workspace first
        task_path = os.path.join(self.tasks_root, f"task-{task_id}")
        if os.path.exists(task_path):
            metadata = self._load_task_metadata(task_path)
            if metadata:
                return {
                    "type": "task",
                    "path": task_path,
                    "task_id": task_id,
                    "feature_name": metadata.feature_name,
                    "git_url": metadata.git_url,
                    "branch_name": metadata.branch_name
                }
        
        # Check if task is associated with a feature
        for feature_info in self.feature_manager.list_features():
            feature_metadata = self.feature_manager.get_feature_info(feature_info["name"])
            if feature_metadata and task_id in feature_metadata.tasks:
                return {
                    "type": "feature",
                    "path": feature_info["path"],
                    "task_id": task_id,
                    "feature_name": feature_info["name"],
                    "repositories": feature_metadata.repositories
                }
        
        return None


# Convenience function for backward compatibility
def setup_workspace_for_task(task_data: Dict[str, Any]) -> WorkspaceResult:
    """
    Setup workspace for a task using task_data dictionary.
    
    This is a convenience function that extracts parameters from task_data
    and calls WorkspaceSetup.setup_workspace().
    
    Branch naming convention in task_data:
    - branch_name: Source branch to checkout from (e.g., 'develop', 'main')
    - feature_branch: Feature branch name for workspace directory (optional)
    
    Args:
        task_data: Task data dictionary
        
    Returns:
        WorkspaceResult with workspace information
    """
    task_id = task_data.get("task_id", -1)
    git_url = task_data.get("git_url")
    # branch_name is the source branch (e.g., 'develop', 'main')
    branch_name = task_data.get("branch_name")
    # feature_branch is the feature branch name for workspace directory (optional)
    feature_branch = task_data.get("feature_branch")
    prompt = task_data.get("prompt", "")
    
    user_config = task_data.get("user", {})
    git_token = user_config.get("git_token")
    git_login = user_config.get("git_login")
    
    # Check for additional repositories (for cross-repo features)
    additional_repos = task_data.get("additional_repos")
    
    setup = WorkspaceSetup()
    return setup.setup_workspace(
        task_id=task_id,
        git_url=git_url,
        branch_name=branch_name,
        feature_branch=feature_branch,
        prompt=prompt,
        git_token=git_token,
        git_login=git_login,
        additional_repos=additional_repos
    )