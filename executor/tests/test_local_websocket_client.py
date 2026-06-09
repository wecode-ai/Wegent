# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from executor.modes.local.websocket_client import build_runtime_auth_file_report


def test_build_runtime_auth_file_report_reports_codex_auth_presence(tmp_path):
    report = build_runtime_auth_file_report(home=tmp_path)

    assert report == {
        "codex": {
            "target_path": "~/.codex/auth.json",
            "exists": False,
        }
    }

    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    (codex_dir / "auth.json").write_text('{"token":"secret"}', encoding="utf-8")

    assert build_runtime_auth_file_report(home=tmp_path)["codex"]["exists"] is True
