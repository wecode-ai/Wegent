# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

import yaml

PUBLIC_SHELLS_PATH = (
    Path(__file__).resolve().parents[2] / "init_data" / "01-public-shells.yaml"
)


def test_public_shells_include_first_class_codex_runtime() -> None:
    shells = [
        document
        for document in yaml.safe_load_all(
            PUBLIC_SHELLS_PATH.read_text(encoding="utf-8")
        )
        if document
    ]

    codex = next(shell for shell in shells if shell["metadata"]["name"] == "Codex")
    assert codex["spec"]["shellType"] == "Codex"
    assert codex["metadata"]["labels"]["type"] == "local_engine"
    assert codex["spec"]["supportModel"] == ["openai"]
