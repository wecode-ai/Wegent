#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Progress State Manager - Unified management of thinking and workbench states
"""
import os
import threading
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

try:
    from git import GitCommandError, InvalidGitRepositoryError, Repo

    GIT_AVAILABLE = True
except ImportError:
    GIT_AVAILABLE = False

from shared.logger import setup_logger
from shared.models.task import ExecutionResult
from shared.status import TaskStatus

logger = setup_logger("progress_state_manager")


class ProgressStateManager:
    """
    Manager for unified management of thinking and workbench states
    Responsibilities:
    1. Manage thinking steps
    2. Manage workbench data
    3. Provide unified progress reporting interface
    """

    def __init__(
        self,
        thinking_manager,
        task_data: Dict[str, Any],
        report_progress_callback: Callable,
        project_path: Optional[str] = None,
    ):
        """
        Initialize the state manager

        Args:
            thinking_manager: ThinkingStepManager instance
            task_data: Task data
            report_progress_callback: Progress reporting callback function
            project_path: Project path (used for getting git diff)
        """
        self.thinking_manager = thinking_manager
        self.task_data = task_data
        self.report_progress_callback = report_progress_callback
        self.project_path = project_path
        self.workbench_data: Optional[Dict[str, Any]] = None
        self.initial_commit_id: Optional[str] = None  # Save commit ID at task start
        self._monitor_timer: Optional[threading.Timer] = (
            None  # Periodic monitoring task
        )
        self._is_monitoring: bool = False  # Monitoring status flag

    def initialize_workbench(self, status: str = "running") -> None:
        """
        Initialize workbench data structure, save initial commit ID, and start periodic monitoring

        Args:
            status: Initial status ("running" | "completed" | "failed")
        """
        self.workbench_data = self._build_workbench_structure(status)

        # Save initial commit ID
        self._save_initial_commit()

        # Start periodic monitoring task
        self._start_monitoring()

        logger.info(f"Initialized workbench data with status: {status}")

    def update_workbench_status(self, status: str, result_value: str = None) -> None:
        """
        Update workbench status

        Args:
            status: New status ("running" | "completed" | "failed")
            result_value: Optional result value for updating summary
        """
        if self.workbench_data is None:
            self.initialize_workbench(status)
        else:
            self.workbench_data["status"] = status
            if status == "completed":
                self.workbench_data["completedTime"] = datetime.now().isoformat()
                self._stop_monitoring()
            if result_value:
                self.workbench_data["summary"] = result_value
            self.workbench_data["lastUpdated"] = datetime.now().isoformat()

            logger.info(f"Updated workbench status to: {status}")

    def report_progress(
        self,
        progress: int,
        status: str,
        message: str,
        include_thinking: bool = True,
        include_workbench: bool = True,
        extra_result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Unified progress reporting method, automatically includes thinking and workbench states

        Args:
            progress: Progress value (0-100)
            status: Task status
            message: Progress message
            include_thinking: Whether to include thinking steps (default True)
            include_workbench: Whether to include workbench data (default True)
            extra_result: Additional result data (optional)
        """
        # Build result dictionary
        result = extra_result.copy() if extra_result else {}

        # Automatically add thinking steps
        if include_thinking and "thinking" not in result:
            result["thinking"] = [
                step.dict() for step in self.thinking_manager.get_thinking_steps()
            ]

        # Automatically add workbench data
        if (
            include_workbench
            and self.workbench_data is not None
            and "workbench" not in result
        ):
            result["workbench"] = self.workbench_data

        # Call the original progress reporting callback
        self.report_progress_callback(progress, status, message, result=result)

    def get_current_state(self) -> Dict[str, Any]:
        """
        Get current complete state (thinking + workbench)

        Returns:
            Dictionary containing thinking and workbench
        """
        result = ExecutionResult(
            thinking=self.thinking_manager.get_thinking_steps()
        ).dict()
        if self.workbench_data is not None:
            result["workbench"] = self.workbench_data
        return result

    def _build_workbench_structure(
        self, status: str = "running", result_value: str = None
    ) -> Dict[str, Any]:
        """
        Build workbench data structure

        Args:
            status: Current task status ("completed" | "running" | "failed")
            result_value: Optional result value for summary

        Returns:
            Dictionary containing workbench structure
        """
        current_time = datetime.now().isoformat()

        # Extract task information from task_data
        user_info = self.task_data.get("user", {})
        bot_info = (
            self.task_data.get("bot", [{}])[0] if self.task_data.get("bot") else {}
        )

        # Determine summary value: prioritize result_value, otherwise use subtask_title or prompt
        summary = ""
        if result_value:
            summary = result_value
        elif self.task_data.get("subtask_title"):
            summary = self.task_data.get("subtask_title")
        elif self.task_data.get("prompt"):
            summary = self.task_data.get("prompt")

        git_domain = self.task_data.get("git_domain", "")
        git_type = "gitlab"  # Default to gitlab
        if git_domain and "github.com" in git_domain.lower():
            git_type = "github"

        workbench = {
            "taskTitle": self.task_data.get("task_title", ""),
            "taskNumber": str(self.task_data.get("task_id", "")),
            "status": status,
            "completedTime": current_time if status == "completed" else "",
            "repository": self.task_data.get("git_repo", ""),
            "branch": self.task_data.get("branch_name", ""),
            "sessions": 1,  # Default to 1 session per task execution
            "premiumRequests": 0,  # Will be updated from actual usage if available
            "lastUpdated": current_time,
            "summary": summary,
            "changes": [],  # Will be populated with actual changes if available
            "originalPrompt": self.task_data.get("prompt", ""),
            "file_changes": [],  # Will be populated with git diff information
            "git_info": {
                "initial_commit_id": "",  # Commit ID at task start
                "initial_commit_message": "",  # Initial commit message
                "task_commits": [],  # List of commits generated during this task
                "source_branch": "",  # Source branch
                "target_branch": "",  # Target branch
            },
            "git_domain": git_domain,
            "git_type": git_type,
        }

        return workbench

    def _save_initial_commit(self) -> None:
        """
        Save commit ID, message, and source branch information at task start to workbench
        """
        if not GIT_AVAILABLE:
            return

        try:
            repo_path = self.project_path
            if not repo_path or not os.path.exists(repo_path):
                return

            repo = Repo(repo_path)
            initial_commit = repo.head.commit
            self.initial_commit_id = initial_commit.hexsha

            # Get source branch (branch at task start)
            source_branch = self.task_data.get("branch_name", "")

            # Save to workbench
            if self.workbench_data:
                self.workbench_data["git_info"][
                    "initial_commit_id"
                ] = self.initial_commit_id
                self.workbench_data["git_info"][
                    "initial_commit_message"
                ] = initial_commit.message.strip()
                self.workbench_data["git_info"]["source_branch"] = source_branch
                # target_branch is initially empty, will be updated in _update_task_commits

            logger.debug(
                f"Saved initial commit: {self.initial_commit_id[:8]} - {initial_commit.message.strip()[:50]}"
            )
            logger.debug(f"Source branch: {source_branch}")
        except Exception as e:
            logger.warning(f"Failed to save initial commit ID: {str(e)}")

    def _update_task_commits(self) -> None:
        """
        Update the list of commits generated during this task and target branch
        Get all commits between initial commit and current HEAD
        """
        if not GIT_AVAILABLE or not self.initial_commit_id or not self.workbench_data:
            return

        try:
            repo_path = self.project_path
            if not repo_path or not os.path.exists(repo_path):
                return

            repo = Repo(repo_path)
            current_commit = repo.head.commit

            # Update target_branch (current branch)
            target_branch = ""
            try:
                target_branch = repo.active_branch.name
            except Exception:
                # detached HEAD state, don't set target_branch
                pass

            # Only set target_branch if it's different from source_branch
            source_branch = self.workbench_data["git_info"].get("source_branch", "")
            if target_branch and target_branch != source_branch:
                self.workbench_data["git_info"]["target_branch"] = target_branch
                logger.debug(f"Updated target branch: {target_branch}")
            else:
                self.workbench_data["git_info"]["target_branch"] = ""

            # If current commit is same as initial commit, no new commits
            if current_commit.hexsha == self.initial_commit_id:
                self.workbench_data["git_info"]["task_commits"] = []
                return

            # Get all commits between initial commit and current commit
            # Use rev_list to get commit list (excluding initial commit itself)
            task_commits = []
            try:
                # Iterate through all commits from next of initial commit to HEAD
                for commit in repo.iter_commits(f"{self.initial_commit_id}..HEAD"):
                    commit_info = {
                        "commit_id": commit.hexsha,
                        "short_id": commit.hexsha[:8],
                        "message": commit.message.strip(),
                        "author": commit.author.name,
                        "author_email": commit.author.email,
                        "committed_date": datetime.fromtimestamp(
                            commit.committed_date
                        ).isoformat(),
                        "stats": {
                            "files_changed": len(commit.stats.files),
                            "insertions": commit.stats.total["insertions"],
                            "deletions": commit.stats.total["deletions"],
                        },
                    }
                    task_commits.append(commit_info)

                # Reverse list to arrange in chronological order (earliest first)
                task_commits.reverse()

                # Build markdown format commit information
                result_value = ""
                if task_commits:
                    commit_lines = []
                    for commit in task_commits:
                        commit_lines.append(f"### commit id: {commit['commit_id']}")
                        commit_lines.append(commit["message"])
                        commit_lines.append("\n---\n")
                    result_value = "\n".join(commit_lines)

                # Get task execution status
                status = "running"
                if self.workbench_data:
                    status = self.workbench_data.get("status", "running")

                self.update_workbench_status(status, result_value)

                self.workbench_data["git_info"]["task_commits"] = task_commits
                logger.debug(
                    f"Updated task commits: {len(task_commits)} new commits since {self.initial_commit_id[:8]}"
                )

            except Exception as e:
                logger.warning(f"Failed to iterate commits: {str(e)}")
                self.workbench_data["git_info"]["task_commits"] = []

        except Exception as e:
            logger.warning(f"Failed to update task commits: {str(e)}")

    def _get_git_file_changes(self) -> List[Dict[str, Any]]:
        """
        Get file changes from git diff (using GitPython SDK)

        Returns:
            List of file change dictionaries with structure:
            {
                "old_path": str,
                "new_path": str,
                "new_file": bool,
                "renamed_file": bool,
                "deleted_file": bool,
                "added_lines": int,
                "removed_lines": int,
                "diff_title": str
            }
        """
        file_changes = []

        if not GIT_AVAILABLE:
            logger.warning(
                "GitPython is not available, skipping file changes detection"
            )
            return file_changes

        try:
            # Get working directory from project_path
            repo_path = self.project_path

            if not repo_path or not os.path.exists(repo_path):
                return file_changes

            # Initialize Git repository object
            try:
                repo = Repo(repo_path)
            except InvalidGitRepositoryError:
                logger.warning(f"Not a valid git repository: {repo_path}")
                return file_changes

            # Get current branch name (for logging)
            try:
                current_branch = repo.active_branch.name
            except Exception:
                current_branch = "HEAD"

            # Get file changes: prioritize initial commit comparison, otherwise use unstaged changes
            if self.initial_commit_id:
                try:
                    # Compare initial commit with current state (including all committed and uncommitted changes)
                    initial_commit = repo.commit(self.initial_commit_id)
                    current_commit = repo.head.commit

                    # Get committed changes (initial_commit..HEAD)
                    committed_diffs = initial_commit.diff(
                        current_commit, create_patch=True
                    )

                    # Get unstaged changes (working tree vs index)
                    unstaged_diffs = repo.index.diff(None, create_patch=True)

                    # Get staged but uncommitted changes (HEAD vs index)
                    # Use diff(None) to get differences between index and working tree, then reverse
                    staged_diffs = repo.index.diff(current_commit, create_patch=True)

                    # Merge all changes (use dictionary for deduplication with file path as key)
                    all_diffs_dict = {}

                    # First add committed changes
                    for diff in committed_diffs:
                        path = diff.b_path if diff.b_path else diff.a_path
                        all_diffs_dict[path] = diff

                    # Then add staged changes (will override committed files with same name)
                    for diff in staged_diffs:
                        path = diff.b_path if diff.b_path else diff.a_path
                        all_diffs_dict[path] = diff

                    # Finally add unstaged changes (highest priority)
                    for diff in unstaged_diffs:
                        path = diff.b_path if diff.b_path else diff.a_path
                        all_diffs_dict[path] = diff

                    diffs = list(all_diffs_dict.values())
                except Exception as e:
                    logger.warning(
                        f"Failed to compare with initial commit: {str(e)}, falling back to unstaged changes"
                    )
                    diffs = repo.index.diff(None, create_patch=True)
            else:
                # No initial commit ID, only get unstaged changes
                diffs = repo.index.diff(None, create_patch=True)
                logger.info(
                    f"No initial commit ID, using unstaged changes only: {len(diffs)} files"
                )

            for diff in diffs:
                # Get file paths
                old_path = diff.a_path if diff.a_path else diff.b_path
                new_path = diff.b_path if diff.b_path else diff.a_path

                # Determine file status
                new_file = diff.new_file
                deleted_file = diff.deleted_file
                renamed_file = diff.renamed_file

                # Calculate added/removed lines
                added_lines = 0
                removed_lines = 0

                if diff.diff:
                    # Parse diff content to count lines
                    diff_text = diff.diff.decode("utf-8", errors="ignore")
                    for line in diff_text.split("\n"):
                        if line.startswith("+") and not line.startswith("+++"):
                            added_lines += 1
                        elif line.startswith("-") and not line.startswith("---"):
                            removed_lines += 1

                # Generate diff title (filename without path)
                diff_title = os.path.basename(new_path)

                file_change = {
                    "old_path": old_path,
                    "new_path": new_path,
                    "new_file": new_file,
                    "renamed_file": renamed_file,
                    "deleted_file": deleted_file,
                    "added_lines": added_lines,
                    "removed_lines": removed_lines,
                    "diff_title": diff_title,
                }

                file_changes.append(file_change)

        except GitCommandError as e:
            logger.warning(f"Git command failed: {str(e)}")
        except Exception as e:
            logger.warning(f"Failed to get git file changes: {str(e)}", exc_info=True)

        return file_changes

    def _start_monitoring(self) -> None:
        """
        Start periodic monitoring task, check git changes every 2 seconds
        """
        if self._is_monitoring:
            logger.warning("Monitoring is already running")
            return

        self._is_monitoring = True
        self._schedule_next_check()
        logger.info("Started git changes monitoring (interval: 2s)")

    def _stop_monitoring(self) -> None:
        """
        Stop periodic monitoring task
        """
        self._is_monitoring = False
        if self._monitor_timer:
            self._monitor_timer.cancel()
            self._monitor_timer = None
        logger.info("Stopped git changes monitoring")

    def _schedule_next_check(self) -> None:
        """
        Schedule next check
        """
        if not self._is_monitoring:
            return

        self._monitor_timer = threading.Timer(2.0, self._check_git_changes)
        self._monitor_timer.daemon = True
        self._monitor_timer.start()

    def _check_git_changes(self) -> None:
        """
        Periodically check git changes and update workbench data
        """
        try:
            if not self._is_monitoring or self.workbench_data is None:
                return

            # Detect file changes
            file_changes = self._get_git_file_changes()
            if file_changes:
                self.workbench_data["file_changes"] = file_changes

            # Detect new commits and branch changes
            self._update_task_commits()

            # Update last check time
            self.workbench_data["lastUpdated"] = datetime.now().isoformat()

        except Exception as e:
            logger.warning(f"Error during git changes check: {str(e)}")
        finally:
            # Schedule next check
            self._schedule_next_check()

    def __del__(self):
        """
        Destructor, ensure monitoring task is stopped
        """
        self._stop_monitoring()
