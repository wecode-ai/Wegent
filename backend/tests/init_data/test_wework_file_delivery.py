# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The default device agent must use Wegent's actual artifact delivery contract."""

from pathlib import Path

import yaml


def test_wework_prompt_declares_files_instead_of_inventing_download_links() -> None:
    path = Path(__file__).parents[2] / "init_data" / "02-public-resources.yaml"
    resources = yaml.safe_load_all(path.read_text(encoding="utf-8"))
    ghost = next(
        resource
        for resource in resources
        if resource
        and resource.get("kind") == "Ghost"
        and resource["metadata"]["namespace"] == "default"
        and resource["metadata"]["name"] == "wegent-wework"
    )
    prompt = ghost["spec"]["systemPrompt"]

    assert '"$WEGENT_EXECUTOR_BINARY" artifact declare --path' in prompt
    assert "[WEGENT_ARTIFACT]" in prompt
    assert "metadata only" in prompt
    assert "not source files, caches, logs, or intermediate files" in prompt
    assert "Do not invent download URLs" in prompt
    assert "computer://" not in prompt
    assert "mnt/outputs" not in prompt
