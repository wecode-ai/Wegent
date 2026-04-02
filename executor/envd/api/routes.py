#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
REST API route handlers for envd
"""

import os
import shutil
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx
import psutil
from fastapi import FastAPI, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse

from shared.logger import setup_logger

from .models import (
    ArchiveRequest,
    ArchiveResponse,
    EntryInfo,
    InitRequest,
    MetricsResponse,
    RestoreRequest,
    RestoreResponse,
)
from .state import AccessTokenAlreadySetError, get_state_manager
from .utils import resolve_path, verify_access_token, verify_signature

logger = setup_logger("envd_api_routes")

# Exclusion patterns for workspace archive
ARCHIVE_EXCLUDE_PATTERNS = [
    "node_modules",
    "__pycache__",
    "*.pyc",
    ".venv",
    "venv",
    "target",
    "build",
    "dist",
    "*.log",
    ".next",
    ".nuxt",
    "vendor",
    ".cache",
]

CLAUDE_HOME_ARCHIVE_PREFIX = "__home__"
CLAUDE_CONFIG_DIR_NAME = ".claude"
CLAUDE_CONFIG_FILE_NAME = ".claude.json"


def get_workspace_path(task_id: int) -> Path:
    """Get task workspace path."""
    return Path(f"/workspace/{task_id}")


def get_home_path() -> Path:
    """Get current user home path."""
    return Path.home()


def extract_tar_members(
    tar: tarfile.TarFile,
    path: str,
    members: Optional[list[tarfile.TarInfo]] = None,
) -> None:
    """Extract tar members with safe filter when supported by Python version."""
    extract_kwargs = {"path": path}
    if members is not None:
        extract_kwargs["members"] = members

    try:
        tar.extractall(filter="data", **extract_kwargs)
    except TypeError:
        tar.extractall(**extract_kwargs)


async def upload_archive_to_url(upload_url: str, content: bytes) -> None:
    """Upload archive bytes to object storage using presigned URL."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.put(
            upload_url,
            content=content,
            headers={"Content-Type": "application/gzip"},
        )
        response.raise_for_status()


