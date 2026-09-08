# SPDX-License-Identifier: Apache-2.0
"""Dependency-free native plugin credential transport (protocol draft 1)."""

from .adapter import AccountAuthAdapter, AuthError, SourceChanged
from .configuration import local_configuration
from .runtime import delegate_cloud_command, run_account_command

__version__ = "0.7.0"
__all__ = [
    "AccountAuthAdapter",
    "AuthError",
    "SourceChanged",
    "local_configuration",
    "delegate_cloud_command",
    "run_account_command",
]
