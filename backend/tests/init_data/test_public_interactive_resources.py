# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for public agents that reference interactive form capabilities."""

from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_RESOURCES_PATH = BACKEND_ROOT / "init_data" / "02-public-resources.yaml"


def _load_public_resources() -> list[dict]:
    with PUBLIC_RESOURCES_PATH.open("r", encoding="utf-8") as handle:
        return [
            doc
            for doc in yaml.safe_load_all(handle)
            if isinstance(doc, dict) and doc.get("kind") and doc.get("metadata")
        ]


def test_ghosts_that_reference_interactive_forms_include_interactive_skill() -> None:
    resources = _load_public_resources()

    offenders = []
    for resource in resources:
        if resource.get("kind") != "Ghost":
            continue

        spec = resource.get("spec") or {}
        system_prompt = spec.get("systemPrompt") or ""
        if "interactive_form_question" not in system_prompt:
            continue

        skills = spec.get("skills") or []
        if "interactive" not in skills:
            offenders.append(resource["metadata"].get("name"))

    assert offenders == []
