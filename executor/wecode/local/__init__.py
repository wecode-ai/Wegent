# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local executor extensions for WeCode.
"""

from executor.wecode.local.himalaya_mail import register_himalaya_mail_handlers


def register_local_runner_extensions(runner) -> None:
    """Register WeCode-specific local runner event handlers."""

    register_himalaya_mail_handlers(runner)
