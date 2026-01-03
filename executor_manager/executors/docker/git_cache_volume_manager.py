#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Volume Manager Module

Handles Docker volume lifecycle management for user-isolated git cache volumes.
Each user gets their own volume (wegent_git_cache_user_{id}) for physical isolation.
"""

import json
import os
import subprocess
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Volume naming convention
VOLUME_PREFIX = "wegent_git_cache_user_"

# Volume labels for metadata management
LABEL_USER_ID = "wegent.user-id"
LABEL_CREATED_AT = "wegent.created-at"
LABEL_LAST_USED = "wegent.last-used"


def get_user_volume_name(user_id: int) -> str:
    """
    Get the volume name for a specific user.

    Args:
        user_id: User ID

    Returns:
        Volume name in format: wegent_git_cache_user_{id}
    """
    return f"{VOLUME_PREFIX}{user_id}"


def volume_exists(volume_name: str) -> bool:
    """
    Check if a Docker volume exists.

    Args:
        volume_name: Name of the volume to check

    Returns:
        True if volume exists, False otherwise
    """
    try:
        result = subprocess.run(
            ["docker", "volume", "inspect", volume_name],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception as e:
        logger.warning(f"Error checking volume existence: {e}")
        return False


def create_user_volume(user_id: int) -> Tuple[bool, Optional[str]]:
    """
    Create a Docker volume for a specific user with metadata labels.

    This function creates a user-specific volume and labels it with:
    - User ID for identification
    - Creation timestamp
    - Last used timestamp (initialized to creation time)

    Args:
        user_id: User ID

    Returns:
        Tuple (success, error_message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    volume_name = get_user_volume_name(user_id)

    # Check if volume already exists
    if volume_exists(volume_name):
        logger.info(f"Volume {volume_name} already exists for user {user_id}")
        return True, None

    try:
        # Get current timestamp for labels
        created_at = datetime.utcnow().isoformat()

        # Create volume with labels
        cmd = [
            "docker",
            "volume",
            "create",
            "--label",
            f"{LABEL_USER_ID}={user_id}",
            "--label",
            f"{LABEL_CREATED_AT}={created_at}",
            "--label",
            f"{LABEL_LAST_USED}={created_at}",
            volume_name,
        ]

        logger.info(f"Creating volume for user {user_id}: {volume_name}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)

        logger.info(f"Successfully created volume: {volume_name}")
        return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Failed to create volume {volume_name}: {error_msg}")
        return False, error_msg
    except subprocess.TimeoutExpired:
        error_msg = "Timeout creating volume after 30 seconds"
        logger.error(error_msg)
        return False, error_msg
    except Exception as e:
        logger.error(f"Unexpected error creating volume: {e}")
        return False, str(e)


def get_volume_metadata(volume_name: str) -> Optional[Dict[str, str]]:
    """
    Get metadata labels from a volume.

    Args:
        volume_name: Name of the volume

    Returns:
        Dictionary of labels or None if volume doesn't exist
    """
    try:
        result = subprocess.run(
            ["docker", "volume", "inspect", "--format", "json", volume_name],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )

        data = json.loads(result.stdout)
        if data and len(data) > 0:
            return data[0].get("Labels", {})

        return None

    except Exception as e:
        logger.warning(f"Error getting volume metadata: {e}")
        return None


def update_volume_last_used(volume_name: str) -> bool:
    """
    Update the last-used timestamp for a volume.

    This is called whenever a volume is mounted to track usage.

    Args:
        volume_name: Name of the volume

    Returns:
        True if successful, False otherwise
    """
    try:
        # Get current metadata
        metadata = get_volume_metadata(volume_name)
        if not metadata:
            logger.warning(f"Cannot update metadata: volume {volume_name} not found")
            return False

        user_id = metadata.get(LABEL_USER_ID)
        created_at = metadata.get(LABEL_CREATED_AT)
        last_used = datetime.utcnow().isoformat()

        # Update labels by recreating the volume with new labels
        # Note: Docker doesn't support direct label updates, so we recreate
        cmd = [
            "docker",
            "volume",
            "create",
            "--label",
            f"{LABEL_USER_ID}={user_id}",
            "--label",
            f"{LABEL_CREATED_AT}={created_at}",
            "--label",
            f"{LABEL_LAST_USED}={last_used}",
            volume_name,
        ]

        # This will fail if volume is in use, which is fine
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode == 0:
            logger.debug(f"Volume {volume_name} last used: {last_used}")
            return True
        else:
            # Volume is in use or other error - log but don't fail
            logger.debug(f"Could not update last-used label for {volume_name}: {result.stderr}")
            return False

    except Exception as e:
        logger.warning(f"Error updating volume last-used timestamp: {e}")
        return False


def delete_volume(volume_name: str) -> Tuple[bool, Optional[str]]:
    """
    Delete a Docker volume.

    Args:
        volume_name: Name of the volume to delete

    Returns:
        Tuple (success, error_message)
    """
    try:
        logger.info(f"Deleting volume: {volume_name}")
        result = subprocess.run(
            ["docker", "volume", "rm", volume_name], capture_output=True, text=True, timeout=30, check=True
        )

        logger.info(f"Successfully deleted volume: {volume_name}")
        return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Failed to delete volume {volume_name}: {error_msg}")
        return False, error_msg
    except subprocess.TimeoutExpired:
        error_msg = "Timeout deleting volume after 30 seconds"
        logger.error(error_msg)
        return False, error_msg
    except Exception as e:
        logger.error(f"Unexpected error deleting volume: {e}")
        return False, str(e)


def list_user_volumes() -> Dict[int, Dict[str, str]]:
    """
    List all git cache user volumes with their metadata.

    Returns:
        Dictionary mapping user_id to volume metadata:
        {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "created_at": "2025-01-03T10:00:00",
                "last_used": "2025-01-03T15:30:00"
            },
            ...
        }
    """
    try:
        # List all volumes with our prefix
        result = subprocess.run(
            ["docker", "volume", "ls", "--format", "{{.Name}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )

        volumes = result.stdout.strip().split("\n")
        user_volumes = {}

        for volume_name in volumes:
            if not volume_name:
                continue
            if volume_name.startswith(VOLUME_PREFIX):
                metadata = get_volume_metadata(volume_name)
                if metadata:
                    user_id_str = metadata.get(LABEL_USER_ID)
                    if user_id_str:
                        try:
                            user_id = int(user_id_str)
                            user_volumes[user_id] = {
                                "volume_name": volume_name,
                                "created_at": metadata.get(LABEL_CREATED_AT, ""),
                                "last_used": metadata.get(LABEL_LAST_USED, ""),
                            }
                        except ValueError:
                            logger.warning(f"Invalid user ID in volume labels: {user_id_str}")

        return user_volumes

    except Exception as e:
        logger.error(f"Error listing user volumes: {e}")
        return {}


def get_volume_size(volume_name: str) -> Optional[int]:
    """
    Get the disk usage of a volume in bytes.

    Args:
        volume_name: Name of the volume

    Returns:
        Size in bytes or None if error
    """
    try:
        # Run a temporary container to check volume size
        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{volume_name}:/data:ro",
            "alpine:latest",
            "du",
            "-sb",
            "/data",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)

        # Parse output: "12345678    /data"
        size_str = result.stdout.strip().split()[0]
        return int(size_str)

    except Exception as e:
        logger.warning(f"Error getting volume size: {e}")
        return None


def get_all_user_volume_names() -> List[str]:
    """
    Get a list of all user volume names.

    Returns:
        List of volume names
    """
    try:
        result = subprocess.run(
            ["docker", "volume", "ls", "--format", "{{.Name}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )

        volumes = result.stdout.strip().split("\n")
        return [v for v in volumes if v and v.startswith(VOLUME_PREFIX)]

    except Exception as e:
        logger.error(f"Error listing volumes: {e}")
        return []
