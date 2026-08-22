# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""External event subscription: routing, buffering, and wait-node evaluation."""

from app.services.external_events.service import external_event_service

__all__ = ["external_event_service"]
