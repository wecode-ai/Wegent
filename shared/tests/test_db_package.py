# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import subprocess
import sys
from pathlib import Path


def test_importing_capability_reference_with_sqlite_config_succeeds(
    tmp_path: Path,
) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{tmp_path / 'wegent.db'}"

    result = subprocess.run(
        [sys.executable, "-c", "import shared.db.capability_reference"],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
