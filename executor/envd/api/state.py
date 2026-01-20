#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
State manager for envd REST API
"""

import threading
from datetime import datetime
from typing import Dict, Optional

from shared.logger import setup_logger

logger = setup_logger("envd_api_state")


class AccessTokenAlreadySetError(Exception):
    """Raised when trying to set access token that is already set"""

    pass


class EnvdStateManager:
    """Manages envd state including env vars, tokens, and configuration"""

    def __init__(self):
        self.env_vars: Dict[str, str] = {}
        self.access_token: Optional[str] = None
        self.hyperloop_ip: Optional[str] = None
        self.timestamp: Optional[datetime] = None
        self.last_set_time: Optional[datetime] = None
        self.default_user: Optional[str] = None
        self.default_workdir: Optional[str] = None
        self._lock = threading.Lock()

    def init(
        self,
        hyperloop_ip: Optional[str],
        env_vars: Optional[Dict[str, str]],
        access_token: Optional[str],
        timestamp: Optional[str],
        default_user: Optional[str],
        default_workdir: Optional[str],
    ) -> None:
        """
        Initialize envd state with thread-safety and timestamp validation

        Args:
            hyperloop_ip: IP address of hyperloop server
            env_vars: Environment variables to set
            access_token: Access token for authentication
            timestamp: RFC3339 timestamp of the request
            default_user: Default user for operations
            default_workdir: Default working directory

        Raises:
            AccessTokenAlreadySetError: If access token is already set and trying to set a different one
        """
        with self._lock:
            # Parse request timestamp
            request_time: Optional[datetime] = None
            if timestamp:
                try:
                    request_time = datetime.fromisoformat(
                        timestamp.replace("Z", "+00:00")
                    )
                except Exception as e:
                    logger.warning(f"Failed to parse timestamp: {e}")

            # Check if we should update: no timestamp or newer timestamp
            should_update = (
                request_time is None
                or self.last_set_time is None
                or request_time > self.last_set_time
            )

            if not should_update:
                logger.info(
                    f"Skipping update: request timestamp {request_time} is not newer than last set time {self.last_set_time}"
                )
                return

            # Check for access token conflict
            if access_token and self.access_token and self.access_token != access_token:
                logger.warning(
                    f"Access token conflict: attempting to set new token when one already exists"
                )
                raise AccessTokenAlreadySetError("Access token is already set")

            # Update state
            if hyperloop_ip:
                self.hyperloop_ip = hyperloop_ip

            if env_vars:
                self.env_vars.update(env_vars)

            if access_token:
                self.access_token = access_token

            if request_time:
                self.timestamp = request_time
                self.last_set_time = request_time

            if default_user:
                self.default_user = default_user

            if default_workdir:
                self.default_workdir = default_workdir

            logger.info(
                f"envd initialized with {len(self.env_vars)} environment variables (timestamp: {self.last_set_time})"
            )


# Global state manager instance
_state_manager: Optional[EnvdStateManager] = None


def get_state_manager() -> EnvdStateManager:
    """Get or create the global state manager instance"""
    global _state_manager
    if _state_manager is None:
        _state_manager = EnvdStateManager()
    return _state_manager
