#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
REST API route handlers for envd
"""

import os
import time
from typing import Optional

import psutil
from fastapi import FastAPI, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse

from shared.logger import setup_logger

from .models import EntryInfo, InitRequest, MetricsResponse
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

    logger.info("Registered envd REST API routes:")
    logger.info("  GET /health")
    logger.info("  GET /metrics")
    logger.info("  POST /init")
    logger.info("  GET /envs")
    logger.info("  GET /files")
    logger.info("  POST /files")
