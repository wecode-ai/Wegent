from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path


@dataclass(frozen=True)
class RuntimeAssetPair:
    archive: Path
    descriptor: Path
    archive_bytes: int
    archive_sha256: str


def load_runtime_asset_pairs(output_dir: Path) -> list[RuntimeAssetPair]:
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
        or not assets
        or not all(isinstance(asset, dict) for asset in assets)
    ):
        raise SystemExit("Runtime asset manifest must contain runtime asset pairs")
    kinds = [asset.get("kind") for asset in assets]
    if kinds.count("node") != 1 or kinds.count("harness") < 1:
        raise SystemExit(
            "Runtime asset manifest must contain one node and at least one harness runtime"
        )

    pairs = []
    for asset in assets:
        archive_name = asset.get("archiveName")
        descriptor_name = asset.get("descriptorName")
        if (
            not isinstance(archive_name, str)
            or not archive_name
            or Path(archive_name).name != archive_name
            or not archive_name.endswith(".tar.gz")
            or not isinstance(descriptor_name, str)
            or Path(descriptor_name).name != descriptor_name
            or descriptor_name != archive_name.removesuffix(".tar.gz") + ".json"
        ):
            raise SystemExit("Runtime asset manifest contains an invalid asset pair")
        archive = output_dir / archive_name
        descriptor = output_dir / descriptor_name
        missing = [str(path) for path in (archive, descriptor) if not path.is_file()]
        if missing:
            raise SystemExit(f"Runtime release assets not found: {', '.join(missing)}")
        metadata = _read_descriptor(descriptor)
        archive_bytes = metadata.get("archiveBytes")
        archive_sha256 = metadata.get("archiveSha256")
        if (
            metadata.get("assetName") != archive_name
            or not isinstance(archive_bytes, int)
            or archive_bytes <= 0
            or not isinstance(archive_sha256, str)
            or len(archive_sha256) != 64
            or any(
                character not in "0123456789abcdefABCDEF"
                for character in archive_sha256
            )
        ):
            raise SystemExit(f"Invalid runtime descriptor: {descriptor}")
        if (
            archive.stat().st_size != archive_bytes
            or _file_sha256(archive) != archive_sha256
        ):
            raise SystemExit(
                f"Runtime archive does not match its descriptor: {archive}"
            )
        pairs.append(
            RuntimeAssetPair(
                archive=archive,
                descriptor=descriptor,
                archive_bytes=archive_bytes,
                archive_sha256=archive_sha256,
            )
        )
    return pairs


def publish_runtime_asset_pairs(
    client: object,
    bucket: str,
    prefix: str,
    output_dir: Path,
    upload: Callable[[Path], None],
) -> None:
    for pair in load_runtime_asset_pairs(output_dir):
        archive_key = "/".join(
            part for part in (prefix.strip("/"), pair.archive.name) if part
        )
        descriptor_key = "/".join(
            part for part in (prefix.strip("/"), pair.descriptor.name) if part
        )
        archive_exists = _object_exists(client, bucket, archive_key)
        descriptor_exists = _object_exists(client, bucket, descriptor_key)
        if archive_exists and descriptor_exists:
            print(f"Reusing published runtime: {pair.archive.name}")
            continue
        if archive_exists:
            if not _remote_archive_matches(client, bucket, archive_key, pair):
                raise SystemExit(
                    f"Published runtime archive does not match {pair.archive.name}"
                )
            upload(pair.descriptor)
            print(f"Published descriptor for legacy runtime: {pair.archive.name}")
            continue
        if descriptor_exists:
            raise SystemExit(
                f"Runtime publication is incomplete for {pair.archive.name}"
            )
        upload(pair.archive)
        upload(pair.descriptor)


def _object_exists(client: object, bucket: str, object_name: str) -> bool:
    from minio.error import S3Error

    try:
        client.stat_object(bucket, object_name)
        return True
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return False
        raise


def _read_descriptor(path: Path) -> dict:
    try:
        descriptor = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid runtime descriptor {path}: {error}") from error
    if not isinstance(descriptor, dict):
        raise SystemExit(f"Invalid runtime descriptor: {path}")
    return descriptor


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as file:
        while chunk := file.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _remote_archive_matches(
    client: object,
    bucket: str,
    object_name: str,
    pair: RuntimeAssetPair,
) -> bool:
    metadata = client.stat_object(bucket, object_name)
    if metadata.size != pair.archive_bytes:
        return False
    response = client.get_object(bucket, object_name)
    digest = sha256()
    try:
        while chunk := response.read(64 * 1024):
            digest.update(chunk)
    finally:
        response.close()
        response.release_conn()
    return digest.hexdigest() == pair.archive_sha256
