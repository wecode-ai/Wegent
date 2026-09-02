#!/usr/bin/env python3
"""Preflight and optionally publish one protected GitLab plugin artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas.plugin_publication import (  # noqa: E402
    PluginReleaseMetadata,
    PluginReleasePublishResponse,
)
from app.services.plugin_package_parser import plugin_package_parser  # noqa: E402
from app.services.plugin_publication_artifact import (  # noqa: E402
    canonical_complete_tree_sha256,
    expected_release_idempotency_key,
)

DEFAULT_RELEASE_URL_ENV = "WEWORK_PLUGIN_RELEASE_URL"
DEFAULT_RELEASE_TOKEN_ENV = "WEWORK_PLUGIN_RELEASE_TOKEN"
RELEASE_PATH = "/api/internal/plugins/releases"


class ReleaseSmokeTestError(RuntimeError):
    """A safe, user-facing release smoke-test failure."""


@dataclass(frozen=True)
class ReleasePreflight:
    metadata: PluginReleaseMetadata
    raw_metadata: dict[str, Any]
    metadata_json: str
    package: bytes
    idempotency_key: str
    complete_tree_sha256: str


def load_release_artifact(
    metadata_path: Path,
    package_path: Path,
) -> ReleasePreflight:
    """Validate the same immutable envelope accepted by the release endpoint."""
    try:
        raw_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ReleaseSmokeTestError(f"Cannot read metadata: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ReleaseSmokeTestError("Release metadata is not valid JSON") from exc
    if not isinstance(raw_metadata, dict):
        raise ReleaseSmokeTestError("Release metadata must be a JSON object")
    try:
        metadata = PluginReleaseMetadata.model_validate(raw_metadata)
    except ValidationError as exc:
        raise ReleaseSmokeTestError(f"Release metadata is invalid: {exc}") from exc
    try:
        package = package_path.read_bytes()
    except OSError as exc:
        raise ReleaseSmokeTestError(f"Cannot read package: {exc}") from exc
    artifact_sha256 = hashlib.sha256(package).hexdigest()
    if artifact_sha256 != metadata.artifact.sha256:
        raise ReleaseSmokeTestError("Package SHA256 does not match release metadata")
    if len(package) != metadata.artifact.sizeBytes:
        raise ReleaseSmokeTestError("Package size does not match release metadata")
    try:
        parsed = plugin_package_parser.parse_package(package)
        complete_tree_sha256 = canonical_complete_tree_sha256(package)
    except HTTPException as exc:
        raise ReleaseSmokeTestError(f"Plugin package is invalid: {exc.detail}") from exc
    if parsed.name != metadata.plugin.slug or parsed.version != metadata.plugin.version:
        raise ReleaseSmokeTestError(
            "Package manifest identity does not match release metadata"
        )
    return ReleasePreflight(
        metadata=metadata,
        raw_metadata=raw_metadata,
        metadata_json=json.dumps(
            raw_metadata,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ),
        package=package,
        idempotency_key=expected_release_idempotency_key(raw_metadata),
        complete_tree_sha256=complete_tree_sha256,
    )


def validate_endpoint(endpoint: str, *, allow_http: bool) -> str:
    normalized = endpoint.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.path != RELEASE_PATH or parsed.query or parsed.fragment:
        raise ReleaseSmokeTestError(f"Release endpoint must end with {RELEASE_PATH}")
    if parsed.username or parsed.password:
        raise ReleaseSmokeTestError("Release endpoint must not contain credentials")
    if parsed.scheme == "https" and parsed.netloc:
        return normalized
    if allow_http and parsed.scheme == "http" and parsed.netloc:
        return normalized
    raise ReleaseSmokeTestError(
        "Release endpoint must be absolute HTTPS; use --allow-http only for a "
        "trusted local test deployment"
    )


def validate_release_ref(metadata: PluginReleaseMetadata, expected_ref: str) -> None:
    """Reject MR artifacts before attempting a protected-branch release."""
    normalized_expected = expected_ref.strip().removeprefix("refs/heads/")
    normalized_actual = metadata.source.ref.removeprefix("refs/heads/")
    if not normalized_expected:
        raise ReleaseSmokeTestError("Expected release ref must not be empty")
    if normalized_actual != normalized_expected:
        raise ReleaseSmokeTestError(
            f"Artifact ref is {metadata.source.ref!r}, expected protected "
            f"{normalized_expected!r}; download artifacts from the post-merge "
            "push pipeline"
        )


def render_curl(
    *,
    endpoint: str,
    metadata_path: Path,
    package_path: Path,
    package_filename: str,
    idempotency_key: str,
    token_env: str,
) -> str:
    """Render a copyable command without exposing the credential value."""
    return " \\\n  ".join(
        [
            "curl --fail-with-body --silent --show-error",
            f'-H "Authorization: Bearer ${{{token_env}}}"',
            f"-H {shlex.quote(f'Idempotency-Key: {idempotency_key}')}",
            ("-F " + shlex.quote(f"metadata=<{metadata_path};type=application/json")),
            (
                "-F "
                + shlex.quote(
                    f"package=@{package_path};filename={package_filename};"
                    "type=application/zip"
                )
            ),
            shlex.quote(endpoint),
        ]
    )


def publish_release(
    preflight: ReleasePreflight,
    *,
    endpoint: str,
    token: str,
    timeout_seconds: float,
    transport: httpx.BaseTransport | None = None,
) -> PluginReleasePublishResponse:
    """Submit the exact artifact while keeping the release key out of argv."""
    with httpx.Client(
        follow_redirects=False,
        timeout=timeout_seconds,
        transport=transport,
    ) as client:
        try:
            response = client.post(
                endpoint,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Idempotency-Key": preflight.idempotency_key,
                    "User-Agent": "wegent-plugin-release-smoke-test/1",
                },
                files={
                    "metadata": (
                        None,
                        preflight.metadata_json,
                        "application/json",
                    ),
                    "package": (
                        preflight.metadata.artifact.file,
                        preflight.package,
                        "application/zip",
                    ),
                },
            )
        except httpx.HTTPError as exc:
            raise ReleaseSmokeTestError(
                f"Release endpoint is unavailable: {exc}"
            ) from exc
    if response.is_redirect:
        raise ReleaseSmokeTestError(
            f"Release endpoint returned redirect HTTP {response.status_code}"
        )
    if not response.is_success:
        detail = _response_detail(response)
        raise ReleaseSmokeTestError(
            f"Release endpoint returned HTTP {response.status_code}: {detail}"
        )
    try:
        result = PluginReleasePublishResponse.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        raise ReleaseSmokeTestError(
            "Release endpoint returned an invalid response"
        ) from exc
    expected = preflight.metadata
    if (
        result.pluginId <= 0
        or result.releaseId <= 0
        or result.catalogNamespace != "enterprise"
        or result.slug != expected.plugin.slug
        or result.version != expected.plugin.version
        or result.sha256 != expected.artifact.sha256
    ):
        raise ReleaseSmokeTestError("Release response does not match the artifact")
    return result


def verify_marketplace(
    result: PluginReleasePublishResponse,
    *,
    endpoint: str,
    timeout_seconds: float,
    transport: httpx.BaseTransport | None = None,
) -> None:
    """Confirm the published release is now the enterprise catalog latest."""
    parsed = urlparse(endpoint)
    marketplace_url = f"{parsed.scheme}://{parsed.netloc}/api/plugins/marketplace"
    with httpx.Client(timeout=timeout_seconds, transport=transport) as client:
        try:
            response = client.get(marketplace_url, params={"q": result.slug})
        except httpx.HTTPError as exc:
            raise ReleaseSmokeTestError(
                "Release succeeded, but marketplace verification is unavailable: "
                f"{exc}"
            ) from exc
    if not response.is_success:
        raise ReleaseSmokeTestError(
            "Release succeeded, but marketplace verification returned "
            f"HTTP {response.status_code}: {_response_detail(response)}"
        )
    try:
        items = response.json().get("items", [])
    except (AttributeError, ValueError) as exc:
        raise ReleaseSmokeTestError(
            "Release succeeded, but marketplace verification returned invalid JSON"
        ) from exc
    matched = next(
        (
            item
            for item in items
            if item.get("id") == result.pluginId
            and item.get("catalogNamespace") == "enterprise"
        ),
        None,
    )
    if not matched:
        raise ReleaseSmokeTestError(
            "Release succeeded, but the enterprise marketplace item was not found"
        )
    if (
        matched.get("version") != result.version
        or matched.get("latestReleaseId") != result.releaseId
    ):
        raise ReleaseSmokeTestError(
            "Release succeeded, but the enterprise marketplace latest release differs"
        )


def _response_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return "non-JSON response"
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str):
            return detail[:500]
    return "request rejected"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a package_plugin artifact and optionally call the protected "
            "Wegent release endpoint. Without --execute, no data is changed."
        )
    )
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument(
        "--endpoint",
        default=os.environ.get(DEFAULT_RELEASE_URL_ENV, ""),
        help=f"Defaults to ${DEFAULT_RELEASE_URL_ENV}",
    )
    parser.add_argument(
        "--token-env",
        default=DEFAULT_RELEASE_TOKEN_ENV,
        help="Environment variable containing the plugin_release key",
    )
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--expected-ref",
        default="master",
        help="Protected release branch expected in metadata (default: master)",
    )
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="Allow HTTP only for a trusted local test deployment",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually publish; omission performs preflight only",
    )
    parser.add_argument(
        "--skip-marketplace-check",
        action="store_true",
        help="Do not verify the resulting enterprise marketplace item",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        endpoint = (
            validate_endpoint(args.endpoint, allow_http=args.allow_http)
            if args.endpoint.strip()
            else ""
        )
        if args.execute and not endpoint:
            raise ReleaseSmokeTestError(
                f"--endpoint or {DEFAULT_RELEASE_URL_ENV} is required with --execute"
            )
        preflight = load_release_artifact(args.metadata, args.package)
        validate_release_ref(preflight.metadata, args.expected_ref)
        summary = {
            "mode": "execute" if args.execute else "preflight",
            "slug": preflight.metadata.plugin.slug,
            "version": preflight.metadata.plugin.version,
            "projectId": preflight.metadata.source.projectId,
            "ref": preflight.metadata.source.ref,
            "commitSha": preflight.metadata.source.sourceCommitSha,
            "pipelineId": preflight.metadata.source.pipelineId,
            "artifactSha256": preflight.metadata.artifact.sha256,
            "completeTreeSha256": preflight.complete_tree_sha256,
            "idempotencyKey": preflight.idempotency_key,
            "requestId": preflight.metadata.requestId,
            "revision": preflight.metadata.revision,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if endpoint:
            print("\nEquivalent curl command (token value is not printed):")
            print(
                render_curl(
                    endpoint=endpoint,
                    metadata_path=args.metadata,
                    package_path=args.package,
                    package_filename=preflight.metadata.artifact.file,
                    idempotency_key=preflight.idempotency_key,
                    token_env=args.token_env,
                )
            )
        else:
            print("\nRelease endpoint is not configured; curl generation was skipped.")
        if not args.execute:
            print("\nPreflight passed. Re-run with --execute to publish.")
            return 0
        token = os.environ.get(args.token_env, "").strip()
        if not token:
            raise ReleaseSmokeTestError(f"{args.token_env} is required with --execute")
        result = publish_release(
            preflight,
            endpoint=endpoint,
            token=token,
            timeout_seconds=args.timeout,
        )
        if not args.skip_marketplace_check:
            verify_marketplace(
                result,
                endpoint=endpoint,
                timeout_seconds=args.timeout,
            )
        print(
            "\nRelease verified:\n"
            + json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2)
        )
        if preflight.metadata.requestId:
            print(
                "\nRequest timeline check:\n"
                f'curl --fail-with-body -H "Authorization: Bearer '
                '${WEGENT_USER_TOKEN}" '
                f'"{urlparse(endpoint).scheme}://{urlparse(endpoint).netloc}'
                f'/api/plugins/publication-requests/{preflight.metadata.requestId}"'
            )
        return 0
    except ReleaseSmokeTestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
