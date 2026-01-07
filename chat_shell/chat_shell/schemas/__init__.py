# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pydantic schemas for CRD objects."""

from .kind import (
    Ghost,
    GhostSpec,
    Model,
    ModelSpec,
    Skill,
    SkillProviderConfig,
    SkillSpec,
    SkillToolDeclaration,
)

__all__ = [
    "Ghost",
    "GhostSpec",
    "Model",
    "ModelSpec",
    "Skill",
    "SkillSpec",
    "SkillProviderConfig",
    "SkillToolDeclaration",
]
