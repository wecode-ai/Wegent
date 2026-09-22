# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
import sys
from pathlib import Path


def test_access_helpers_do_not_initialize_loop_item_service() -> None:
    backend_root = Path(__file__).resolve().parents[2]
    script = """
import sys

from app.services.loop_items.access import can_view_item

assert can_view_item is not None
assert "app.services.loop_items.service" not in sys.modules
"""

    subprocess.run(
        [sys.executable, "-c", script],
        cwd=backend_root,
        check=True,
    )
