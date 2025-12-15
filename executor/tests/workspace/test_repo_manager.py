#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Tests for RepoManager class.
"""

import os
import pytest
import tempfile
import shutil
from unittest.mock import patch, MagicMock

from executor.workspace.repo_manager import RepoManager


class TestRepoManager:
    """Test cases for RepoManager."""
    
    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        temp = tempfile.mkdtemp()
        yield temp
        shutil.rmtree(temp, ignore_errors=True)
    
    @pytest.fixture
    def repo_manager(self, temp_dir):
        """Create a RepoManager instance with temp directory."""
        return RepoManager(repos_root=temp_dir)
    
    def test_url_to_bare_path_https(self, repo_manager, temp_dir):
        """Test converting HTTPS URL to bare path."""
        url = "https://github.com/org/repo.git"
        expected = os.path.join(temp_dir, "github.com", "org", "repo.git")
        assert repo_manager.url_to_bare_path(url) == expected
    
    def test_url_to_bare_path_https_without_git_suffix(self, repo_manager, temp_dir):
        """Test converting HTTPS URL without .git suffix."""
        url = "https://github.com/org/repo"
        expected = os.path.join(temp_dir, "github.com", "org", "repo.git")
        assert repo_manager.url_to_bare_path(url) == expected
    
    def test_url_to_bare_path_ssh(self, repo_manager, temp_dir):
        """Test converting SSH URL to bare path."""
        url = "git@github.com:org/repo.git"
        expected = os.path.join(temp_dir, "github.com", "org", "repo.git")
        assert repo_manager.url_to_bare_path(url) == expected
    
    def test_extract_repo_name(self, repo_manager):
        """Test extracting repository name from URL."""
        assert repo_manager.extract_repo_name("https://github.com/org/my-repo.git") == "my-repo"
        assert repo_manager.extract_repo_name("https://github.com/org/my-repo") == "my-repo"
        assert repo_manager.extract_repo_name("git@github.com:org/my-repo.git") == "my-repo"
    
    @patch('subprocess.run')
    def test_ensure_bare_repo_clone(self, mock_run, repo_manager, temp_dir):
        """Test cloning a new bare repository."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        
        git_url = "https://github.com/org/repo.git"
        success, path, error = repo_manager.ensure_bare_repo(git_url)
        
        assert success is True
        assert error is None
        assert "github.com" in path
        
        # Verify git clone was called with --bare
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        assert "git" in call_args
        assert "clone" in call_args
        assert "--bare" in call_args
    
    @patch('subprocess.run')
    def test_ensure_bare_repo_fetch_existing(self, mock_run, repo_manager, temp_dir):
        """Test fetching updates for existing bare repository."""
        # Create fake existing repo
        git_url = "https://github.com/org/existing.git"
        bare_path = repo_manager.url_to_bare_path(git_url)
        os.makedirs(bare_path, exist_ok=True)
        
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        
        success, path, error = repo_manager.ensure_bare_repo(git_url)
        
        assert success is True
        assert error is None
        
        # Verify git fetch was called
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        assert "git" in call_args
        assert "fetch" in call_args
    
    def test_build_authenticated_url_https(self, repo_manager):
        """Test building authenticated URL for HTTPS."""
        url = "https://github.com/org/repo.git"
        token = "test_token"
        login = "test_user"
        
        result = repo_manager._build_authenticated_url(url, token, login)
        
        assert "test_user:test_token@" in result
        assert result.startswith("https://test_user:test_token@github.com")
    
    def test_build_authenticated_url_no_token(self, repo_manager):
        """Test building URL without token returns original."""
        url = "https://github.com/org/repo.git"
        
        result = repo_manager._build_authenticated_url(url, None, None)
        
        assert result == url
    
    @patch('subprocess.run')
    def test_branch_exists_true(self, mock_run, repo_manager, temp_dir):
        """Test checking if branch exists - true case."""
        mock_run.return_value = MagicMock(returncode=0)
        
        bare_path = os.path.join(temp_dir, "test.git")
        os.makedirs(bare_path, exist_ok=True)
        
        result = repo_manager.branch_exists(bare_path, "main")
        
        assert result is True
    
    @patch('subprocess.run')
    def test_branch_exists_false(self, mock_run, repo_manager, temp_dir):
        """Test checking if branch exists - false case."""
        mock_run.return_value = MagicMock(returncode=1)
        
        bare_path = os.path.join(temp_dir, "test.git")
        os.makedirs(bare_path, exist_ok=True)
        
        result = repo_manager.branch_exists(bare_path, "nonexistent")
        
        assert result is False
    
    @patch('subprocess.run')
    def test_create_branch(self, mock_run, repo_manager, temp_dir):
        """Test creating a new branch."""
        # First call for finding base ref, second for creating branch
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="abc123"),  # rev-parse succeeds
            MagicMock(returncode=0, stdout="", stderr="")  # branch creation succeeds
        ]
        
        bare_path = os.path.join(temp_dir, "test.git")
        os.makedirs(bare_path, exist_ok=True)
        
        success, error = repo_manager.create_branch(bare_path, "feature-123", "main")
        
        assert success is True
        assert error is None
    
    def test_delete_repo(self, repo_manager, temp_dir):
        """Test deleting a bare repository."""
        # Create a fake repo directory
        bare_path = os.path.join(temp_dir, "to-delete.git")
        os.makedirs(bare_path, exist_ok=True)
        
        result = repo_manager.delete_repo(bare_path)
        
        assert result is True
        assert not os.path.exists(bare_path)
    
    def test_delete_repo_nonexistent(self, repo_manager, temp_dir):
        """Test deleting a non-existent repository."""
        bare_path = os.path.join(temp_dir, "nonexistent.git")
        
        result = repo_manager.delete_repo(bare_path)
        
        assert result is False