#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Worktree Manager - Manages Git worktrees.

Git worktrees allow multiple working directories to share the same repository,
enabling parallel development on different branches without duplicating the
entire repository.
"""

import os
import subprocess
import shutil
from typing import Optional, Tuple, List, Dict, Any
from dataclasses import dataclass

from shared.logger import setup_logger

logger = setup_logger("worktree_manager")


@dataclass
class WorktreeInfo:
    """Information about a Git worktree."""
    path: str
    branch: str
    commit: str
    is_bare: bool = False
    is_detached: bool = False


class WorktreeManager:
    """
    Manages Git worktrees for bare repositories.
    
    Worktrees are created in feature directories and linked to bare repositories.
    """
    
    def __init__(self):
        """Initialize the worktree manager."""
        pass
    
    def create_worktree(
        self,
        bare_repo_path: str,
        worktree_path: str,
        branch_name: str,
        create_branch: bool = True,
        base_branch: str = "main"
    ) -> Tuple[bool, Optional[str]]:
        """
        Create a new worktree from a bare repository.
        
        Args:
            bare_repo_path: Path to the bare repository
            worktree_path: Path where the worktree will be created
            branch_name: Name of the branch to checkout
            create_branch: Whether to create the branch if it doesn't exist
            base_branch: Base branch for creating new branch (default: main)
            
        Returns:
            Tuple of (success, error_message)
        """
        # Ensure parent directory exists
        os.makedirs(os.path.dirname(worktree_path), exist_ok=True)
        
        # Check if worktree already exists
        if os.path.exists(worktree_path):
            logger.info(f"Worktree already exists at {worktree_path}")
            return True, None
        
        # Check if branch exists
        branch_exists = self._branch_exists(bare_repo_path, branch_name)
        
        try:
            if branch_exists:
                # Checkout existing branch
                cmd = [
                    "git", "-C", bare_repo_path,
                    "worktree", "add", worktree_path, branch_name
                ]
            elif create_branch:
                # Create new branch and worktree
                # First, find a valid base
                base_ref = self._find_base_ref(bare_repo_path, base_branch)
                if not base_ref:
                    return False, f"Could not find base branch: {base_branch}"
                
                cmd = [
                    "git", "-C", bare_repo_path,
                    "worktree", "add", "-b", branch_name, worktree_path, base_ref
                ]
            else:
                return False, f"Branch {branch_name} does not exist and create_branch is False"
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120
            )
            
            if result.returncode != 0:
                error_msg = result.stderr or "Unknown error creating worktree"
                logger.error(f"Failed to create worktree: {error_msg}")
                return False, error_msg
            
            logger.info(f"Created worktree at {worktree_path} for branch {branch_name}")
            return True, None
            
        except subprocess.TimeoutExpired:
            return False, "Worktree creation timed out"
        except Exception as e:
            return False, str(e)
    
    def _branch_exists(self, bare_repo_path: str, branch_name: str) -> bool:
        """Check if a branch exists in the repository."""
        try:
            # Check local branch
            result = subprocess.run(
                ["git", "-C", bare_repo_path, "rev-parse", "--verify", f"refs/heads/{branch_name}"],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                return True
            
            # Check remote branch
            result = subprocess.run(
                ["git", "-C", bare_repo_path, "rev-parse", "--verify", f"refs/remotes/origin/{branch_name}"],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.returncode == 0
            
        except Exception:
            return False
    
    def _find_base_ref(self, bare_repo_path: str, base_branch: str) -> Optional[str]:
        """Find a valid base reference for creating a new branch."""
        candidates = [
            f"refs/heads/{base_branch}",
            f"refs/remotes/origin/{base_branch}",
            "refs/heads/main",
            "refs/remotes/origin/main",
            "refs/heads/master",
            "refs/remotes/origin/master",
        ]
        
        for ref in candidates:
            try:
                result = subprocess.run(
                    ["git", "-C", bare_repo_path, "rev-parse", "--verify", ref],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if result.returncode == 0:
                    return ref
            except Exception:
                continue
        
        return None
    
    def remove_worktree(
        self,
        bare_repo_path: str,
        worktree_path: str,
        force: bool = False
    ) -> Tuple[bool, Optional[str]]:
        """
        Remove a worktree.
        
        Args:
            bare_repo_path: Path to the bare repository
            worktree_path: Path to the worktree to remove
            force: Force removal even if there are uncommitted changes
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            cmd = ["git", "-C", bare_repo_path, "worktree", "remove"]
            if force:
                cmd.append("--force")
            cmd.append(worktree_path)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode != 0:
                # If git worktree remove fails, try manual cleanup
                if os.path.exists(worktree_path):
                    shutil.rmtree(worktree_path)
                    # Prune worktree references
                    subprocess.run(
                        ["git", "-C", bare_repo_path, "worktree", "prune"],
                        capture_output=True,
                        timeout=30
                    )
                    logger.info(f"Manually removed worktree at {worktree_path}")
                    return True, None
                return False, result.stderr or "Failed to remove worktree"
            
            logger.info(f"Removed worktree at {worktree_path}")
            return True, None
            
        except Exception as e:
            # Try manual cleanup on exception
            try:
                if os.path.exists(worktree_path):
                    shutil.rmtree(worktree_path)
                return True, None
            except Exception as cleanup_error:
                return False, f"Failed to remove worktree: {e}, cleanup error: {cleanup_error}"
    
    def list_worktrees(self, bare_repo_path: str) -> List[WorktreeInfo]:
        """
        List all worktrees for a bare repository.
        
        Args:
            bare_repo_path: Path to the bare repository
            
        Returns:
            List of WorktreeInfo objects
        """
        worktrees = []
        
        try:
            result = subprocess.run(
                ["git", "-C", bare_repo_path, "worktree", "list", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                logger.warning(f"Failed to list worktrees: {result.stderr}")
                return worktrees
            
            # Parse porcelain output
            current_worktree: Dict[str, Any] = {}
            for line in result.stdout.strip().split("\n"):
                if not line:
                    if current_worktree:
                        worktrees.append(WorktreeInfo(
                            path=current_worktree.get("worktree", ""),
                            branch=current_worktree.get("branch", "").replace("refs/heads/", ""),
                            commit=current_worktree.get("HEAD", ""),
                            is_bare=current_worktree.get("bare", False),
                            is_detached=current_worktree.get("detached", False)
                        ))
                        current_worktree = {}
                elif line.startswith("worktree "):
                    current_worktree["worktree"] = line[9:]
                elif line.startswith("HEAD "):
                    current_worktree["HEAD"] = line[5:]
                elif line.startswith("branch "):
                    current_worktree["branch"] = line[7:]
                elif line == "bare":
                    current_worktree["bare"] = True
                elif line == "detached":
                    current_worktree["detached"] = True
            
            # Don't forget the last worktree
            if current_worktree:
                worktrees.append(WorktreeInfo(
                    path=current_worktree.get("worktree", ""),
                    branch=current_worktree.get("branch", "").replace("refs/heads/", ""),
                    commit=current_worktree.get("HEAD", ""),
                    is_bare=current_worktree.get("bare", False),
                    is_detached=current_worktree.get("detached", False)
                ))
            
            return worktrees
            
        except Exception as e:
            logger.warning(f"Error listing worktrees: {e}")
            return worktrees
    
    def prune_worktrees(self, bare_repo_path: str) -> Tuple[bool, Optional[str]]:
        """
        Prune stale worktree references.
        
        Args:
            bare_repo_path: Path to the bare repository
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            result = subprocess.run(
                ["git", "-C", bare_repo_path, "worktree", "prune"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                return False, result.stderr or "Failed to prune worktrees"
            
            logger.info(f"Pruned worktrees for {bare_repo_path}")
            return True, None
            
        except Exception as e:
            return False, str(e)
    
    def get_worktree_branch(self, worktree_path: str) -> Optional[str]:
        """
        Get the current branch of a worktree.
        
        Args:
            worktree_path: Path to the worktree
            
        Returns:
            Branch name or None if not found
        """
        try:
            result = subprocess.run(
                ["git", "-C", worktree_path, "rev-parse", "--abbrev-ref", "HEAD"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                return result.stdout.strip()
            return None
            
        except Exception:
            return None
    
    def checkout_branch(
        self,
        worktree_path: str,
        branch_name: str,
        create: bool = False
    ) -> Tuple[bool, Optional[str]]:
        """
        Checkout a branch in a worktree.
        
        Args:
            worktree_path: Path to the worktree
            branch_name: Name of the branch to checkout
            create: Whether to create the branch if it doesn't exist
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            cmd = ["git", "-C", worktree_path, "checkout"]
            if create:
                cmd.append("-b")
            cmd.append(branch_name)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode != 0:
                return False, result.stderr or "Failed to checkout branch"
            
            logger.info(f"Checked out branch {branch_name} in {worktree_path}")
            return True, None
            
        except Exception as e:
            return False, str(e)
    
    def pull_branch(self, worktree_path: str) -> Tuple[bool, Optional[str]]:
        """
        Pull latest changes for the current branch in a worktree.
        
        Args:
            worktree_path: Path to the worktree
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            result = subprocess.run(
                ["git", "-C", worktree_path, "pull", "--ff-only"],
                capture_output=True,
                text=True,
                timeout=120
            )
            
            if result.returncode != 0:
                # Pull failure is not critical for new branches
                logger.warning(f"Pull failed (may be a new branch): {result.stderr}")
                return True, None
            
            logger.info(f"Pulled latest changes in {worktree_path}")
            return True, None
            
        except Exception as e:
            logger.warning(f"Error pulling changes: {e}")
            return True, None  # Non-critical error