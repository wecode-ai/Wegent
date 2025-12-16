#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, Optional, List
import os
import gitlab
from shared.logger import setup_logger
from shared.utils.crypto import is_token_encrypted, decrypt_git_token

logger = setup_logger("agno_gitlab_tool_manager")


class GitLabToolManager:
    """
    Manages GitLab API tools for Agno Agent
    Provides tools to read files, list branches, and access GitLab repository code
    """
    
    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize GitLab Tool Manager
        
        Args:
            task_data: Task data dictionary containing GitLab configuration
        """
        self.task_data = task_data
        self.gitlab_client: Optional[gitlab.Gitlab] = None
        self.git_domain = task_data.get("git_domain")
        self.git_repo_id = task_data.get("git_repo_id")
        self.branch_name = task_data.get("branch_name", "main")
        self._initialize_client()
    
    def _initialize_client(self) -> None:
        """
        Initialize GitLab client using credentials from task_data
        Reuses the same logic as backend/app/repository/gitlab_provider.py::_get_git_infos
        """
        if not self.git_domain:
            logger.warning("No git_domain provided, GitLab tools will not be available")
            return
        
        try:
            # Get GitLab token from user config
            # In executor context, git_token and git_domain are directly in user_config top level
            user_config = self.task_data.get("user", {})
            git_token = None
            
            # Directly read from user_config top level (executor context)
            user_domain = user_config.get("git_domain", "")
            if user_domain == self.git_domain:
                git_token = user_config.get("git_token", "")
            
            # If not found, try git_info list (backend style, fallback)
            if not git_token:
                git_info_list = user_config.get("git_info", [])
                for info in git_info_list:
                    info_type = info.get("type", "").lower()
                    info_domain = info.get("git_domain", "")
                    if info_type == "gitlab" and info_domain == self.git_domain:
                        git_token = info.get("git_token", "")
                        break
            
            # If still not found, try to read from file system (fallback)
            if not git_token:
                token_path = os.path.expanduser(f"~/.ssh/{self.git_domain}")
                if os.path.exists(token_path):
                    try:
                        with open(token_path, "r", encoding="utf-8") as f:
                            token = f.read().strip()
                            if is_token_encrypted(token):
                                git_token = decrypt_git_token(token)
                            else:
                                git_token = token
                    except Exception as e:
                        logger.warning(f"Failed to read token from {token_path}: {e}")
            
            # Process token if found
            if git_token and git_token != "***":
                if is_token_encrypted(git_token):
                    git_token = decrypt_git_token(git_token)
            
            if not git_token:
                logger.warning(f"No valid token found for {self.git_domain}, GitLab tools will not be available")
                return
            
            # Construct GitLab URL
            gitlab_url = f"https://{self.git_domain}" if not self.git_domain.startswith("http") else self.git_domain
            
            # Initialize GitLab client
            self.gitlab_client = gitlab.Gitlab(gitlab_url, private_token=git_token)
            if self.gitlab_client:
                self.gitlab_client.auth()
            else:
                logger.error(f"Failed to create GitLab client for domain: {self.git_domain}")
                self.gitlab_client = None
        except Exception as e:
            logger.error(f"Failed to initialize GitLab client: {str(e)}")
            self.gitlab_client = None
    
    def _get_project(self):
        """
        Get GitLab project instance
        
        Returns:
            GitLab project instance or None
        """
        if not self.gitlab_client or not self.git_repo_id:
            return None
        
        try:
            return self.gitlab_client.projects.get(self.git_repo_id)
        except Exception as e:
            logger.error(f"Failed to get GitLab project {self.git_repo_id}: {str(e)}")
            return None
    
    def read_gitlab_file(self, file_path: str, branch: Optional[str] = None) -> str:
        """
        Read a file from GitLab repository
        
        Args:
            file_path: Path to the file in the repository
            branch: Branch name (defaults to task_data branch_name)
            
        Returns:
            File content as string, or error message starting with "Error:" if failed
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get GitLab project {self.git_repo_id}"
            
            branch = branch or self.branch_name
            file_content = project.files.get(file_path, ref=branch)
            
            # Decode file content
            import base64
            content = base64.b64decode(file_content.content).decode('utf-8')
            return content
        except gitlab.exceptions.GitlabGetError as e:
            error_msg = f"Error: Failed to read file {file_path} from GitLab branch {branch}: {str(e)}"
            logger.error(error_msg)
            return error_msg
        except Exception as e:
            error_msg = f"Error: Unexpected error reading file {file_path} from GitLab: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def list_gitlab_branches(self) -> str:
        """
        List all branches in the GitLab repository
        
        Returns:
            Comma-separated list of branch names, or error message starting with "Error:" if failed
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get GitLab project {self.git_repo_id}"
            
            branches = project.branches.list()
            branch_names = [branch.name for branch in branches]
            return ", ".join(branch_names)
        except Exception as e:
            error_msg = f"Error: Failed to list GitLab branches: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def list_gitlab_files(self, directory_path: str = "", branch: Optional[str] = None) -> str:
        """
        List files in a directory from GitLab repository
        
        Args:
            directory_path: Directory path (empty string for root)
            branch: Branch name (defaults to task_data branch_name)
            
        Returns:
            Newline-separated list of file paths, or error message starting with "Error:" if failed
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get GitLab project {self.git_repo_id}"
            
            branch = branch or self.branch_name
            items = project.repository_tree(path=directory_path, ref=branch, recursive=False)
            
            file_list = []
            for item in items:
                item_type = "📁" if item['type'] == 'tree' else "📄"
                file_list.append(f"{item_type} {item['path']}")
            
            return "\n".join(file_list) if file_list else "Directory is empty"
        except Exception as e:
            error_msg = f"Error: Failed to list files in GitLab directory {directory_path}: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def get_gitlab_file_info(self, file_path: str, branch: Optional[str] = None) -> str:
        """
        Get file information (size, last commit, etc.) from GitLab repository
        
        Args:
            file_path: Path to the file in the repository
            branch: Branch name (defaults to task_data branch_name)
            
        Returns:
            File information as string
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get project {self.git_repo_id}"
            
            branch = branch or self.branch_name
            commits = project.commits.list(path=file_path, ref_name=branch, per_page=1)
            
            if commits:
                commit = commits[0]
                info = f"File: {file_path}\n"
                info += f"Last commit: {commit.id[:8]} by {commit.author_name}\n"
                info += f"Date: {commit.committed_date}\n"
                info += f"Message: {commit.message}"
                return info
            else:
                return f"No commit history found for {file_path}"
        except Exception as e:
            error_msg = f"Error getting file info for {file_path}: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def create_gitlab_branch(self, branch_name: str, source_branch: Optional[str] = None) -> str:
        """
        Create a new branch in GitLab repository
        
        Args:
            branch_name: Name of the new branch to create
            source_branch: Source branch name (defaults to task_data branch_name or 'main')
            
        Returns:
            Success message or error message
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get project {self.git_repo_id}"
            
            source_branch = source_branch or self.branch_name or "main"
            
            # Create branch
            branch = project.branches.create({
                'branch': branch_name,
                'ref': source_branch
            })
            
            return f"Successfully created branch '{branch_name}' from '{source_branch}'. Branch URL: {branch.web_url if hasattr(branch, 'web_url') else 'N/A'}"
        except gitlab.exceptions.GitlabCreateError as e:
            error_msg = f"Error creating branch {branch_name}: {str(e)}"
            logger.error(error_msg)
            return error_msg
        except Exception as e:
            error_msg = f"Unexpected error creating branch {branch_name}: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def create_gitlab_merge_request(self, source_branch: str, target_branch: str, title: str, description: str = "") -> str:
        """
        Create a merge request (MR) in GitLab repository
        
        Args:
            source_branch: Source branch name
            target_branch: Target branch name (usually 'main' or 'master')
            title: MR title
            description: MR description (optional)
            
        Returns:
            MR information or error message
        """
        if not self.gitlab_client:
            return "Error: GitLab client not initialized"
        
        try:
            project = self._get_project()
            if not project:
                return f"Error: Failed to get project {self.git_repo_id}"
            
            # Create merge request
            mr = project.mergerequests.create({
                'source_branch': source_branch,
                'target_branch': target_branch,
                'title': title,
                'description': description
            })
            
            return f"Successfully created merge request:\nMR ID: {mr.iid}\nTitle: {mr.title}\nURL: {mr.web_url}\nStatus: {mr.state}"
        except gitlab.exceptions.GitlabCreateError as e:
            error_msg = f"Error creating merge request: {str(e)}"
            logger.error(error_msg)
            return error_msg
        except Exception as e:
            error_msg = f"Unexpected error creating merge request: {str(e)}"
            logger.error(error_msg)
            return error_msg
    
    def create_tools(self) -> List[Any]:
        """
        Create Agno SDK compatible tools for GitLab operations
        
        Returns:
            List of tool functions that can be added to AgnoSdkAgent
        """
        if not self.gitlab_client:
            logger.warning("GitLab client not available, skipping GitLab tools creation")
            return []
        
        # Create tool functions with proper annotations for Agno SDK
        # Agno SDK expects functions with type hints and docstrings
        tools = []
        
        # Read file tool
        def read_file(file_path: str, branch: Optional[str] = None) -> str:
            """Read a file from GitLab repository.
            
            Args:
                file_path: Path to the file in the repository (e.g., 'src/main.py')
                branch: Optional branch name (defaults to current branch)
            
            Returns:
                File content as string, or error message starting with "Error:" if failed
            """
            return self.read_gitlab_file(file_path, branch)
        
        # List branches tool
        def list_branches() -> str:
            """List all branches in the GitLab repository.
            
            Returns:
                Comma-separated list of branch names, or error message starting with "Error:" if failed
            """
            return self.list_gitlab_branches()
        
        # List files tool
        def list_files(directory_path: str = "", branch: Optional[str] = None) -> str:
            """List files and directories in a GitLab repository path.
            
            Args:
                directory_path: Directory path (empty string for root, e.g., 'src/')
                branch: Optional branch name (defaults to current branch)
            
            Returns:
                Newline-separated list of files and directories, or error message starting with "Error:" if failed
            """
            return self.list_gitlab_files(directory_path, branch)
        
        # Get file info tool
        def get_file_info(file_path: str, branch: Optional[str] = None) -> str:
            """Get file information (last commit, author, etc.) from GitLab repository.
            
            Args:
                file_path: Path to the file in the repository
                branch: Optional branch name (defaults to current branch)
            
            Returns:
                File information as string
            """
            return self.get_gitlab_file_info(file_path, branch)
        
        # Create branch tool
        def create_branch(branch_name: str, source_branch: Optional[str] = None) -> str:
            """Create a new branch in GitLab repository.
            
            Args:
                branch_name: Name of the new branch to create (e.g., 'feature/new-feature')
                source_branch: Source branch name (defaults to current branch or 'main')
            
            Returns:
                Success message with branch information or error message
            """
            return self.create_gitlab_branch(branch_name, source_branch)
        
        # Create merge request tool
        def create_merge_request(source_branch: str, target_branch: str, title: str, description: str = "") -> str:
            """Create a merge request (MR) in GitLab repository.
            
            Args:
                source_branch: Source branch name (e.g., 'feature/new-feature')
                target_branch: Target branch name (usually 'main', 'master', or 'develop')
                title: MR title
                description: MR description (optional)
            
            Returns:
                MR information (ID, URL, status) or error message
            """
            return self.create_gitlab_merge_request(source_branch, target_branch, title, description)
        
        tools.extend([read_file, list_branches, list_files, get_file_info, create_branch, create_merge_request])
        return tools

