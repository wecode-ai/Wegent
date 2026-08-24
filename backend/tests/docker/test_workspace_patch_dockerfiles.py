# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts for workspace dependency patches in Node image builds."""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCKERFILES = (
    ROOT / "docker" / "frontend" / "Dockerfile",
    ROOT / "docker" / "standalone" / "Dockerfile",
)


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda path: path.parent.name)
def test_pnpm_install_stages_copy_workspace_patches(dockerfile: Path):
    content = dockerfile.read_text(encoding="utf-8")
    install_stages = [
        stage
        for stage in re.split(r"(?m)^FROM ", content)[1:]
        if "pnpm install --frozen-lockfile" in stage
    ]

    assert install_stages, f"no pnpm install stage found in {dockerfile}"
    for stage in install_stages:
        copy_index = stage.find("COPY patches ./patches")
        install_index = stage.find("pnpm install --frozen-lockfile")
        assert 0 <= copy_index < install_index
