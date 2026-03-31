# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability helpers for embedding model inputs."""

from __future__ import annotations

from typing import Iterable

SUPPORTED_ADDITIONAL_INPUT_MODALITIES = {"image"}


def normalize_additional_input_modalities(
    modalities: Iterable[str] | None,
) -> list[str]:
    """Normalize additional input modalities with text-only fallback."""
    if not modalities:
        return []

    normalized: list[str] = []
    for modality in modalities:
        if not isinstance(modality, str):
            continue
        value = modality.strip().lower()
        if not value or value not in SUPPORTED_ADDITIONAL_INPUT_MODALITIES:
            continue
        if value not in normalized:
            normalized.append(value)
    return normalized


def embedding_supports_image_input(modalities: Iterable[str] | None) -> bool:
    """Return whether the config explicitly declares image input support."""
    return "image" in normalize_additional_input_modalities(modalities)
