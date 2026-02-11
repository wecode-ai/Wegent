#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
REST API route handlers for envd
"""

import io
import os
import time
import zipfile
from pathlib import Path
from typing import List, Optional, Set

import psutil
from fastapi import FastAPI, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from shared.logger import setup_logger

from .models import (
    EntryInfo,
    InitRequest,
    MetricsResponse,
    WorkspaceFile,
    WorkspaceFilesResponse,
)
from .state import AccessTokenAlreadySetError, get_state_manager
from .utils import resolve_path, verify_access_token, verify_signature

logger = setup_logger("envd_api_routes")

# Directories and files to exclude from workspace file listing
EXCLUDED_DIRS: Set[str] = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".tmp",
    "tmp",
    ".idea",
    ".vscode",
    "dist",
    "build",
    "target",
    "out",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "coverage",
    ".coverage",
    "htmlcov",
    "eggs",
    "*.egg-info",
    ".eggs",
}

# Maximum number of files to return in listing
MAX_FILE_COUNT = 1000


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

    def _should_exclude(name: str) -> bool:
        """Check if a file/directory should be excluded from listing"""
        if name in EXCLUDED_DIRS:
            return True
        # Check wildcard patterns like *.egg-info
        for pattern in EXCLUDED_DIRS:
            if pattern.startswith("*.") and name.endswith(pattern[1:]):
                return True
        return False

    def _validate_workspace_path(path: Optional[str]) -> Path:
        """Validate and resolve workspace path, preventing directory traversal.

        Args:
            path: User-provided path or None

        Returns:
            Validated Path object within /workspace

        Raises:
            HTTPException: If path is outside /workspace
        """
        workspace_root = Path("/workspace").resolve()

        if path:
            dir_path = Path(path).resolve()
        else:
            dir_path = workspace_root

        # Ensure the path is within /workspace
        try:
            dir_path.relative_to(workspace_root)
        except ValueError:
            raise HTTPException(
                status_code=403,
                detail="Access denied: path must be within /workspace",
            )

        return dir_path

    def _scan_directory(
        dir_path: Path, base_path: Path, file_count: List[int], max_count: int
    ) -> List[WorkspaceFile]:
        """
        Recursively scan directory and return file tree structure.

        Args:
            dir_path: Current directory to scan
            base_path: Base workspace path for relative path calculation
            file_count: Mutable list containing current file count [count]
            max_count: Maximum number of files to return

        Returns:
            List of WorkspaceFile objects
        """
        result: List[WorkspaceFile] = []

        try:
            entries = sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name))
        except PermissionError:
            return result

        for entry in entries:
            if file_count[0] >= max_count:
                break

            # Skip excluded directories/files
            if _should_exclude(entry.name):
                continue

            # Skip symlinks to prevent traversal and circular recursion
            if entry.is_symlink():
                continue

            relative_path = str(entry.relative_to(base_path))

            if entry.is_dir():
                children = _scan_directory(entry, base_path, file_count, max_count)
                result.append(
                    WorkspaceFile(
                        name=entry.name,
                        path=relative_path,
                        type="directory",
                        children=children if children else None,
                    )
                )
            else:
                file_count[0] += 1
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = None
                result.append(
                    WorkspaceFile(
                        name=entry.name,
                        path=relative_path,
                        type="file",
                        size=size,
                    )
                )

        return result

    @app.get("/files/list", response_model=WorkspaceFilesResponse)
    async def list_workspace_files(
        path: Optional[str] = Query(None, description="Directory path to list"),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        List all files in the specified directory recursively.

        Returns a tree structure of files and directories with smart filtering
        to exclude common temporary/build directories.
        """
        verify_access_token(x_access_token)

        try:
            # Validate and resolve path (prevents directory traversal)
            dir_path = _validate_workspace_path(path)

            # Check if directory exists
            if not dir_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"Directory not found: {dir_path}"
                )

            if not dir_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {dir_path}"
                )

            # Check permissions
            if not os.access(dir_path, os.R_OK):
                raise HTTPException(
                    status_code=403, detail=f"Permission denied: {dir_path}"
                )

            # Scan directory
            file_count = [0]
            files = _scan_directory(dir_path, dir_path, file_count, MAX_FILE_COUNT)

            return WorkspaceFilesResponse(
                files=files,
                total_count=file_count[0],
                truncated=file_count[0] >= MAX_FILE_COUNT,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing workspace files: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/files/download-zip")
    async def download_workspace_zip(
        path: Optional[str] = Query(None, description="Directory path to zip"),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        Download all files in the specified directory as a ZIP archive.

        Applies smart filtering to exclude common temporary/build directories.
        """
        verify_access_token(x_access_token)

        try:
            # Validate and resolve path (prevents directory traversal)
            dir_path = _validate_workspace_path(path)

            # Check if directory exists
            if not dir_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"Directory not found: {dir_path}"
                )

            if not dir_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {dir_path}"
                )

            # Check permissions
            if not os.access(dir_path, os.R_OK):
                raise HTTPException(
                    status_code=403, detail=f"Permission denied: {dir_path}"
                )

            # Create ZIP in memory
            zip_buffer = io.BytesIO()
            file_count = 0

            with zipfile.ZipFile(
                zip_buffer, "w", zipfile.ZIP_DEFLATED, allowZip64=True
            ) as zip_file:
                for root, dirs, files in os.walk(dir_path, followlinks=False):
                    # Filter excluded directories in-place
                    dirs[:] = [d for d in dirs if not _should_exclude(d)]

                    for filename in files:
                        if file_count >= MAX_FILE_COUNT:
                            break

                        file_path = Path(root) / filename
                        # Skip excluded files and symlinks
                        if _should_exclude(filename) or file_path.is_symlink():
                            continue

                        try:
                            relative_path = file_path.relative_to(dir_path)
                            zip_file.write(file_path, relative_path)
                            file_count += 1
                        except (PermissionError, OSError) as e:
                            logger.warning(f"Skipping file {file_path}: {e}")
                            continue

                    if file_count >= MAX_FILE_COUNT:
                        break

            zip_buffer.seek(0)

            # Generate filename based on directory name
            zip_filename = f"{dir_path.name}_files.zip"

            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{zip_filename}"'
                },
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error creating workspace zip: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    logger.info("Registered envd REST API routes:")
    logger.info("  GET /health")
    logger.info("  GET /metrics")
    logger.info("  POST /init")
    logger.info("  GET /envs")
    logger.info("  GET /files")
    logger.info("  POST /files")
    logger.info("  GET /files/list")
    logger.info("  GET /files/download-zip")
