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

    # Directories and files to exclude from workspace file listing
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
        ".ruff_cache",
        "eggs",
        "*.egg-info",
        ".tox",
        ".nox",
    }

    EXCLUDED_FILES = {
        ".DS_Store",
        "Thumbs.db",
        ".gitignore",
        ".gitattributes",
        "*.pyc",
        "*.pyo",
        "*.so",
        "*.dylib",
        "*.dll",
        "*.exe",
        "*.class",
        "*.jar",
    }

    def should_exclude(name: str, is_dir: bool) -> bool:
        """Check if a file or directory should be excluded from listing"""
        excluded_set = EXCLUDED_DIRS if is_dir else EXCLUDED_FILES

        # Check exact match
        if name in excluded_set:
            return True

        # Check pattern match (e.g., *.pyc)
        for pattern in excluded_set:
            if pattern.startswith("*") and name.endswith(pattern[1:]):
                return True

        return False

    def build_file_tree(
        root_path: Path, relative_base: str = "", max_files: int = 1000
    ) -> tuple[list[WorkspaceFile], int, int]:
        """
        Recursively build a file tree from a directory.

        Args:
            root_path: The root directory path
            relative_base: The relative path from workspace root
            max_files: Maximum number of files to return

        Returns:
            Tuple of (file list, total file count, total size in bytes)
        """
        files: list[WorkspaceFile] = []
        total_files = 0
        total_size = 0

        try:
            entries = sorted(
                root_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())
            )
        except PermissionError:
            return files, total_files, total_size
        except Exception as e:
            logger.warning(f"Error reading directory {root_path}: {e}")
            return files, total_files, total_size

        for entry in entries:
            if total_files >= max_files:
                break

            name = entry.name
            is_dir = entry.is_dir()

            # Skip excluded items
            if should_exclude(name, is_dir):
                continue

            relative_path = f"{relative_base}/{name}" if relative_base else name

            if is_dir:
                # Recursively build children
                children, child_count, child_size = build_file_tree(
                    entry, relative_path, max_files - total_files
                )
                total_files += child_count
                total_size += child_size

                files.append(
                    WorkspaceFile(
                        name=name,
                        path=relative_path,
                        type="directory",
                        size=None,
                        children=children if children else None,
                    )
                )
            else:
                try:
                    file_size = entry.stat().st_size
                except Exception:
                    file_size = 0

                total_files += 1
                total_size += file_size

                files.append(
                    WorkspaceFile(
                        name=name,
                        path=relative_path,
                        type="file",
                        size=file_size,
                        children=None,
                    )
                )

        return files, total_files, total_size

    @app.get("/files/list", response_model=WorkspaceFilesResponse)
    async def list_workspace_files(
        path: Optional[str] = Query(None, description="Subdirectory to list"),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        List all files in the workspace directory (recursive).

        Returns a tree structure of files and directories with smart filtering
        to exclude common temporary/build files.
        """
        verify_access_token(x_access_token)

        try:
            # Use default workdir or specified path
            base_path = state_manager.default_workdir or "/workspace"
            if path:
                base_path = resolve_path(path, None, base_path)
            else:
                base_path = Path(base_path)

            if not base_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"Directory not found: {base_path}"
                )

            if not base_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {base_path}"
                )

            # Build file tree
            files, total_files, total_size = build_file_tree(base_path)

            return WorkspaceFilesResponse(
                files=files,
                total_files=total_files,
                total_size=total_size,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing workspace files: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/files/download-zip")
    async def download_workspace_zip(
        path: Optional[str] = Query(None, description="Subdirectory to download"),
        x_access_token: Optional[str] = Header(None),
    ):
        """
        Download all files in the workspace directory as a ZIP archive.

        Smart filtering is applied to exclude temporary/build files.
        """
        verify_access_token(x_access_token)

        try:
            # Use default workdir or specified path
            base_path = state_manager.default_workdir or "/workspace"
            if path:
                base_path = resolve_path(path, None, base_path)
            else:
                base_path = Path(base_path)

            if not base_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"Directory not found: {base_path}"
                )

            if not base_path.is_dir():
                raise HTTPException(
                    status_code=400, detail=f"Path is not a directory: {base_path}"
                )

            # Create in-memory ZIP file
            zip_buffer = io.BytesIO()

            def add_files_to_zip(
                zipf: zipfile.ZipFile, dir_path: Path, arc_prefix: str = ""
            ):
                """Recursively add files to ZIP archive"""
                try:
                    entries = sorted(dir_path.iterdir())
                except PermissionError:
                    return
                except Exception as e:
                    logger.warning(f"Error reading directory {dir_path}: {e}")
                    return

                for entry in entries:
                    name = entry.name
                    is_dir = entry.is_dir()

                    # Skip excluded items
                    if should_exclude(name, is_dir):
                        continue

                    arc_name = f"{arc_prefix}/{name}" if arc_prefix else name

                    if is_dir:
                        add_files_to_zip(zipf, entry, arc_name)
                    else:
                        try:
                            zipf.write(entry, arc_name)
                        except Exception as e:
                            logger.warning(f"Error adding file to ZIP {entry}: {e}")

            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zipf:
                add_files_to_zip(zipf, base_path)

            zip_buffer.seek(0)

            # Generate filename based on directory name
            dir_name = base_path.name or "workspace"
            filename = f"{dir_name}_files.zip"

            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error creating ZIP download: {e}")
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
