#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Binary extractor module for extracting executor binary from official image to Named Volume.
This enables the Init Container pattern where custom base images can run the latest executor.

Uses a symlink-based versioning strategy to handle "Text file busy" errors:
- executor.v1, executor.v2 are versioned binaries
- executor is a symlink pointing to the current version
- New containers use the symlink, which can be updated atomically
- Old containers continue using their already-opened file handles
- Only keeps 2 versions (current + previous) to minimize disk usage
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


def _get_image_digest(image: str) -> Optional[str]:
    """
    Get the digest of a Docker image.

    Args:
        image: The image name (with or without tag)

    Returns:
        The image digest or None if not found
    """
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.Id}}", image],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except Exception as e:
        logger.warning(f"Error getting image digest: {e}")
        return None


def _should_extract_binary(target_image: str) -> Tuple[bool, Optional[str]]:
    """
    Check if binary extraction is needed by comparing image digests.

    Uses image digest (sha256) instead of tag to ensure we always use
    the latest version even when the tag (e.g., 'latest') hasn't changed.

    Args:
        target_image: The target executor image to compare against

    Returns:
        Tuple of (should_extract, current_version)
    """
    try:
        # Get the digest of the target image
        target_digest = _get_image_digest(target_image)
        if not target_digest:
            logger.info(f"Could not get digest for {target_image}, will extract")
            return True, None

        # Try to read version (digest) from existing volume
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
            # Compare digests instead of image names
            if current_version == target_digest:
                logger.info(f"Executor binary up-to-date (digest: {target_digest[:20]}...)")
                return False, current_version
            else:
                logger.info(f"Digest mismatch: current={current_version[:20] if current_version else 'None'}..., target={target_digest[:20]}...")
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
    Extract executor binary from image to Named Volume using symlink-based versioning.

    This strategy handles "Text file busy" errors when the binary is in use:
    1. Copy new binary to a versioned file (executor.v1 or executor.v2)
    2. Update symlink to point to the new version (atomic operation)
    3. Clean up old version if not in use

    Args:
        executor_image: The source executor image

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        # Get the digest of the image to store as version
        image_digest = _get_image_digest(executor_image)
        if not image_digest:
            logger.warning(f"Could not get digest for {executor_image}, using image name as version")
            image_digest = executor_image

        # Step 1: Create/ensure the Named Volume exists
        subprocess.run(
            ["docker", "volume", "create", EXECUTOR_BINARY_VOLUME],
            capture_output=True,
            text=True,
            timeout=30
        )
        logger.info(f"Created/verified volume: {EXECUTOR_BINARY_VOLUME}")

        # Step 2: Extract executor binary using symlink-based versioning
        # This handles "Text file busy" by:
        # - Writing to a new versioned file (never overwriting running binary)
        # - Atomically updating symlink (ln -sf is atomic on most filesystems)
        # - Cleaning up old versions
        extract_cmd = f"""
            set -e
            
            # Determine which version slot to use (v1 or v2)
            # Read current symlink target to know which slot is in use
            if [ -L /target/executor ]; then
                CURRENT=$(readlink /target/executor)
                if [ "$CURRENT" = "executor.v1" ]; then
                    NEW_VERSION="executor.v2"
                    OLD_VERSION="executor.v1"
                else
                    NEW_VERSION="executor.v1"
                    OLD_VERSION="executor.v2"
                fi
            else
                # First time setup or executor is a regular file
                NEW_VERSION="executor.v1"
                OLD_VERSION=""
                # Remove old regular file if exists (might fail if busy, that's ok)
                rm -f /target/executor 2>/dev/null || true
            fi
            
            # Copy new binary to versioned file
            cp /app/executor /target/$NEW_VERSION
            chmod +x /target/$NEW_VERSION
            
            # Atomically update symlink using ln -sf
            # This creates a temp symlink and renames it (atomic on POSIX)
            ln -sf $NEW_VERSION /target/executor.tmp
            mv -f /target/executor.tmp /target/executor
            
            # Write version file only after successful symlink update
            echo '{image_digest}' > {VERSION_FILE_PATH}
            
            # Clean up old version (will succeed even if file is busy -
            # the file will be deleted when last process closes it)
            if [ -n "$OLD_VERSION" ] && [ -f "/target/$OLD_VERSION" ]; then
                rm -f /target/$OLD_VERSION 2>/dev/null || true
            fi
            
            echo "SUCCESS: Updated executor symlink to $NEW_VERSION"
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

        logger.info(f"Binary extraction completed successfully (digest: {image_digest[:20]}...)")
        if result.stdout:
            logger.debug(f"Extraction output: {result.stdout.strip()}")
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
