#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Binary extractor module for K8s InitContainer pattern.
This enables custom base images to run the executor binary via InitContainer.
"""

from typing import Optional

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Constants for K8s InitContainer
EXECUTOR_BINARY_PATH = "/app/executor"
INIT_CONTAINER_MOUNT_PATH = "/shared"
MAIN_CONTAINER_MOUNT_PATH = "/app"


def get_init_container_config(executor_image: str) -> dict:
    """
    Get InitContainer configuration for extracting executor binary.

    In K8s, we use an InitContainer to copy the executor binary from the
    official image to a shared emptyDir volume. The main container then
    mounts this volume and executes the binary.

    Args:
        executor_image: The official executor image containing the binary

    Returns:
        dict: Configuration containing:
            - init_container: InitContainer spec
            - volume: emptyDir volume spec
            - volume_mount: VolumeMount spec for main container
    """
    init_container = {
        "name": "copy-executor-binary",
        "image": executor_image,
        "imagePullPolicy": "Always",
        "command": [
            "sh",
            "-c",
            f"cp {EXECUTOR_BINARY_PATH} {INIT_CONTAINER_MOUNT_PATH}/executor && chmod +x {INIT_CONTAINER_MOUNT_PATH}/executor"
        ],
        "volumeMounts": [
            {
                "name": "executor-binary",
                "mountPath": INIT_CONTAINER_MOUNT_PATH
            }
        ]
    }

    volume = {
        "name": "executor-binary",
        "emptyDir": {}
    }

    volume_mount = {
        "name": "executor-binary",
        "mountPath": MAIN_CONTAINER_MOUNT_PATH,
        "readOnly": True
    }

    return {
        "init_container": init_container,
        "volume": volume,
        "volume_mount": volume_mount,
        "entrypoint": f"{MAIN_CONTAINER_MOUNT_PATH}/executor"
    }


def should_use_init_container(base_image: Optional[str]) -> bool:
    """
    Determine if InitContainer pattern should be used.

    Args:
        base_image: Custom base image from bot configuration

    Returns:
        bool: True if InitContainer should be used, False otherwise
    """
    return base_image is not None and base_image.strip() != ""