async def download_archive_from_url(download_url: str) -> bytes:
    """Download archive bytes from object storage using presigned URL."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(download_url)
        response.raise_for_status()
        return response.content


def register_rest_api(app: FastAPI):
    """Register REST API endpoints from OpenAPI spec"""

    logger.info("Registering envd REST API routes")

    # Get state manager instance
    state_manager = get_state_manager()

    @app.get("/health", status_code=204)
    async def health_check():
        """Health check endpoint"""
        return Response(status_code=204)

    @app.get("/metrics", response_model=MetricsResponse)
    async def get_metrics(x_access_token: Optional[str] = Header(None)):
        """Get resource usage metrics"""
        verify_access_token(x_access_token)

        try:
            # Collect system metrics using psutil
            cpu_percent = psutil.cpu_percent(interval=0.1)
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage("/")

            metrics = MetricsResponse(
                ts=int(time.time()),
                cpu_count=psutil.cpu_count(),
                cpu_used_pct=cpu_percent,
                mem_total=memory.total,
                mem_used=memory.used,
                disk_total=disk.total,
                disk_used=disk.used,
            )

            return metrics
        except Exception as e:
            logger.exception(f"Error collecting metrics: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/init", status_code=204)
    async def init_envd(
        request: InitRequest, x_access_token: Optional[str] = Header(None)
    ):
        """
        Initialize environment variables and metadata

        - Updates only if request is newer (based on timestamp)
        - Returns 409 Conflict if access token is already set
        - Thread-safe with lock protection
        """
        verify_access_token(x_access_token)

        try:
            state_manager.init(
                hyperloop_ip=request.hyperloopIP,
                env_vars=request.envVars,
                access_token=request.accessToken,
                timestamp=request.timestamp,
                default_user=request.defaultUser,
                default_workdir=request.defaultWorkdir,
            )

            # Set response headers as per reference implementation
            return Response(
                status_code=204,
                headers={"Cache-Control": "no-store", "Content-Type": ""},
            )
        except AccessTokenAlreadySetError as e:
            logger.warning(f"Access token conflict: {e}")
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            logger.exception(f"Error initializing envd: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/envs")
    async def get_envs(x_access_token: Optional[str] = Header(None)):
        """Get environment variables"""
        verify_access_token(x_access_token)

        return state_manager.env_vars

    @app.get("/files")
    async def download_file(
        path: Optional[str] = Query(None),
        username: Optional[str] = Query(None),
        signature: Optional[str] = Query(None),
        signature_expiration: Optional[int] = Query(None),
        x_access_token: Optional[str] = Header(None),
    ):
        """Download a file"""
        verify_access_token(x_access_token)
        verify_signature(signature, signature_expiration)

        try:
            # Resolve file path
            file_path = resolve_path(path, username, state_manager.default_workdir)

            # Check if file exists
            if not file_path.exists():
                raise HTTPException(status_code=404, detail=f"File not found: {path}")

            if not file_path.is_file():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a file: {path}"
                )

            # Check permissions (basic check)
            if not os.access(file_path, os.R_OK):
                raise HTTPException(
                    status_code=401, detail=f"Permission denied: {path}"
                )

            # Return file
            return FileResponse(
                path=str(file_path),
                media_type="application/octet-stream",
                filename=file_path.name,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error downloading file: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/files", response_model=list[EntryInfo])
    async def upload_file(
        file: UploadFile = File(...),
        path: Optional[str] = Query(None),
        username: Optional[str] = Query(None),
        signature: Optional[str] = Query(None),
        signature_expiration: Optional[int] = Query(None),
        x_access_token: Optional[str] = Header(None),
    ):
        """Upload a file"""
        verify_access_token(x_access_token)
        verify_signature(signature, signature_expiration)

        try:
            # Resolve file path
            file_path = resolve_path(path, username, state_manager.default_workdir)

            # Create parent directories if needed
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # Check disk space
            disk = psutil.disk_usage(file_path.parent)
            if disk.free < 100 * 1024 * 1024:  # Less than 100MB free
                raise HTTPException(status_code=507, detail="Not enough disk space")

            # Write file
            content = await file.read()
            file_path.write_bytes(content)

            logger.info(f"Uploaded file to {file_path} ({len(content)} bytes)")

            # Return entry info
            return [EntryInfo(path=str(file_path), name=file_path.name, type="file")]

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error uploading file: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/api/archive", response_model=ArchiveResponse)
    async def archive_workspace(
        request: ArchiveRequest,
        x_access_token: Optional[str] = Header(None),
    ):
        """Archive workspace files for Pod recovery.

        Packages workspace directory into a tarball and uploads directly to MinIO
        using the presigned URL. Excludes large directories like node_modules.

        Includes:
        - .claude_session_id* (Claude Code session files)
        - .claude/ (Claude config)
        - .git/ (Git history)
        - Source code files
        - .cursorrules, .windsurfrules

        Excludes:
        - node_modules/, __pycache__/, .venv/, venv/
        - target/, build/, dist/
        - *.log files
        """
        verify_access_token(x_access_token)

        task_id = request.task_id
        upload_url = request.upload_url
        max_size_bytes = request.max_size_mb * 1024 * 1024

        logger.info(f"[archive] Starting archive for task {task_id}")

        # Workspace path
        workspace_path = get_workspace_path(task_id)
        if not workspace_path.exists():
            logger.warning(f"[archive] Workspace not found: {workspace_path}")
            raise HTTPException(
                status_code=404,
                detail=f"Workspace not found: {workspace_path}",
            )

        try:
            # Create temp file for archive
            with tempfile.NamedTemporaryFile(
                suffix=".tar.gz", delete=False
            ) as tmp_file:
                tmp_path = tmp_file.name

            try:
                # Track what was included
                session_file_included = False
                git_included = False

                # Create tarball with exclusions
                def should_exclude(name: str) -> bool:
                    """Check if file/dir should be excluded."""
                    for pattern in ARCHIVE_EXCLUDE_PATTERNS:
                        if pattern.startswith("*"):
                            if name.endswith(pattern[1:]):
                                return True
                        elif pattern in name.split(os.sep):
                            return True
                    return False

                with tarfile.open(tmp_path, "w:gz") as tar:
                    for item in workspace_path.iterdir():
                        if should_exclude(item.name):
                            logger.debug(f"[archive] Excluding: {item.name}")
                            continue

                        # Track session and git files
                        if item.name.startswith(".claude_session_id"):
                            session_file_included = True
                        if item.name == ".git":
                            git_included = True

                        # Add to archive
                        tar.add(str(item), arcname=item.name)
                        logger.debug(f"[archive] Added: {item.name}")

                    home_path = get_home_path()
                    claude_home_dir = home_path / CLAUDE_CONFIG_DIR_NAME
                    if claude_home_dir.exists():
                        tar.add(
                            str(claude_home_dir),
                            arcname=(
                                f"{CLAUDE_HOME_ARCHIVE_PREFIX}/"
                                f"{CLAUDE_CONFIG_DIR_NAME}"
                            ),
                        )
                        logger.debug(
                            f"[archive] Added Claude home directory: {claude_home_dir}"
                        )

                    claude_home_config = home_path / CLAUDE_CONFIG_FILE_NAME
                    if claude_home_config.exists():
                        tar.add(
                            str(claude_home_config),
                            arcname=(
                                f"{CLAUDE_HOME_ARCHIVE_PREFIX}/"
                                f"{CLAUDE_CONFIG_FILE_NAME}"
                            ),
                        )
                        logger.debug(
                            f"[archive] Added Claude home config: {claude_home_config}"
                        )

                # Check size
                archive_size = os.path.getsize(tmp_path)
                logger.info(
                    f"[archive] Archive size: {archive_size} bytes "
                    f"(max: {max_size_bytes} bytes)"
                )

                if archive_size > max_size_bytes:
                    logger.warning(
                        f"[archive] Archive exceeds size limit: "
                        f"{archive_size} > {max_size_bytes}"
                    )
                    raise HTTPException(
                        status_code=413,
                        detail=f"Archive size {archive_size} exceeds limit {max_size_bytes}",
                    )

                # Upload to MinIO using presigned URL
                logger.info(f"[archive] Uploading archive to MinIO")
                with open(tmp_path, "rb") as f:
                    await upload_archive_to_url(upload_url, f.read())

                logger.info(
                    f"[archive] Successfully archived task {task_id}, "
                    f"size={archive_size} bytes, "
                    f"session_included={session_file_included}, "
                    f"git_included={git_included}"
                )

                return ArchiveResponse(
                    task_id=task_id,
                    size_bytes=archive_size,
                    session_file_included=session_file_included,
                    git_included=git_included,
                )

            finally:
                # Clean up temp file
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"[archive] Error archiving workspace: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/api/restore", response_model=RestoreResponse)
    async def restore_workspace(
        request: RestoreRequest,
        x_access_token: Optional[str] = Header(None),
    ):
        """Restore workspace files from archive.

        Downloads archive from MinIO using the presigned URL and extracts
        to workspace directory, restoring the state before Pod deletion.
        """
        verify_access_token(x_access_token)

        task_id = request.task_id
        download_url = request.download_url

        logger.info(f"[restore] Starting restore for task {task_id}")

        # Workspace path
        workspace_path = get_workspace_path(task_id)

        try:
            # Download archive from MinIO
            logger.info(f"[restore] Downloading archive from MinIO")

            with tempfile.NamedTemporaryFile(
                suffix=".tar.gz", delete=False
            ) as tmp_file:
                tmp_path = tmp_file.name

            try:
                archive_content = await download_archive_from_url(download_url)

                with open(tmp_path, "wb") as f:
                    f.write(archive_content)

                archive_size = os.path.getsize(tmp_path)
                logger.info(f"[restore] Downloaded archive: {archive_size} bytes")

                # Ensure workspace directory exists
                workspace_path.mkdir(parents=True, exist_ok=True)

                # Track what was restored
                session_restored = False
                git_restored = False

                # Extract archive
                with tarfile.open(tmp_path, "r:gz") as tar:
                    workspace_members = []
                    home_members = []

                    # Get member names for tracking and split target location
                    for member in tar.getmembers():
                        member_name = member.name
                        if member_name.startswith(".claude_session_id"):
                            session_restored = True
                        if member_name == ".git" or member_name.startswith(".git/"):
                            git_restored = True

                        if member_name.startswith(f"{CLAUDE_HOME_ARCHIVE_PREFIX}/"):
                            home_members.append(member)
                        else:
                            workspace_members.append(member)

                    # Restore workspace files
                    extract_tar_members(
                        tar=tar,
                        path=str(workspace_path),
                        members=workspace_members,
                    )

                    # Restore Claude home files
                    if home_members:
                        home_path = get_home_path()
                        with tempfile.TemporaryDirectory(
                            prefix="claude-home-restore-"
                        ) as tmp_home_restore_dir:
                            extract_tar_members(
                                tar=tar,
                                path=tmp_home_restore_dir,
                                members=home_members,
                            )
                            extracted_home_root = (
                                Path(tmp_home_restore_dir) / CLAUDE_HOME_ARCHIVE_PREFIX
                            )

                            extracted_claude_dir = (
                                extracted_home_root / CLAUDE_CONFIG_DIR_NAME
                            )
                            target_claude_dir = home_path / CLAUDE_CONFIG_DIR_NAME
                            if extracted_claude_dir.exists():
                                if target_claude_dir.exists():
                                    shutil.rmtree(target_claude_dir)
                                shutil.copytree(
                                    extracted_claude_dir,
                                    target_claude_dir,
                                )

                            extracted_claude_config = (
                                extracted_home_root / CLAUDE_CONFIG_FILE_NAME
                            )
                            target_claude_config = home_path / CLAUDE_CONFIG_FILE_NAME
                            if extracted_claude_config.exists():
                                shutil.copy2(
                                    extracted_claude_config,
                                    target_claude_config,
                                )

                logger.info(
                    f"[restore] Successfully restored task {task_id}, "
                    f"session_restored={session_restored}, "
                    f"git_restored={git_restored}"
                )

                return RestoreResponse(
                    success=True,
                    session_restored=session_restored,
                    git_restored=git_restored,
                )

            finally:
                # Clean up temp file
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"[restore] Error restoring workspace: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    logger.info("Registered envd REST API routes:")
    logger.info("  GET /health")
    logger.info("  GET /metrics")
    logger.info("  POST /init")
    logger.info("  GET /envs")
    logger.info("  GET /files")
    logger.info("  POST /files")
    logger.info("  POST /api/archive")
    logger.info("  POST /api/restore")
