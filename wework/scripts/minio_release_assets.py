from __future__ import annotations

import json
from pathlib import Path


def load_runtime_assets(output_dir: Path) -> list[Path]:
    manifest_path = output_dir / "release-runtime-assets.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(
            f"Invalid runtime asset manifest {manifest_path}: {error}"
        ) from error

    assets = manifest.get("assets")
    if (
        not isinstance(assets, list)
        or len(assets) != 2
        or not all(isinstance(asset, dict) for asset in assets)
        or {asset.get("kind") for asset in assets} != {"harness", "node"}
    ):
        raise SystemExit("Runtime asset manifest must contain harness and node assets")

    names = [asset.get("name") for asset in assets]
    if not all(
        isinstance(name, str)
        and name
        and Path(name).name == name
        and name.endswith(".tar.gz")
        for name in names
    ):
        raise SystemExit("Runtime asset manifest contains an invalid asset name")

    paths = [output_dir / name for name in names]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise SystemExit(f"Runtime release assets not found: {', '.join(missing)}")
    return paths
