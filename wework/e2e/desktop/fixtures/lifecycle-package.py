"""Archive a lifecycle fixture without rebuilding its verified native binaries."""

import hashlib
import json
import sys
import zipfile
from pathlib import Path


def archive_package(root: Path) -> dict[str, str | int]:
    archive_path = root.with_name(f"{root.name}.zip")
    with zipfile.ZipFile(
        archive_path, "x", zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise ValueError("Lifecycle package must not contain symbolic links")
            if path.is_file():
                archive.write(path, path.relative_to(root).as_posix())
    data = archive_path.read_bytes()
    return {
        "path": str(archive_path),
        "sha256": hashlib.sha256(data).hexdigest(),
        "sizeBytes": len(data),
    }


if __name__ == "__main__":
    print(json.dumps(archive_package(Path(sys.argv[1]))))
