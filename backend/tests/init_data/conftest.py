"""Make the canonical Rust-owned resource packages importable in asset tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend-rs"))
