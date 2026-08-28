from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

SHARED_COMPONENT_IDS = frozenset({"coreDsh", "codex", "dws"})


@dataclass(frozen=True)
class RuntimeAssetPair:
    archive: Path
    descriptor: Path
    archive_bytes: int
    archive_sha256: str


@dataclass(frozen=True)
class ComponentAsset:
    component_id: str
    archive: Path
    archive_bytes: int
    archive_sha256: str


def load_component_assets(
    output_dir: Path,
    platform: str,
    arch: str,
    version: str,
) -> list[ComponentAsset]:
    descriptor_path = output_dir / f"components-{platform}-{arch}.json"
    descriptor = _read_json(descriptor_path, "component descriptor")
    if (
        descriptor.get("schemaVersion") != 1
        or descriptor.get("appVersion") != version
        or descriptor.get("platform") != platform
        or descriptor.get("arch") != arch
    ):
        raise SystemExit(f"Invalid component descriptor metadata: {descriptor_path}")

    components = descriptor.get("components")
    if not isinstance(components, dict) or not components:
        raise SystemExit(
            f"Component descriptor contains no components: {descriptor_path}"
        )

    assets = []
    for component_id, component in components.items():
        if not isinstance(component_id, str) or not isinstance(component, dict):
            raise SystemExit(f"Invalid component descriptor entry: {descriptor_path}")
        asset_name = component.get("assetName")
        archive_sha256 = component.get("archiveSha256")
        if (
            not isinstance(asset_name, str)
            or Path(asset_name).name != asset_name
            or not asset_name.endswith(".tar.gz")
            or not _is_sha256(archive_sha256)
        ):
            raise SystemExit(
                f"Invalid component asset metadata for {component_id}: {descriptor_path}"
            )
        archive = output_dir / asset_name
        archive_bytes = archive.stat().st_size if archive.is_file() else 0
        if archive_bytes <= 0 or _file_sha256(archive) != archive_sha256:
            raise SystemExit(
                f"Component archive does not match its descriptor: {archive}"
            )
        assets.append(
            ComponentAsset(
                component_id=component_id,
                archive=archive,
                archive_bytes=archive_bytes,
                archive_sha256=archive_sha256,
            )
        )
    return assets


def publish_component_assets(
    client: object,
    bucket: str,
    release_prefix: str,
    shared_prefix: str,
    assets: list[ComponentAsset],
    upload: Callable[[Path, str], None],
) -> None:
    for asset in assets:
        prefix = (
            shared_prefix
            if asset.component_id in SHARED_COMPONENT_IDS
            else release_prefix
        )
        object_name = _storage_key(prefix, asset.archive.name)
        if _object_exists(client, bucket, object_name):
            if not _remote_file_matches(
                client,
                bucket,
                object_name,
                asset.archive_bytes,
                asset.archive_sha256,
            ):
                raise SystemExit(
                    f"Published component archive does not match {asset.archive.name}"
                )
            print(f"Reusing published component: {asset.archive.name}")
            continue
        upload(asset.archive, prefix)


def publish_component_manifest(
    client: object,
    bucket: str,
    prefix: str,
    output_dir: Path,
    channel: str,
    platform: str,
    arch: str,
    version: str,
    source_sha: str,
    component_only: bool,
    allow_different_app_version: bool,
    upload: Callable[[Path, str], None],
) -> bool:
    path = output_dir / f"components-{channel}-{platform}-{arch}.json"
    manifest = _read_json(path, "component manifest")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("appVersion") != version
        or manifest.get("sourceSha") != source_sha
        or manifest.get("channel") != channel
        or manifest.get("platform") != platform
        or manifest.get("arch") != arch
        or not isinstance(manifest.get("components"), dict)
    ):
        raise SystemExit(f"Invalid component manifest metadata: {path}")

    if component_only:
        current = _read_remote_json(
            client,
            bucket,
            _storage_key(prefix, path.name),
        )
        if current is None:
            raise SystemExit(
                f"Cannot publish components without an existing {channel} app release"
            )
        current_version = current.get("appVersion")
        if current_version != version:
            if allow_different_app_version:
                print(
                    f"Keeping {channel} component manifest at app version "
                    f"{current_version}."
                )
                return False
            raise SystemExit(
                f"The {channel} channel advanced from {version} to "
                f"{current_version} while components were building"
            )

    upload(path, prefix)
    return True


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
            if not _remote_descriptor_matches(
                client, bucket, descriptor_key, pair.descriptor
            ):
                raise SystemExit(
                    f"Published runtime descriptor does not match {pair.descriptor.name}"
                )
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


def _read_json(path: Path, description: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid {description} {path}: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid {description}: {path}")
    return value


def _read_remote_json(
    client: object,
    bucket: str,
    object_name: str,
) -> dict | None:
    from minio.error import S3Error

    response = None
    try:
        response = client.get_object(bucket, object_name)
        value = json.loads(response.read().decode("utf-8"))
        return value if isinstance(value, dict) else None
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            return None
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        if response is not None:
            response.close()
            response.release_conn()


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


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )


def _storage_key(prefix: str, filename: str) -> str:
    return "/".join(part for part in (prefix.strip("/"), filename) if part)


def _remote_file_matches(
    client: object,
    bucket: str,
    object_name: str,
    expected_bytes: int,
    expected_sha256: str,
) -> bool:
    metadata = client.stat_object(bucket, object_name)
    if metadata.size != expected_bytes:
        return False
    response = client.get_object(bucket, object_name)
    digest = sha256()
    try:
        while chunk := response.read(64 * 1024):
            digest.update(chunk)
    finally:
        response.close()
        response.release_conn()
    return digest.hexdigest() == expected_sha256


def _remote_archive_matches(
    client: object,
    bucket: str,
    object_name: str,
    pair: RuntimeAssetPair,
) -> bool:
    return _remote_file_matches(
        client,
        bucket,
        object_name,
        pair.archive_bytes,
        pair.archive_sha256,
    )


def _remote_descriptor_matches(
    client: object,
    bucket: str,
    object_name: str,
    local_descriptor: Path,
) -> bool:
    response = client.get_object(bucket, object_name)
    try:
        remote = json.loads(response.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    finally:
        response.close()
        response.release_conn()
    return remote == _read_descriptor(local_descriptor)
