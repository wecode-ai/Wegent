# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Common API client utilities for executor services.

This module provides shared HTTP client functionality for making
authenticated API calls to the Backend, including:
- ApiClient: Base class for authenticated HTTP requests
- SkillDownloader: Download and deploy skills from Backend API
- fetch_task_skills: Fetch skills list for a task

All services that need to call Backend API should use these utilities.
"""

import io
import logging
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import requests

from executor.config import config

logger = logging.getLogger(__name__)


def get_api_base_url() -> str:
    """Get API base URL based on executor mode.

    In local mode, use WEGENT_BACKEND_URL.
    In docker mode, use TASK_API_DOMAIN or default to http://wegent-backend:8000.
    """
    if config.EXECUTOR_MODE == "local":
        return config.WEGENT_BACKEND_URL.rstrip("/")
    return os.getenv("TASK_API_DOMAIN", "http://wegent-backend:8000").rstrip("/")


class ApiClient:
    """Base API client for authenticated HTTP requests to Backend.

    This class provides common HTTP request methods with authentication
    headers and error handling. All executor services that need to call
    Backend API should use this class or its subclasses.

    Example:
        client = ApiClient(auth_token="xxx")
        response = client.get("/api/v1/tasks/123/skills")
        if response:
            skills = response.json()
    """

    DEFAULT_TIMEOUT = 30  # seconds

    def __init__(self, auth_token: str):
        """Initialize API client.

        Args:
            auth_token: JWT token for authenticated API calls
        """
        self.auth_token = auth_token
        self.api_base_url = get_api_base_url()
        self.headers = {"Authorization": f"Bearer {auth_token}"}

    def get(
        self,
        path: str,
        timeout: int = DEFAULT_TIMEOUT,
        **kwargs,
    ) -> Optional[requests.Response]:
        """Make GET request to Backend API.

        Args:
            path: API path (e.g., "/api/v1/tasks/123/skills")
            timeout: Request timeout in seconds
            **kwargs: Additional arguments passed to requests.get()

        Returns:
            Response object if successful (status 200), None otherwise
        """
        url = f"{self.api_base_url}{path}"
        try:
            response = requests.get(
                url, headers=self.headers, timeout=timeout, **kwargs
            )
            if response.status_code == 200:
                return response
            logger.warning(f"[ApiClient] GET {path} failed: HTTP {response.status_code}")
            return None
        except requests.exceptions.Timeout:
            logger.warning(f"[ApiClient] GET {path} timeout")
            return None
        except requests.exceptions.RequestException as e:
            logger.error(f"[ApiClient] GET {path} error: {e}")
            return None


@dataclass
class TaskSkillsInfo:
    """Information about skills for a task."""

    task_id: int
    team_id: Optional[int]
    team_namespace: str
    skills: List[str]
    preload_skills: List[str]


def fetch_task_skills(task_id: str, auth_token: str) -> TaskSkillsInfo:
    """Fetch task-associated skills via Backend API.

    Calls GET /api/v1/tasks/{task_id}/skills to get skills for the task.

    Args:
        task_id: Task ID
        auth_token: API auth token

    Returns:
        TaskSkillsInfo with skills list and team namespace
    """
    default_result = TaskSkillsInfo(
        task_id=int(task_id) if str(task_id).isdigit() else -1,
        team_id=None,
        team_namespace="default",
        skills=[],
        preload_skills=[],
    )

    if not auth_token or not task_id:
        logger.warning(
            f"[fetch_task_skills] Missing required params: "
            f"auth_token={'present' if auth_token else 'missing'}, task_id={task_id}"
        )
        return default_result

    try:
        logger.info(
            f"[fetch_task_skills] Calling API for task {task_id}, "
            f"auth_token={'present' if auth_token else 'missing'}"
        )
        client = ApiClient(auth_token)
        logger.info(f"[fetch_task_skills] API base URL: {client.api_base_url}")

        response = client.get(f"/api/tasks/{task_id}/skills")

        if response:
            data = response.json()
            logger.info(
                f"[fetch_task_skills] Fetched skills for task {task_id}: "
                f"skills={data.get('skills', [])}, "
                f"preload_skills={data.get('preload_skills', [])}"
            )
            return TaskSkillsInfo(
                task_id=data.get("task_id", int(task_id) if str(task_id).isdigit() else -1),
                team_id=data.get("team_id"),
                team_namespace=data.get("team_namespace", "default"),
                skills=data.get("skills", []),
                preload_skills=data.get("preload_skills", []),
            )
        else:
            logger.warning(f"[fetch_task_skills] API returned no response for task {task_id}")
        return default_result

    except Exception as e:
        logger.error(f"[fetch_task_skills] Error: {e}")
        return default_result


@dataclass
class SkillDownloadResult:
    """Result of skill download operation."""

    success_count: int
    total_count: int
    skills_dir: str


class SkillDownloader:
    """Download and deploy skills from Backend API.

    This class handles downloading skill ZIP packages from Backend
    and extracting them to the skills directory.

    Example:
        downloader = SkillDownloader(
            auth_token="xxx",
            team_namespace="my-team",
            skills_dir="~/.claude/skills"
        )
        result = downloader.download_and_deploy(["skill1", "skill2"])
    """

    QUERY_TIMEOUT = 30  # seconds
    DOWNLOAD_TIMEOUT = 60  # seconds

    def __init__(
        self,
        auth_token: str,
        team_namespace: str = "default",
        skills_dir: Optional[str] = None,
    ):
        """Initialize skill downloader.

        Args:
            auth_token: JWT token for authenticated API calls
            team_namespace: Team namespace for skill lookup
            skills_dir: Directory to deploy skills. Priority:
                        1. Explicit skills_dir parameter
                        2. SKILL_BASE_PATH environment variable + /skills
                        3. Default: ~/.claude/skills
        """
        self.client = ApiClient(auth_token)
        self.team_namespace = team_namespace

        # Determine skills directory
        if skills_dir:
            self.skills_dir = skills_dir
        else:
            skill_base_path = os.getenv("SKILL_BASE_PATH")
            if skill_base_path:
                self.skills_dir = os.path.join(skill_base_path, "skills")
            else:
                # Use default path and set environment variable for other modules
                default_base = os.path.expanduser("~/.claude")
                os.environ["SKILL_BASE_PATH"] = default_base
                self.skills_dir = os.path.join(default_base, "skills")

    def download_and_deploy(
        self,
        skills: List[str],
        clear_cache: bool = True,
        skip_existing: bool = False,
    ) -> SkillDownloadResult:
        """Download and deploy skills to skills directory.

        Args:
            skills: List of skill names to download
            clear_cache: If True, clear skills directory before download (Docker mode)
            skip_existing: If True, skip skills that already exist (Local mode)

        Returns:
            SkillDownloadResult with success count and directory path
        """
        if not skills:
            logger.debug("[SkillDownloader] No skills to deploy")
            return SkillDownloadResult(0, 0, self.skills_dir)

        logger.info(f"[SkillDownloader] Deploying {len(skills)} skills: {skills}")

        # Filter out existing skills if skip_existing is True
        skills_to_download = skills
        if skip_existing:
            skills_to_download = []
            for skill_name in skills:
                skill_path = os.path.join(self.skills_dir, skill_name)
                if os.path.exists(skill_path):
                    logger.info(f"[SkillDownloader] Skill '{skill_name}' exists, skipping")
                else:
                    skills_to_download.append(skill_name)

            if not skills_to_download:
                logger.info("[SkillDownloader] All required skills already exist")
                return SkillDownloadResult(len(skills), len(skills), self.skills_dir)

        # Handle cache clearing
        if clear_cache and not skip_existing:
            self._clear_skills_dir(skills_to_download)

        # Ensure skills directory exists
        Path(self.skills_dir).mkdir(parents=True, exist_ok=True)

        # Download each skill
        success_count = 0
        for skill_name in skills_to_download:
            if self._download_single_skill(skill_name):
                success_count += 1

        if success_count > 0:
            logger.info(
                f"[SkillDownloader] Deployed {success_count}/{len(skills_to_download)} "
                f"skills to {self.skills_dir}"
            )
        else:
            logger.warning("[SkillDownloader] No skills were successfully deployed")

        return SkillDownloadResult(success_count, len(skills_to_download), self.skills_dir)

    def _clear_skills_dir(self, skills_to_replace: List[str]) -> None:
        """Clear skills directory or specific skills.

        Args:
            skills_to_replace: List of skill names that will be replaced
        """
        import shutil

        if config.SKILL_CLEAR_CACHE:
            # Clear entire skills directory
            if os.path.exists(self.skills_dir):
                shutil.rmtree(self.skills_dir)
                logger.info(f"[SkillDownloader] Cleared skills directory: {self.skills_dir}")
        else:
            # Only clear skills that will be replaced
            for skill_name in skills_to_replace:
                skill_path = os.path.join(self.skills_dir, skill_name)
                if os.path.exists(skill_path):
                    shutil.rmtree(skill_path)
                    logger.info(f"[SkillDownloader] Removed skill for replacement: {skill_name}")

    def _download_single_skill(self, skill_name: str) -> bool:
        """Download and extract a single skill.

        Args:
            skill_name: Name of the skill to download

        Returns:
            True if successful, False otherwise
        """
        try:
            logger.info(f"[SkillDownloader] Downloading skill: {skill_name}")

            # Query skill by name
            query_path = f"/api/v1/kinds/skills?name={skill_name}&namespace={self.team_namespace}"
            response = self.client.get(query_path, timeout=self.QUERY_TIMEOUT)

            if not response:
                logger.error(f"[SkillDownloader] Failed to query skill '{skill_name}'")
                return False

            skills_data = response.json()
            skill_items = skills_data.get("items", [])

            if not skill_items:
                logger.error(f"[SkillDownloader] Skill '{skill_name}' not found")
                return False

            # Extract skill ID and namespace
            skill_item = skill_items[0]
            skill_id = skill_item.get("metadata", {}).get("labels", {}).get("id")
            skill_namespace = skill_item.get("metadata", {}).get("namespace", "default")

            if not skill_id:
                logger.error(f"[SkillDownloader] Skill '{skill_name}' has no ID")
                return False

            # Download skill ZIP
            download_path = f"/api/v1/kinds/skills/{skill_id}/download?namespace={skill_namespace}"
            response = self.client.get(download_path, timeout=self.DOWNLOAD_TIMEOUT)

            if not response:
                logger.error(f"[SkillDownloader] Failed to download skill '{skill_name}'")
                return False

            # Extract ZIP
            return self._extract_skill_zip(skill_name, response.content)

        except Exception as e:
            logger.warning(f"[SkillDownloader] Failed to download skill '{skill_name}': {e}")
            return False

    def _extract_skill_zip(self, skill_name: str, content: bytes) -> bool:
        """Extract skill ZIP to skills directory.

        Args:
            skill_name: Name of the skill
            content: ZIP file content

        Returns:
            True if successful, False otherwise
        """
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zip_file:
                # Security check: prevent Zip Slip attacks
                for file_info in zip_file.filelist:
                    if file_info.filename.startswith("/") or ".." in file_info.filename:
                        logger.error(
                            f"[SkillDownloader] Unsafe path in ZIP: {file_info.filename}"
                        )
                        return False

                # Extract all files
                zip_file.extractall(self.skills_dir)
                skill_target_dir = os.path.join(self.skills_dir, skill_name)

                if os.path.exists(skill_target_dir) and os.path.isdir(skill_target_dir):
                    logger.info(
                        f"[SkillDownloader] Deployed skill '{skill_name}' to {skill_target_dir}"
                    )
                    return True
                else:
                    logger.error(
                        f"[SkillDownloader] Skill folder '{skill_name}' not found after extraction"
                    )
                    return False

        except zipfile.BadZipFile:
            logger.error(f"[SkillDownloader] Invalid ZIP file for skill '{skill_name}'")
            return False
        except Exception as e:
            logger.error(f"[SkillDownloader] Error extracting skill '{skill_name}': {e}")
            return False
