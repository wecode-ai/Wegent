#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Utility functions for envd REST API
"""

import os
from pathlib import Path
from typing import Optional

from fastapi import Header, HTTPException

from shared.logger import setup_logger

logger = setup_logger("envd_api_utils")


def verify_access_token(x_access_token: Optional[str] = Header(None)) -> bool:
    """Stub authentication - accepts token but doesn't validate"""
    if x_access_token:
        logger.debug(f"Access token received (not validated): {x_access_token[:10]}...")
    return True


def verify_signature(
    signature: Optional[str], signature_expiration: Optional[int]
) -> bool:
    """Stub signature verification - logs but doesn't validate"""
    if signature:
        logger.debug(f"Signature received (not validated): {signature[:10]}...")
    if signature_expiration:
        logger.debug(f"Signature expiration: {signature_expiration}")
    return True


def resolve_path(
    path: Optional[str], username: Optional[str], default_workdir: Optional[str]
) -> Path:
    """
    Resolve file path, handling relative paths and user home directories

    Args:
        path: File path (absolute or relative)
        username: Username for resolving relative paths
        default_workdir: Default working directory

    Returns:
        Resolved absolute Path

    Raises:
        HTTPException: If path is not provided
    """
    if not path:
        raise HTTPException(status_code=400, detail="Path is required")

    p = Path(path)

    # If relative path, resolve against user home or default workdir
    if not p.is_absolute():
        if username:
            # Resolve relative to user's home
            user_home = (
                Path.home()
                if username == os.getenv("USER")
                else Path(f"/home/{username}")
            )
            p = user_home / p
        elif default_workdir:
            p = Path(default_workdir) / p
        else:
            # Use current working directory
            p = Path.cwd() / p

    return p
