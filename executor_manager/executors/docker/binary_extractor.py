#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Binary extractor module for extracting executor binary from official image to Named Volume.
This enables the Init Container pattern where custom base images can run the latest executor.
"""

import os
import subprocess
from typing import Optional, Tuple

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Constants
EXECUTOR_BINARY_VOLUME = "wegent-executor-binary"
EXECUTOR_BINARY_PATH = "/app/executor"
VERSION_FILE_PATH = "/target/.version"


def get_executor_image() -> str:
    """Get the executor image from environment variable"""
    return os.getenv("EXECUTOR_IMAGE", "")


def extract_executor_binary() -> bool:
    """
    Extract executor binary from official image to Named Volume.

    This function:
    1. Checks if the Named Volume exists with the current version
    2. If not, creates/updates the volume with executor binary from official image
    3. Records the version for future comparison

    Returns:
        bool: True if extraction was successful or already up-to-date, False otherwise
    """
    executor_image = get_executor_image()
    if not executor_image:
        logger.warning("EXECUTOR_IMAGE environment variable not set, skipping binary extraction")
        return True  # Not an error, just not configured

    logger.info(f"Checking executor binary extraction for image: {executor_image}")

    try:
        # Check if volume exists and has matching version
        should_extract, current_version = _should_extract_binary(executor_image)

        if not should_extract:
            logger.info(f"Executor binary already up-to-date (version: {current_version})")
            return True

        logger.info(f"Extracting executor binary from {executor_image}...")

        # Extract binary from official image to Named Volume
        success = _extract_binary_to_volume(executor_image)

        if success:
            logger.info(f"Successfully extracted executor binary to volume {EXECUTOR_BINARY_VOLUME}")
            return True
        else:
            logger.error("Failed to extract executor binary")
            return False

    except Exception as e:
        logger.error(f"Error during executor binary extraction: {e}")
        return False


def _should_extract_binary(target_image: str) -> Tuple[bool, Optional[str]]:
    """
    Check if binary extraction is needed by comparing versions.

    Args:
        target_image: The target executor image to compare against

    Returns:
        Tuple of (should_extract, current_version)
    """
    try:
        # Try to read version from existing volume
        result = subprocess.run(
            [
                "docker", "run", "--rm",
                "-v", f"{EXECUTOR_BINARY_VOLUME}:/target:ro",
                "alpine:latest",
                "cat", VERSION_FILE_PATH
            ],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0:
            current_version = result.stdout.strip()
            if current_version == target_image:
                return False, current_version
            else:
                logger.info(f"Version mismatch: current={current_version}, target={target_image}")
                return True, current_version
        else:
            # Volume doesn't exist or version file not found
            logger.info("No existing version found, extraction needed")
            return True, None

    except subprocess.TimeoutExpired:
        logger.warning("Timeout checking version, will extract")
        return True, None
    except Exception as e:
        logger.warning(f"Error checking version: {e}, will extract")
        return True, None


def _extract_binary_to_volume(executor_image: str) -> bool:
    """
    Extract executor binary from image to Named Volume.

    Args:
        executor_image: The source executor image

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        # Step 1: Create/ensure the Named Volume exists
        subprocess.run(
            ["docker", "volume", "create", EXECUTOR_BINARY_VOLUME],
            capture_output=True,
            text=True,
            timeout=30
        )
        logger.info(f"Created/verified volume: {EXECUTOR_BINARY_VOLUME}")

        # Step 2: Extract executor binary and write version file
        # Using a single container to copy files and write version
        extract_cmd = f"""
            cp -r /app/* /target/ 2>/dev/null || cp /app/executor /target/executor;
            echo '{executor_image}' > {VERSION_FILE_PATH};
            chmod +x /target/executor 2>/dev/null || true
        """

        result = subprocess.run(
            [
                "docker", "run", "--rm",
                "-v", f"{EXECUTOR_BINARY_VOLUME}:/target",
                executor_image,
                "sh", "-c", extract_cmd
            ],
            capture_output=True,
            text=True,
            timeout=120  # 2 minutes for extraction
        )

        if result.returncode != 0:
            logger.error(f"Failed to extract binary: {result.stderr}")
            return False

        logger.info("Binary extraction completed successfully")
        return True

    except subprocess.TimeoutExpired:
        logger.error("Binary extraction timed out")
        return False
    except Exception as e:
        logger.error(f"Error extracting binary: {e}")
        return False


def get_volume_mount_config() -> dict:
    """
    Get the volume mount configuration for containers using custom base image.

    Returns:
        dict: Configuration for volume mount
    """
    return {
        "volume_name": EXECUTOR_BINARY_VOLUME,
        "mount_path": "/app",
        "readonly": True,
        "entrypoint": "/app/executor"
    }
