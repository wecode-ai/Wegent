# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Controlled GitLab materialization for reviewed plugin snapshots."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Protocol
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.services.plugin_publication_artifact import (
    CanonicalPluginFile,
    canonical_plugin_files,
    canonical_source_tree_sha256,
    canonical_source_tree_sha256_from_files,
)

logger = logging.getLogger(__name__)
AUTO_MERGE_RETRY_DELAYS_SECONDS = (0.25, 0.5, 1.0, 2.0, 4.0)


class PluginPublicationGitLabError(RuntimeError):
    """Raised when controlled GitLab materialization cannot be completed."""


class PluginPublicationGitLabVerificationError(PluginPublicationGitLabError):
    """Raised when authoritative GitLab state rejects supplied provenance."""


@dataclass(frozen=True)
class GitLabMaterialization:
    project_id: str
    project_url: str
    source_branch: str
    merge_request_iid: int
    merge_request_url: str
    merge_request_status: str
    commit_sha: str


@dataclass(frozen=True)
class GitLabMaterializerIdentity:
    user_id: int
    username: str
    project_id: int


class PluginPublicationGitLabGateway(Protocol):
    def materialize(
        self,
        *,
        request_id: int,
        revision: int,
        slug: str,
        plugin_name: str,
        version: str,
        snapshot_sha256: str,
        source_tree_sha256: str,
        package: bytes,
        risk_declaration: dict[str, Any],
        test_notes: str,
    ) -> GitLabMaterialization: ...

    def reconcile(
        self,
        *,
        request_id: int,
        revision: int,
        slug: str,
        snapshot_sha256: str,
        source_tree_sha256: str,
    ) -> GitLabMaterialization: ...

    def close_merge_request(self, *, merge_request_iid: int) -> None: ...

    def verify_release_provenance(
        self,
        *,
        project_id: str,
        ref: str,
        commit_sha: str,
        pipeline_id: int,
        pipeline_url: str,
        slug: str,
        artifact_tree_sha256: str,
        merge_request_iid: int = 0,
        source_branch: str = "",
    ) -> None: ...


