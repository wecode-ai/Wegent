#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
State manager for envd REST API
"""

from datetime import datetime
from typing import Dict, Optional

from shared.logger import setup_logger

logger = setup_logger("envd_api_state")


class EnvdStateManager:
    """Manages envd state including env vars, tokens, and configuration"""

    def __init__(self):
        self.env_vars: Dict[str, str] = {}
        self.access_token: Optional[str] = None
        self.hyperloop_ip: Optional[str] = None
        self.timestamp: Optional[datetime] = None
        self.default_user: Optional[str] = None
        self.default_workdir: Optional[str] = None

    def init(self, hyperloop_ip: Optional[str], env_vars: Optional[Dict[str, str]],
             access_token: Optional[str], timestamp: Optional[str],
             default_user: Optional[str], default_workdir: Optional[str]):
        """Initialize envd state"""
        self.hyperloop_ip = hyperloop_ip
        if env_vars:
            self.env_vars = env_vars
        self.access_token = access_token
        if timestamp:
            try:
                self.timestamp = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            except Exception as e:
                logger.warning(f"Failed to parse timestamp: {e}")
        self.default_user = default_user
        self.default_workdir = default_workdir
        logger.info(f"envd initialized with {len(self.env_vars)} environment variables")


# Global state manager instance
_state_manager: Optional[EnvdStateManager] = None


def get_state_manager() -> EnvdStateManager:
    """Get or create the global state manager instance"""
    global _state_manager
    if _state_manager is None:
        _state_manager = EnvdStateManager()
    return _state_manager
