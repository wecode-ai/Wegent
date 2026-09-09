"""Keep the standalone internal-CI build runner aligned with the host contract."""

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    tests = (
        (ROOT / "shared/tests/test_plugin_build.py")
        .read_text()
        .replace(
            "from shared import plugin_build",
            'import sys\nsys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))\nimport plugin_build',
        )
    )
    files = {
        "scripts/plugin_build.py": (ROOT / "shared/plugin_build.py").read_bytes(),
        "tests/test_plugin_build.py": tests.encode(),
    }
    for name, content in files.items():
        target = args.repository / name
        if args.check:
            if not target.is_file() or target.read_bytes() != content:
                raise ValueError(f"CI build runner differs from host contract: {name}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)


if __name__ == "__main__":
    main()