class PluginPublicationGitLabService:
    """Write only validated snapshots to one configured GitLab project."""

    def __init__(
        self,
        *,
        api_url: str | None = None,
        project_id: str | None = None,
        project_url: str | None = None,
        token: str | None = None,
        materializer_user_id: int | None = None,
        target_branch: str | None = None,
        timeout_seconds: float | None = None,
        max_files: int | None = None,
        client_factory: Any | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self.api_url = (
            api_url or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_API_URL
        ).rstrip("/")
        self.project_id = (
            project_id or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID
        )
        self.project_url = (
            project_url or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_URL
        )
        self.token = token or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_TOKEN
        self.materializer_user_id = (
            materializer_user_id
            if materializer_user_id is not None
            else settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_MATERIALIZER_USER_ID
        )
        self.target_branch = (
            target_branch or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH
        )
        self.timeout_seconds = timeout_seconds or float(
            settings.REPOSITORY_READ_TIMEOUT_SECONDS
        )
        self.max_files = (
            max_files or settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_MAX_FILES
        )
        self._client_factory = client_factory or httpx.Client
        self._sleep = sleep or time.sleep

    def materialize(
        self,
        *,
        request_id: int,
        revision: int,
        slug: str,
        plugin_name: str,
        version: str,
        snapshot_sha256: str,
        source_tree_sha256: str,
        package: bytes,
        risk_declaration: dict[str, Any],
        test_notes: str,
    ) -> GitLabMaterialization:
        self._ensure_configured()
        source_branch = self._source_branch(request_id, revision)
        try:
            actual_tree_sha256 = canonical_source_tree_sha256(package)
        except HTTPException as exc:
            raise PluginPublicationGitLabError(str(exc.detail)) from exc
        if actual_tree_sha256 != source_tree_sha256:
            raise PluginPublicationGitLabError(
                "Plugin snapshot source tree does not match the accepted revision"
            )
        files = self._archive_files(package, slug=slug)
        risk_path = f"plugins/{slug}/plugin-risk.json"
        files[risk_path] = CanonicalPluginFile(
            path=risk_path,
            content=json.dumps(
                {
                    "schemaVersion": 1,
                    "riskDeclaration": risk_declaration,
                    "testNotes": test_notes,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ).encode("utf-8"),
            mode=0o644,
        )
        metadata_path = f"plugins/{slug}/.wework-publication.json"
        files[metadata_path] = CanonicalPluginFile(
            path=metadata_path,
            content=json.dumps(
                {
                    "requestId": request_id,
                    "revision": revision,
                    "snapshotSha256": snapshot_sha256,
                    "sourceTreeSha256": source_tree_sha256,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ).encode("utf-8"),
            mode=0o644,
        )
        with self._client() as client:
            identity = self._materializer_identity(client)
            binding = self._materializer_binding(
                identity=identity,
                source_branch=source_branch,
                request_id=request_id,
                revision=revision,
                slug=slug,
                snapshot_sha256=snapshot_sha256,
                source_tree_sha256=source_tree_sha256,
            )
            existing_mr = self._find_merge_request(client, source_branch)
            if existing_mr:
                self._verify_controlled_merge_request(
                    existing_mr,
                    identity=identity,
                    source_branch=source_branch,
                    request_id=request_id,
                    revision=revision,
                    snapshot_sha256=snapshot_sha256,
                    binding=binding,
                )
                commit_sha = self._verify_branch_binding(client, source_branch, binding)
                if self._merge_request_head_sha(existing_mr) != commit_sha:
                    raise PluginPublicationGitLabVerificationError(
                        "Existing GitLab merge request head does not match its "
                        "controlled source branch"
                    )
                self._verify_materialized_marker(
                    client,
                    source_branch=source_branch,
                    slug=slug,
                    request_id=request_id,
                    revision=revision,
                    snapshot_sha256=snapshot_sha256,
                    source_tree_sha256=source_tree_sha256,
                )
                self._verify_marketplace_entry(
                    client, source_branch=source_branch, slug=slug
                )
                merge_request = self._schedule_auto_merge(
                    client,
                    merge_request=existing_mr,
                    commit_sha=commit_sha,
                )
                return self._materialization(merge_request, source_branch)
            marketplace_file = self._marketplace_file(
                client,
                slug=slug,
                ref=self.target_branch,
                package=package,
            )
            files[marketplace_file.path] = marketplace_file
            branch = self._branch(client, source_branch)
            if branch:
                self._verify_branch_binding(client, source_branch, binding)
            else:
                self._create_branch(client, source_branch)
            existing_paths = self._list_managed_paths(client, slug, source_branch)
            existing_paths.add(marketplace_file.path)
            actions = self._commit_actions(files, existing_paths)
            commit = self._request(
                client,
                "POST",
                "/repository/commits",
                json={
                    "branch": source_branch,
                    "commit_message": (
                        f"feat(plugin): submit {slug} publication "
                        f"#{request_id} revision {revision}\n\n"
                        f"Wegent-Materializer-User-Id: {identity.user_id}\n"
                        f"Wegent-Materializer-Binding: {binding}"
                    ),
                    "actions": actions,
                },
            )
            commit_sha = self._commit_sha(commit.get("id"))
            merge_request = self._request(
                client,
                "POST",
                "/merge_requests",
                json={
                    "source_branch": source_branch,
                    "target_branch": self.target_branch,
                    "title": self._merge_request_title(
                        plugin_name=plugin_name,
                        slug=slug,
                        version=version,
                    ),
                    "description": (
                        "## Plugin information\n\n"
                        f"- Name: {self._single_line(plugin_name) or slug}\n"
                        f"- Slug: `{slug}`\n"
                        f"- Version: `v{version.removeprefix('v')}`\n"
                        f"- Request: `#{request_id}`\n"
                        f"- Revision: `{revision}`\n\n"
                        f"Wework publication request #{request_id}, revision {revision}.\n\n"
                        f"Snapshot SHA256: `{snapshot_sha256}`\n\n"
                        f"<!-- Wegent-Materializer-Binding: {binding} -->"
                    ),
                    "remove_source_branch": True,
                },
            )
            merge_request.setdefault("sha", commit_sha)
            self._verify_controlled_merge_request(
                merge_request,
                identity=identity,
                source_branch=source_branch,
                request_id=request_id,
                revision=revision,
                snapshot_sha256=snapshot_sha256,
                binding=binding,
            )
            if self._merge_request_head_sha(merge_request) != commit_sha:
                raise PluginPublicationGitLabVerificationError(
                    "Created GitLab merge request head does not match the "
                    "materialized commit"
                )
            merge_request = self._schedule_auto_merge(
                client,
                merge_request=merge_request,
                commit_sha=commit_sha,
            )
            return self._materialization(merge_request, source_branch)

    @staticmethod
    def _single_line(value: str) -> str:
        return " ".join(value.split())

    def _merge_request_title(self, *, plugin_name: str, slug: str, version: str) -> str:
        display_name = self._single_line(plugin_name) or slug
        normalized_version = self._single_line(version).removeprefix("v")
        version_suffix = f" v{normalized_version}" if normalized_version else ""
        return f"Plugin publication: {display_name} ({slug}){version_suffix}"

    def reconcile(
        self,
        *,
        request_id: int,
        revision: int,
        slug: str,
        snapshot_sha256: str,
        source_tree_sha256: str,
    ) -> GitLabMaterialization:
        self._ensure_configured()
        source_branch = self._source_branch(request_id, revision)
        with self._client() as client:
            identity = self._materializer_identity(client)
            merge_request = self._find_merge_request(client, source_branch)
            if not merge_request:
                raise PluginPublicationGitLabError(
                    "Controlled MR was not found for this revision"
                )
            binding = self._materializer_binding(
                identity=identity,
                source_branch=source_branch,
                request_id=request_id,
                revision=revision,
                slug=slug,
                snapshot_sha256=snapshot_sha256,
                source_tree_sha256=source_tree_sha256,
            )
            self._verify_controlled_merge_request(
                merge_request,
                identity=identity,
                source_branch=source_branch,
                request_id=request_id,
                revision=revision,
                snapshot_sha256=snapshot_sha256,
                binding=binding,
                allowed_states={"opened", "merged", "closed"},
            )
            self._verify_branch_binding(client, source_branch, binding)
            self._verify_materialized_marker(
                client,
                source_branch=source_branch,
                slug=slug,
                request_id=request_id,
                revision=revision,
                snapshot_sha256=snapshot_sha256,
                source_tree_sha256=source_tree_sha256,
            )
            self._verify_marketplace_entry(
                client, source_branch=source_branch, slug=slug
            )
            return self._materialization(merge_request, source_branch)

    def close_merge_request(self, *, merge_request_iid: int) -> None:
        self._ensure_configured()
        with self._client() as client:
            self._request(
                client,
                "PUT",
                f"/merge_requests/{merge_request_iid}",
                json={"state_event": "close"},
            )

    def verify_release_provenance(
        self,
        *,
        project_id: str,
        ref: str,
        commit_sha: str,
        pipeline_id: int,
        pipeline_url: str,
        slug: str,
        artifact_tree_sha256: str,
        merge_request_iid: int = 0,
        source_branch: str = "",
    ) -> None:
        """Verify protected-branch and optional controlled-MR state via GitLab."""
        self._ensure_configured()
        normalized_ref = ref.removeprefix("refs/heads/")
        if project_id != self.project_id or normalized_ref != self.target_branch:
            raise PluginPublicationGitLabVerificationError(
                "Release provenance does not target the configured project branch"
            )
        with self._client() as client:
            branch = self._request(
                client,
                "GET",
                f"/repository/branches/{quote(self.target_branch, safe='')}",
            )
            if not branch.get("protected"):
                raise PluginPublicationGitLabVerificationError(
                    "Configured plugin release branch is not protected"
                )
            pipeline = self._request(client, "GET", f"/pipelines/{pipeline_id}")
            if (
                str(pipeline.get("ref") or "") != self.target_branch
                or str(pipeline.get("sha") or "").lower() != commit_sha.lower()
                or str(pipeline.get("source") or "") != "push"
                or str(pipeline.get("status") or "") not in {"running", "success"}
            ):
                raise PluginPublicationGitLabVerificationError(
                    "GitLab pipeline does not authorize this release provenance"
                )
            authoritative_url = str(pipeline.get("web_url") or "")
            if authoritative_url != pipeline_url:
                raise PluginPublicationGitLabVerificationError(
                    "GitLab pipeline URL does not match release provenance"
                )
            repository_tree_sha256 = self._repository_plugin_tree_sha256(
                client,
                slug=slug,
                commit_sha=commit_sha,
            )
            if not hmac.compare_digest(repository_tree_sha256, artifact_tree_sha256):
                raise PluginPublicationGitLabVerificationError(
                    "Release artifact source tree does not match the GitLab commit"
                )
            if merge_request_iid:
                merge_request = self._request(
                    client, "GET", f"/merge_requests/{merge_request_iid}"
                )
                self._verify_merged_request(
                    merge_request,
                    source_branch=source_branch,
                    commit_sha=commit_sha,
                )

    def _verify_merged_request(
        self,
        merge_request: dict[str, Any],
        *,
        source_branch: str,
        commit_sha: str,
    ) -> None:
        diff_refs = merge_request.get("diff_refs") or {}
        commit_candidates = {
            str(merge_request.get("merge_commit_sha") or "").lower(),
            str(merge_request.get("squash_commit_sha") or "").lower(),
            str(merge_request.get("sha") or "").lower(),
            str(diff_refs.get("head_sha") or "").lower(),
        }
        commit_candidates.discard("")
        if (
            str(merge_request.get("state") or "") != "merged"
            or str(merge_request.get("target_branch") or "") != self.target_branch
            or str(merge_request.get("source_branch") or "") != source_branch
            or commit_sha.lower() not in commit_candidates
        ):
            raise PluginPublicationGitLabVerificationError(
                "Controlled merge request does not authorize this release commit"
            )

    def _repository_plugin_tree_sha256(
        self,
        client: httpx.Client,
        *,
        slug: str,
        commit_sha: str,
    ) -> str:
        root = f"plugins/{slug}"
        files: dict[str, CanonicalPluginFile] = {}
        normalized_paths: set[bytes] = set()
        page = 1
        while True:
            items = self._request(
                client,
                "GET",
                "/repository/tree",
                params={
                    "path": root,
                    "ref": commit_sha,
                    "recursive": True,
                    "per_page": 100,
                    "page": page,
                },
            )
            if not isinstance(items, list):
                raise PluginPublicationGitLabVerificationError(
                    "GitLab plugin tree response is invalid"
                )
            for item in items:
                if not isinstance(item, dict):
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree entry is invalid"
                    )
                item_type = str(item.get("type") or "")
                if item_type == "tree":
                    continue
                if item_type != "blob":
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree contains a non-regular file"
                    )
                path = str(item.get("path") or "")
                prefix = f"{root}/"
                if not path.startswith(prefix):
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree contains a path outside the plugin root"
                    )
                relative = unicodedata.normalize("NFC", path[len(prefix) :])
                parts = PurePosixPath(relative).parts
                if (
                    not relative
                    or relative.startswith("/")
                    or "\\" in relative
                    or "\0" in relative
                    or any(part in {"", ".", ".."} for part in parts)
                    or relative != PurePosixPath(*parts).as_posix()
                ):
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree contains an unsafe source path"
                    )
                relative_bytes = relative.encode("utf-8")
                if relative_bytes in normalized_paths:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin source paths collide after normalization"
                    )
                normalized_paths.add(relative_bytes)
                mode = str(item.get("mode") or "")
                if mode not in {"100644", "100755"}:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree contains an unsupported file mode"
                    )
                blob_id = str(item.get("id") or "")
                if not blob_id:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree entry has no blob identity"
                    )
                blob = self._request(
                    client,
                    "GET",
                    f"/repository/blobs/{quote(blob_id, safe='')}",
                )
                if str(blob.get("encoding") or "") != "base64":
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin blob has unsupported encoding"
                    )
                try:
                    content = base64.b64decode(
                        str(blob.get("content") or ""), validate=True
                    )
                except (binascii.Error, ValueError) as exc:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin blob is not valid base64"
                    ) from exc
                files[relative] = CanonicalPluginFile(
                    path=relative,
                    content=content,
                    mode=0o755 if mode == "100755" else 0o644,
                )
                if len(files) > self.max_files:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab plugin tree exceeds the configured file limit"
                    )
            if len(items) < 100:
                break
            page += 1
        if not files:
            raise PluginPublicationGitLabVerificationError(
                "GitLab commit contains no plugin source files"
            )
        return canonical_source_tree_sha256_from_files(files)

    def _client(self) -> httpx.Client:
        return self._client_factory(
            headers={"PRIVATE-TOKEN": self.token, "Accept": "application/json"},
            timeout=self.timeout_seconds,
        )

    def _ensure_configured(self) -> None:
        if not self.api_url or not self.project_id or not self.token:
            raise PluginPublicationGitLabError(
                "Plugin publication GitLab integration is not configured"
            )
        if self.materializer_user_id <= 0:
            raise PluginPublicationGitLabError(
                "Plugin publication GitLab materializer identity is not configured"
            )
        if not self.target_branch:
            raise PluginPublicationGitLabError(
                "Plugin publication target branch is not configured"
            )

    def _project_api(self) -> str:
        return f"{self.api_url}/projects/{quote(self.project_id, safe='')}"

    def _request(
        self,
        client: httpx.Client,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any:
        return self._request_url(
            client, method, f"{self._project_api()}{path}", path, **kwargs
        )

    def _request_api(
        self,
        client: httpx.Client,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any:
        return self._request_url(
            client, method, f"{self.api_url}{path}", path, **kwargs
        )

    def _request_url(
        self,
        client: httpx.Client,
        method: str,
        url: str,
        log_path: str,
        **kwargs: Any,
    ) -> Any:
        try:
            response = client.request(method, url, **kwargs)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            logger.warning(
                "Controlled GitLab request failed: method=%s path=%s status=%s",
                method,
                log_path,
                status_code,
            )
            raise PluginPublicationGitLabError(
                f"GitLab request failed for {method} {log_path}"
            ) from exc
        return response.json()

    def _request_optional(
        self,
        client: httpx.Client,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any | None:
        url = f"{self._project_api()}{path}"
        try:
            response = client.request(method, url, **kwargs)
            if response.status_code == 404:
                return None
            response.raise_for_status()
        except httpx.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            logger.warning(
                "Controlled GitLab request failed: method=%s path=%s status=%s",
                method,
                path,
                status_code,
            )
            raise PluginPublicationGitLabError(
                f"GitLab request failed for {method} {path}"
            ) from exc
        return response.json()

    def _materializer_identity(
        self, client: httpx.Client
    ) -> GitLabMaterializerIdentity:
        user = self._request_api(client, "GET", "/user")
        project = self._request(client, "GET", "")
        user_id = self._positive_int(user.get("id"))
        username = str(user.get("username") or "").strip()
        project_id = self._positive_int(project.get("id"))
        if user_id != self.materializer_user_id or not username or project_id <= 0:
            raise PluginPublicationGitLabVerificationError(
                "GitLab token is not bound to the configured materializer identity"
            )
        if project.get("only_allow_merge_if_pipeline_succeeds") is not True:
            raise PluginPublicationGitLabVerificationError(
                "Controlled GitLab project must require a successful pipeline "
                "before merge"
            )
        return GitLabMaterializerIdentity(
            user_id=user_id,
            username=username,
            project_id=project_id,
        )

    def _positive_int(self, value: Any) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return 0
        return parsed if parsed > 0 else 0

    def _find_merge_request(
        self, client: httpx.Client, source_branch: str
    ) -> dict[str, Any] | None:
        items = self._request(
            client,
            "GET",
            "/merge_requests",
            params={"state": "all", "source_branch": source_branch, "per_page": 20},
        )
        return items[0] if items else None

    def _branch(
        self, client: httpx.Client, source_branch: str
    ) -> dict[str, Any] | None:
        branch_path = f"/repository/branches/{quote(source_branch, safe='')}"
        branch = self._request_optional(client, "GET", branch_path)
        if branch is not None and not isinstance(branch, dict):
            raise PluginPublicationGitLabVerificationError(
                "GitLab source branch response is invalid"
            )
        return branch

    def _create_branch(self, client: httpx.Client, source_branch: str) -> None:
        self._request(
            client,
            "POST",
            "/repository/branches",
            params={"branch": source_branch, "ref": self.target_branch},
        )

    def _materializer_binding(
        self,
        *,
        identity: GitLabMaterializerIdentity,
        source_branch: str,
        request_id: int,
        revision: int,
        slug: str,
        snapshot_sha256: str,
        source_tree_sha256: str,
    ) -> str:
        payload = "\0".join(
            (
                "wegent-plugin-materializer-v1",
                str(identity.user_id),
                str(identity.project_id),
                source_branch,
                str(request_id),
                str(revision),
                slug,
                snapshot_sha256,
                source_tree_sha256,
            )
        ).encode("utf-8")
        signature = hmac.new(
            self.token.encode("utf-8"), payload, hashlib.sha256
        ).hexdigest()
        return f"v1:{signature}"

    def _verify_branch_binding(
        self, client: httpx.Client, source_branch: str, binding: str
    ) -> str:
        branch = self._branch(client, source_branch)
        commit = branch.get("commit") if branch else None
        message = str(commit.get("message") or "") if isinstance(commit, dict) else ""
        expected = f"Wegent-Materializer-Binding: {binding}"
        if expected not in message:
            raise PluginPublicationGitLabVerificationError(
                "Existing GitLab source branch is not bound to this materializer"
            )
        return self._commit_sha(commit.get("id") if isinstance(commit, dict) else None)

    def _schedule_auto_merge(
        self,
        client: httpx.Client,
        *,
        merge_request: dict[str, Any],
        commit_sha: str,
    ) -> dict[str, Any]:
        merge_request_iid = self._positive_int(merge_request.get("iid"))
        if merge_request_iid <= 0:
            raise PluginPublicationGitLabVerificationError(
                "Controlled GitLab merge request has no valid IID"
            )
        ready_merge_request = self._wait_for_merge_request_pipeline(
            client,
            merge_request=merge_request,
            commit_sha=commit_sha,
        )
        if str(ready_merge_request.get("state") or "") == "merged":
            return {**merge_request, **ready_merge_request}
        response = self._request_auto_merge(
            client,
            merge_request=ready_merge_request,
            commit_sha=commit_sha,
        )
        if not isinstance(response, dict):
            raise PluginPublicationGitLabVerificationError(
                "GitLab auto-merge response is invalid"
            )
        state = str(response.get("state") or "")
        if (
            self._positive_int(response.get("iid")) != merge_request_iid
            or state not in {"opened", "merged"}
            or str(response.get("source_branch") or "")
            != str(merge_request.get("source_branch") or "")
            or str(response.get("target_branch") or "") != self.target_branch
            or self._merge_request_head_sha(response) != commit_sha
            or (
                state != "merged"
                and response.get("merge_when_pipeline_succeeds") is not True
            )
        ):
            raise PluginPublicationGitLabVerificationError(
                "GitLab did not register auto-merge for the controlled revision"
            )
        return {**merge_request, **ready_merge_request, **response}

    def _wait_for_merge_request_pipeline(
        self,
        client: httpx.Client,
        *,
        merge_request: dict[str, Any],
        commit_sha: str,
    ) -> dict[str, Any]:
        merge_request_iid = self._positive_int(merge_request.get("iid"))
        for attempt in range(len(AUTO_MERGE_RETRY_DELAYS_SECONDS) + 1):
            current = self._request(
                client,
                "GET",
                f"/merge_requests/{merge_request_iid}",
            )
            self._verify_auto_merge_target(
                current,
                merge_request=merge_request,
                commit_sha=commit_sha,
            )
            if str(current.get("state") or "") == "merged":
                return current
            pipeline = current.get("head_pipeline")
            if isinstance(pipeline, dict) and self._positive_int(pipeline.get("id")):
                if self._commit_sha(pipeline.get("sha")) != commit_sha:
                    raise PluginPublicationGitLabVerificationError(
                        "GitLab MR pipeline does not match the controlled commit"
                    )
                return current
            if attempt < len(AUTO_MERGE_RETRY_DELAYS_SECONDS):
                self._sleep(AUTO_MERGE_RETRY_DELAYS_SECONDS[attempt])
        raise PluginPublicationGitLabError(
            "GitLab MR pipeline was not created before the auto-merge deadline"
        )

    def _request_auto_merge(
        self,
        client: httpx.Client,
        *,
        merge_request: dict[str, Any],
        commit_sha: str,
    ) -> dict[str, Any]:
        merge_request_iid = self._positive_int(merge_request.get("iid"))
        path = f"/merge_requests/{merge_request_iid}/merge"
        url = f"{self._project_api()}{path}"
        payload = {
            "merge_when_pipeline_succeeds": True,
            "sha": commit_sha,
            "should_remove_source_branch": True,
        }
        for attempt in range(len(AUTO_MERGE_RETRY_DELAYS_SECONDS) + 1):
            try:
                response = client.request("PUT", url, json=payload)
                if response.status_code != 405:
                    response.raise_for_status()
                    result = response.json()
                    if not isinstance(result, dict):
                        raise PluginPublicationGitLabVerificationError(
                            "GitLab auto-merge response is invalid"
                        )
                    return result
            except PluginPublicationGitLabVerificationError:
                raise
            except (httpx.HTTPError, ValueError) as exc:
                status_code = (
                    exc.response.status_code
                    if isinstance(exc, httpx.HTTPError) and exc.response is not None
                    else None
                )
                logger.warning(
                    "Controlled GitLab request failed: method=PUT path=%s status=%s",
                    path,
                    status_code,
                )
                raise PluginPublicationGitLabError(
                    f"GitLab request failed for PUT {path}"
                ) from exc
            if attempt == len(AUTO_MERGE_RETRY_DELAYS_SECONDS):
                logger.warning(
                    "Controlled GitLab auto-merge remained unavailable: iid=%s",
                    merge_request_iid,
                )
                raise PluginPublicationGitLabError(
                    "GitLab auto-merge was not ready before the retry deadline"
                )
            current = self._request(
                client,
                "GET",
                f"/merge_requests/{merge_request_iid}",
            )
            self._verify_auto_merge_target(
                current,
                merge_request=merge_request,
                commit_sha=commit_sha,
            )
            if str(current.get("state") or "") == "merged":
                return current
            self._sleep(AUTO_MERGE_RETRY_DELAYS_SECONDS[attempt])
        raise AssertionError("unreachable")

    def _verify_auto_merge_target(
        self,
        current: Any,
        *,
        merge_request: dict[str, Any],
        commit_sha: str,
    ) -> None:
        if not isinstance(current, dict):
            raise PluginPublicationGitLabVerificationError(
                "GitLab merge request response is invalid"
            )
        if (
            self._positive_int(current.get("iid"))
            != self._positive_int(merge_request.get("iid"))
            or str(current.get("state") or "") not in {"opened", "merged"}
            or str(current.get("source_branch") or "")
            != str(merge_request.get("source_branch") or "")
            or str(current.get("target_branch") or "") != self.target_branch
            or self._merge_request_head_sha(current) != commit_sha
        ):
            raise PluginPublicationGitLabVerificationError(
                "GitLab merge request changed before auto-merge registration"
            )

    @staticmethod
    def _commit_sha(value: Any) -> str:
        commit_sha = str(value or "").lower()
        if len(commit_sha) != 40 or any(
            character not in "0123456789abcdef" for character in commit_sha
        ):
            raise PluginPublicationGitLabVerificationError(
                "GitLab commit SHA is invalid"
            )
        return commit_sha

    def _merge_request_head_sha(self, merge_request: dict[str, Any]) -> str:
        diff_refs = merge_request.get("diff_refs") or {}
        return self._commit_sha(
            merge_request.get("sha")
            or (diff_refs.get("head_sha") if isinstance(diff_refs, dict) else None)
        )

    def _verify_controlled_merge_request(
        self,
        merge_request: dict[str, Any],
        *,
        identity: GitLabMaterializerIdentity,
        source_branch: str,
        request_id: int,
        revision: int,
        snapshot_sha256: str,
        binding: str,
        allowed_states: set[str] | None = None,
    ) -> None:
        author = merge_request.get("author") or {}
        description = str(merge_request.get("description") or "")
        expected_binding = f"<!-- Wegent-Materializer-Binding: {binding} -->"
        expected_request = (
            f"Wework publication request #{request_id}, revision {revision}."
        )
        expected_snapshot = f"Snapshot SHA256: `{snapshot_sha256}`"
        if (
            self._positive_int(author.get("id")) != identity.user_id
            or self._positive_int(merge_request.get("source_project_id"))
            != identity.project_id
            or self._positive_int(merge_request.get("target_project_id"))
            != identity.project_id
            or str(merge_request.get("source_branch") or "") != source_branch
            or str(merge_request.get("target_branch") or "") != self.target_branch
            or str(merge_request.get("state") or "")
            not in (allowed_states or {"opened"})
            or expected_binding not in description
            or expected_request not in description
            or expected_snapshot not in description
        ):
            raise PluginPublicationGitLabVerificationError(
                "Existing GitLab merge request is not controlled by this materializer"
            )

    def _read_repository_json(
        self, client: httpx.Client, path: str, *, ref: str
    ) -> dict[str, Any]:
        response = self._request(
            client,
            "GET",
            f"/repository/files/{quote(path, safe='')}",
            params={"ref": ref},
        )
        if str(response.get("encoding") or "base64") != "base64":
            raise PluginPublicationGitLabVerificationError(
                f"GitLab repository file has unsupported encoding: {path}"
            )
        try:
            raw = base64.b64decode(str(response.get("content") or ""), validate=True)
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PluginPublicationGitLabVerificationError(
                f"GitLab repository file is not valid JSON: {path}"
            ) from exc
        if not isinstance(payload, dict):
            raise PluginPublicationGitLabVerificationError(
                f"GitLab repository file must contain an object: {path}"
            )
        return payload

    def _verify_materialized_marker(
        self,
        client: httpx.Client,
        *,
        source_branch: str,
        slug: str,
        request_id: int,
        revision: int,
        snapshot_sha256: str,
        source_tree_sha256: str,
    ) -> None:
        marker = self._read_repository_json(
            client,
            f"plugins/{slug}/.wework-publication.json",
            ref=source_branch,
        )
        if marker != {
            "requestId": request_id,
            "revision": revision,
            "snapshotSha256": snapshot_sha256,
            "sourceTreeSha256": source_tree_sha256,
        }:
            raise PluginPublicationGitLabVerificationError(
                "Existing GitLab source branch marker does not match this revision"
            )

    def _marketplace_file(
        self,
        client: httpx.Client,
        *,
        slug: str,
        ref: str,
        package: bytes,
    ) -> CanonicalPluginFile:
        path = ".agents/plugins/marketplace.json"
        marketplace = self._read_repository_json(client, path, ref=ref)
        entries = marketplace.get("plugins")
        if not isinstance(entries, list):
            raise PluginPublicationGitLabVerificationError(
                "GitLab marketplace plugins must be an array"
            )
        manifest_file = canonical_plugin_files(package).get(".codex-plugin/plugin.json")
        if not manifest_file:
            raise PluginPublicationGitLabError("Plugin snapshot has no manifest")
        try:
            manifest = json.loads(manifest_file.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PluginPublicationGitLabError(
                "Plugin snapshot manifest is not valid JSON"
            ) from exc
        interface = manifest.get("interface") if isinstance(manifest, dict) else {}
        category = (
            str(interface.get("category") or "").strip()
            if isinstance(interface, dict)
            else ""
        )
        replacement = {
            "name": slug,
            "source": {"source": "local", "path": f"./plugins/{slug}"},
            "policy": {
                "installation": "AVAILABLE",
                "authentication": "ON_INSTALL",
            },
        }
        updated_entries: list[dict[str, Any]] = []
        found = False
        seen: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise PluginPublicationGitLabVerificationError(
                    "GitLab marketplace plugin entry must be an object"
                )
            name = str(entry.get("name") or "").strip()
            if not name or name in seen:
                raise PluginPublicationGitLabVerificationError(
                    "GitLab marketplace plugin names must be unique"
                )
            seen.add(name)
            if name == slug:
                updated = {**entry, **replacement}
                if category:
                    updated["category"] = category
                else:
                    updated.setdefault("category", "其他")
                updated_entries.append(updated)
                found = True
            else:
                updated_entries.append(entry)
        if not found:
            updated_entries.append({**replacement, "category": category or "其他"})
        marketplace["plugins"] = updated_entries
        return CanonicalPluginFile(
            path=path,
            content=(
                json.dumps(
                    marketplace,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            ).encode("utf-8"),
            mode=0o644,
        )

    def _verify_marketplace_entry(
        self, client: httpx.Client, *, source_branch: str, slug: str
    ) -> None:
        marketplace = self._read_repository_json(
            client, ".agents/plugins/marketplace.json", ref=source_branch
        )
        entries = marketplace.get("plugins")
        matches = (
            [
                entry
                for entry in entries
                if isinstance(entry, dict) and entry.get("name") == slug
            ]
            if isinstance(entries, list)
            else []
        )
        if len(matches) != 1 or matches[0].get("source") != {
            "source": "local",
            "path": f"./plugins/{slug}",
        }:
            raise PluginPublicationGitLabVerificationError(
                "Existing GitLab source branch has no matching marketplace entry"
            )

    def _list_managed_paths(
        self, client: httpx.Client, slug: str, source_branch: str
    ) -> set[str]:
        paths: set[str] = set()
        page = 1
        while True:
            try:
                items = self._request(
                    client,
                    "GET",
                    "/repository/tree",
                    params={
                        "path": f"plugins/{slug}",
                        "ref": source_branch,
                        "recursive": True,
                        "per_page": 100,
                        "page": page,
                    },
                )
            except PluginPublicationGitLabError:
                return set()
            paths.update(
                str(item.get("path")) for item in items if item.get("type") == "blob"
            )
            if len(items) < 100:
                return paths
            page += 1

    def _archive_files(
        self, package: bytes, *, slug: str
    ) -> dict[str, CanonicalPluginFile]:
        files = {
            f"plugins/{slug}/{path}": CanonicalPluginFile(
                path=f"plugins/{slug}/{path}",
                content=item.content,
                mode=item.mode,
            )
            for path, item in canonical_plugin_files(package).items()
        }
        if not files:
            raise PluginPublicationGitLabError("Plugin snapshot does not contain files")
        if len(files) + 3 > self.max_files:
            raise PluginPublicationGitLabError(
                "Plugin snapshot exceeds the configured GitLab file limit"
            )
        return files

    def _commit_actions(
        self, files: dict[str, CanonicalPluginFile], existing_paths: set[str]
    ) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        for path, item in sorted(files.items()):
            actions.append(
                {
                    "action": "update" if path in existing_paths else "create",
                    "file_path": path,
                    "content": base64.b64encode(item.content).decode("ascii"),
                    "encoding": "base64",
                    "execute_filemode": item.mode == 0o755,
                }
            )
        for path in sorted(existing_paths - files.keys()):
            actions.append({"action": "delete", "file_path": path})
        return actions

    def _source_branch(self, request_id: int, revision: int) -> str:
        return f"wework/publication-{request_id}-r{revision}"

    def _materialization(
        self, merge_request: dict[str, Any], source_branch: str
    ) -> GitLabMaterialization:
        diff_refs = merge_request.get("diff_refs") or {}
        commit_sha = self._commit_sha(
            merge_request.get("merge_commit_sha")
            or merge_request.get("squash_commit_sha")
            or merge_request.get("sha")
            or (diff_refs.get("head_sha") if isinstance(diff_refs, dict) else None)
        )
        return GitLabMaterialization(
            project_id=self.project_id,
            project_url=self.project_url,
            source_branch=source_branch,
            merge_request_iid=int(merge_request.get("iid") or 0),
            merge_request_url=str(merge_request.get("web_url") or ""),
            merge_request_status=str(merge_request.get("state") or "opened"),
            commit_sha=commit_sha,
        )


plugin_publication_gitlab_service = PluginPublicationGitLabService()
