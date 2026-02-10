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
from typing import Optional

import psutil
from fastapi import FastAPI, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from shared.logger import setup_logger

from .models import EntryInfo, InitRequest, MetricsResponse, WorkspaceFile, WorkspaceFileListResponse
from .state import AccessTokenAlreadySetError, get_state_manager
from .utils import resolve_path, verify_access_token, verify_signature

# Directories and patterns to exclude from file listings
EXCLUDED_DIRS = {
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
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "eggs",
    "*.egg-info",
    ".eggs",
}

# Maximum number of files to list (safety limit)
MAX_FILE_COUNT = 1000

logger = setup_logger("envd_api_routes")


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
        """Check if a file or directory should be excluded from listing"""
        if name in EXCLUDED_DIRS:
            return True
        # Check for pattern matches (e.g., *.egg-info)
        for pattern in EXCLUDED_DIRS:
            if "*" in pattern:
                # Simple glob pattern matching
                prefix, suffix = pattern.split("*", 1)
                if name.startswith(prefix) and name.endswith(suffix):
                    return True
        return False

    def _scan_directory(
        dir_path: Path, base_path: Path, current_count: list[int]
    ) -> tuple[list[WorkspaceFile], int]:
        """
        Recursively scan a directory and return file tree structure.

        Args:
            dir_path: Directory to scan
            base_path: Base path for relative path calculation
            current_count: Mutable counter to track total files

        Returns:
            Tuple of (files list, filtered count)
        """
        files = []
        filtered_count = 0

        try:
            entries = sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        except PermissionError:
            logger.warning(f"Permission denied: {dir_path}")
            return files, filtered_count

        for entry in entries:
            # Check exclusion
            if _should_exclude(entry.name):
                filtered_count += 1
                continue

            # Check file count limit
            if current_count[0] >= MAX_FILE_COUNT:
                break

            relative_path = str(entry.relative_to(base_path))

            if entry.is_file():
                current_count[0] += 1
                try:
                    size = entry.stat().st_size
                except (OSError, PermissionError):
                    size = 0
                files.append(
                    WorkspaceFile(
                        name=entry.name,
                        path=relative_path,
                        type="file",
                        size=size,
                    )
                )
            elif entry.is_dir():
                children, child_filtered = _scan_directory(entry, base_path, current_count)
                filtered_count += child_filtered
                # Only add directory if it has children or we haven't exceeded limit
                if children or current_count[0] < MAX_FILE_COUNT:
                    files.append(
                        WorkspaceFile(
                            name=entry.name,
                            path=relative_path,
                            type="directory",
                            children=children if children else None,
                        )
                    )

        return files, filtered_count

    @app.get("/files/list", response_model=WorkspaceFileListResponse)
    async def list_workspace_files(
        path: Optional[str] = Query(None, description="Directory path to list"),
        username: Optional[str] = Query(None),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        List all files in a workspace directory recursively.

        Returns a tree structure with directories and files,
        excluding common temporary and generated directories.
        """
        verify_access_token(x_access_token)

        try:
            # Resolve directory path
            dir_path = resolve_path(path, username, state_manager.default_workdir)

            # Check if directory exists
            if not dir_path.exists():
                raise HTTPException(status_code=404, detail=f"Directory not found: {path}")

            if not dir_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {path}"
                )

            # Check permissions
            if not os.access(dir_path, os.R_OK):
                raise HTTPException(
                    status_code=401, detail=f"Permission denied: {path}"
                )

            # Scan directory
            current_count = [0]  # Use list to allow mutation in nested function
            files, filtered_count = _scan_directory(dir_path, dir_path, current_count)

            return WorkspaceFileListResponse(
                files=files,
                total_count=current_count[0],
                filtered_count=filtered_count,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing workspace files: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/files/download-zip")
    async def download_workspace_zip(
        path: Optional[str] = Query(None, description="Directory path to download as ZIP"),
        username: Optional[str] = Query(None),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        Download a workspace directory as a ZIP file.

        Excludes common temporary and generated directories.
        Returns a streaming response with the ZIP file.
        """
        verify_access_token(x_access_token)

        try:
            # Resolve directory path
            dir_path = resolve_path(path, username, state_manager.default_workdir)

            # Check if directory exists
            if not dir_path.exists():
                raise HTTPException(status_code=404, detail=f"Directory not found: {path}")

            if not dir_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {path}"
                )

            # Check permissions
            if not os.access(dir_path, os.R_OK):
                raise HTTPException(
                    status_code=401, detail=f"Permission denied: {path}"
                )

            # Create ZIP file in memory
            zip_buffer = io.BytesIO()
            file_count = 0

            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for root, dirs, files in os.walk(dir_path):
                    # Filter out excluded directories (modify in-place to skip them)
                    dirs[:] = [d for d in dirs if not _should_exclude(d)]

                    for file in files:
                        if file_count >= MAX_FILE_COUNT:
                            break
                        if _should_exclude(file):
                            continue

                        file_path = Path(root) / file
                        try:
                            # Get relative path for ZIP
                            arcname = str(file_path.relative_to(dir_path))
                            zip_file.write(file_path, arcname)
                            file_count += 1
                        except (OSError, PermissionError) as e:
                            logger.warning(f"Could not add file to ZIP: {file_path}: {e}")
                            continue

                    if file_count >= MAX_FILE_COUNT:
                        break

            # Prepare response
            zip_buffer.seek(0)
            dir_name = dir_path.name or "workspace"

            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{dir_name}_files.zip"'
                },
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error creating workspace ZIP: {e}")
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
