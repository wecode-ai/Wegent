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

# Touch file paths inside volumes
TOUCH_FILE_LAST_USED = ".last_used"
TOUCH_FILE_METADATA = ".metadata"
MOUNT_POINT = "/cache"

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

        # Initialize metadata files in the volume
        logger.info(f"Initializing metadata files in {volume_name}")
        if not _initialize_volume_metadata(volume_name, user_id, created_at):
            logger.warning(
                f"Volume {volume_name} created but metadata files failed to initialize. "
                f"Tracking will work but may be degraded."
            )
            # Don't fail - volume is still usable, just tracking might be degraded

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

    This function writes the current timestamp to a .last_used file inside the volume,
    which can be reliably updated (unlike Docker labels which are immutable).

    This is called whenever a volume is mounted to track usage.

    Args:
        volume_name: Name of the volume

    Returns:
        True if successful, False otherwise
    """
    try:
        # Get current timestamp
        last_used = datetime.utcnow().isoformat()

        # Write timestamp to .last_used file in volume
        # This works even when the volume is mounted by other containers
        success = _write_last_used_to_volume(volume_name, last_used)

        if success:
            logger.debug(f"Updated last_used for {volume_name}: {last_used}")
        else:
            logger.debug(f"Failed to update last_used for {volume_name}")

        return success

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

    Reads metadata from .metadata and .last_used files inside volumes,
    which are more reliable than Docker labels.

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
                # Read metadata from touch files (with fallback to labels)
                metadata = _read_volume_files(volume_name)
                if metadata and metadata.get("user_id"):
                    try:
                        user_id = int(metadata["user_id"])
                        user_volumes[user_id] = {
                            "volume_name": volume_name,
                            "created_at": metadata.get("created_at", ""),
                            "last_used": metadata.get("last_used", ""),
                        }
                    except (ValueError, TypeError):
                        logger.warning(f"Invalid user ID in volume metadata: {metadata.get('user_id')}")

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


def _read_last_used_from_volume(volume_name: str) -> Optional[str]:
    """
    Read the .last_used timestamp file from a volume.

    Args:
        volume_name: Name of the volume

    Returns:
        ISO timestamp string or None if file doesn't exist/read fails
    """
    try:
        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{volume_name}:{MOUNT_POINT}:ro",
            "alpine:latest",
            "cat",
            f"{MOUNT_POINT}/{TOUCH_FILE_LAST_USED}",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=True)
        timestamp = result.stdout.strip()

        # Validate ISO format
        datetime.fromisoformat(timestamp)
        return timestamp

    except subprocess.CalledProcessError:
        # File doesn't exist or volume not found
        logger.debug(f"No .last_used file in {volume_name}")
        return None
    except ValueError:
        logger.warning(f"Invalid timestamp format in {volume_name}/{TOUCH_FILE_LAST_USED}")
        return None
    except Exception as e:
        logger.warning(f"Error reading last_used from {volume_name}: {e}")
        return None


def _read_metadata_from_volume(volume_name: str) -> Optional[Dict[str, any]]:
    """
    Read the .metadata JSON file from a volume.

    Args:
        volume_name: Name of the volume

    Returns:
        Dictionary with user_id, created_at, volume_name or None
    """
    try:
        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{volume_name}:{MOUNT_POINT}:ro",
            "alpine:latest",
            "cat",
            f"{MOUNT_POINT}/{TOUCH_FILE_METADATA}",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=True)
        metadata = json.loads(result.stdout)
        return metadata

    except subprocess.CalledProcessError:
        # File doesn't exist or volume not found
        logger.debug(f"No .metadata file in {volume_name}")
        return None
    except json.JSONDecodeError as e:
        logger.warning(f"Invalid JSON in {volume_name}/{TOUCH_FILE_METADATA}: {e}")
        return None
    except Exception as e:
        logger.warning(f"Error reading metadata from {volume_name}: {e}")
        return None


def _write_last_used_to_volume(volume_name: str, timestamp: str) -> bool:
    """
    Write timestamp to the .last_used file in a volume.

    Args:
        volume_name: Name of the volume
        timestamp: ISO timestamp string to write

    Returns:
        True if successful, False otherwise
    """
    try:
        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{volume_name}:{MOUNT_POINT}:rw",
            "alpine:latest",
            "sh",
            "-c",
            f"echo '{timestamp}' > {MOUNT_POINT}/{TOUCH_FILE_LAST_USED}",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)

        if result.returncode == 0:
            return True
        else:
            logger.debug(f"Failed to write .last_used to {volume_name}: {result.stderr}")
            return False

    except subprocess.TimeoutExpired:
        logger.warning(f"Timeout writing .last_used to {volume_name}")
        return False
    except Exception as e:
        logger.warning(f"Error writing last_used to {volume_name}: {e}")
        return False


def _write_metadata_to_volume(volume_name: str, user_id: int, created_at: str) -> bool:
    """
    Write the .metadata JSON file to a volume.

    Args:
        volume_name: Name of the volume
        user_id: User ID
        created_at: Creation timestamp (ISO format)

    Returns:
        True if successful, False otherwise
    """
    try:
        metadata = {
            "user_id": user_id,
            "created_at": created_at,
            "volume_name": volume_name,
        }
        metadata_json = json.dumps(metadata, indent=2)

        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{volume_name}:{MOUNT_POINT}:rw",
            "alpine:latest",
            "sh",
            "-c",
            f"cat > {MOUNT_POINT}/{TOUCH_FILE_METADATA} << 'METADATA_EOF'\n{metadata_json}\nMETADATA_EOF",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)

        if result.returncode == 0:
            return True
        else:
            logger.warning(f"Failed to write .metadata to {volume_name}: {result.stderr}")
            return False

    except subprocess.TimeoutExpired:
        logger.warning(f"Timeout writing .metadata to {volume_name}")
        return False
    except Exception as e:
        logger.warning(f"Error writing metadata to {volume_name}: {e}")
        return False


def _initialize_volume_metadata(volume_name: str, user_id: int, created_at: str) -> bool:
    """
    Initialize metadata files (.last_used and .metadata) in a newly created volume.

    Args:
        volume_name: Name of the volume
        user_id: User ID
        created_at: Creation timestamp (ISO format)

    Returns:
        True if both files created successfully, False otherwise
    """
    try:
        # Write .last_used file
        if not _write_last_used_to_volume(volume_name, created_at):
            logger.error(f"Failed to create .last_used file in {volume_name}")
            return False

        # Write .metadata file
        if not _write_metadata_to_volume(volume_name, user_id, created_at):
            logger.error(f"Failed to create .metadata file in {volume_name}")
            return False

        logger.info(f"Initialized metadata files in {volume_name}")
        return True

    except Exception as e:
        logger.error(f"Error initializing metadata in {volume_name}: {e}")
        return False


def _read_volume_files(volume_name: str) -> Optional[Dict[str, str]]:
    """
    Read .metadata and .last_used files from a volume.

    This is the primary method for getting volume metadata.
    Falls back to Docker labels for volumes created before touch file system.

    Args:
        volume_name: Name of the volume

    Returns:
        Dict with user_id, created_at, last_used or None if unavailable
    """
    # Try to read from files
    metadata = _read_metadata_from_volume(volume_name)
    if metadata:
        last_used = _read_last_used_from_volume(volume_name)
        if not last_used:
            # .last_used doesn't exist, use created_at as fallback
            last_used = metadata.get("created_at")

        return {
            "user_id": metadata.get("user_id"),
            "created_at": metadata.get("created_at"),
            "last_used": last_used,
        }

    # Files don't exist - try fallback to Docker labels (for old volumes)
    logger.info(f"No metadata files in {volume_name}, trying Docker labels fallback")
    return _fallback_to_docker_inspect(volume_name)


def _fallback_to_docker_inspect(volume_name: str) -> Optional[Dict[str, str]]:
    """
    Fallback to Docker labels when metadata files don't exist.

    This handles migration of existing volumes that were created
    before the touch file system was implemented. Also migrates
    the volume to use files.

    Args:
        volume_name: Name of the volume

    Returns:
        Dict with user_id, created_at, last_used or None
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
            labels = data[0].get("Labels", {})
            user_id = labels.get(LABEL_USER_ID)
            created_at = labels.get(LABEL_CREATED_AT)
            last_used = labels.get(LABEL_LAST_USED)

            if user_id and created_at:
                # Found labels - migrate to files
                logger.info(f"Migrating {volume_name} from labels to touch files")

                # Initialize metadata files (will be used on next access)
                try:
                    _initialize_volume_metadata(volume_name, int(user_id), created_at)
                except Exception as e:
                    logger.warning(f"Migration failed for {volume_name}: {e}")

                return {
                    "user_id": user_id,
                    "created_at": created_at,
                    "last_used": last_used or created_at,
                }

        return None

    except Exception as e:
        logger.warning(f"Docker inspect fallback failed for {volume_name}: {e}")
        return None
