# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Providers package.

Import providers here to auto-register them with the registry.
"""

# Import providers to trigger registration
try:
    from app.services.im.providers.telegram import TelegramProvider
except ImportError:
    pass  # Telegram provider not available
