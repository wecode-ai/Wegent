"""Bind compiled plugin bytes to successful jobs of the protected pipeline."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable
from typing import Any

import httpx

from app.services.plugin_publication_gitlab_service import (
    PluginPublicationGitLabError,
    PluginPublicationGitLabVerificationError,
)

MAX_BUILD_BYTES = 50 * 1024 * 1024


def verify_build_artifact(
    *,
    client: httpx.Client,
    request_json: Callable[..., Any],
    project_api: str,
    pipeline_id: int,
    commit_sha: str,
    expected_sha256: str,
) -> None:
    jobs = []
    for page in range(1, 101):
        batch = request_json(
            f"/pipelines/{pipeline_id}/jobs",
            params={"per_page": 100, "page": page, "include_retried": "false"},
        )
        if not isinstance(batch, list):
            raise PluginPublicationGitLabVerificationError(
                "Invalid build job inventory"
            )
        jobs.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise PluginPublicationGitLabVerificationError(
            "Build job inventory is too large"
        )
    selected = {}
    for name in ("package_plugin", "unit_linux"):
        matching = [job for job in jobs if job.get("name") == name]
        if len(matching) != 1:
            raise PluginPublicationGitLabVerificationError(f"Missing unique {name} job")
        job = matching[0]
        if (
            job.get("status") != "success"
            or job.get("pipeline", {}).get("id") != pipeline_id
            or job.get("commit", {}).get("id", "").lower() != commit_sha.lower()
            or type(job.get("id")) is not int
            or job["id"] <= 0
        ):
            raise PluginPublicationGitLabVerificationError(
                f"{name} did not pass for the published commit and pipeline"
            )
        selected[name] = job
    test_job_id = selected["unit_linux"]["id"]
    receipt_url = (
        f"{project_api}/jobs/{test_job_id}/artifacts/.ci-artifacts/tested-plugin.sha256"
    )
    try:
        with client.stream(
            "GET", receipt_url, follow_redirects=False, timeout=30
        ) as response:
            response.raise_for_status()
            receipt = b""
            for chunk in response.iter_bytes(128):
                receipt += chunk
                if len(receipt) > 65:
                    raise PluginPublicationGitLabVerificationError(
                        "Invalid test artifact receipt"
                    )
    except httpx.HTTPError as exc:
        raise PluginPublicationGitLabError(
            "Unable to verify the tested artifact receipt"
        ) from exc
    if receipt != (expected_sha256 + "\n").encode("ascii"):
        raise PluginPublicationGitLabVerificationError(
            "Test job did not verify this build artifact"
        )
    job_id = selected["package_plugin"]["id"]
    url = f"{project_api}/jobs/{job_id}/artifacts/.ci-artifacts/plugin.zip"
    digest = hashlib.sha256()
    size = 0
    try:
        # No caller URL or cross-host redirect can receive the GitLab token.
        with client.stream("GET", url, follow_redirects=False, timeout=120) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes(1024 * 1024):
                size += len(chunk)
                if size > MAX_BUILD_BYTES:
                    raise PluginPublicationGitLabVerificationError(
                        "Build artifact is too large"
                    )
                digest.update(chunk)
    except httpx.HTTPError as exc:
        raise PluginPublicationGitLabError(
            "Unable to verify the GitLab build artifact"
        ) from exc
    if not size or not hmac.compare_digest(digest.hexdigest(), expected_sha256):
        raise PluginPublicationGitLabVerificationError(
            "Published plugin differs from the successful GitLab build artifact"
        )
