# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stat table model registry."""

from knowledge_engine.stat.models.base import StatBase
from knowledge_engine.stat.models.runs import CollectorRun, Run

__all__ = ["StatBase", "Run", "CollectorRun"]
