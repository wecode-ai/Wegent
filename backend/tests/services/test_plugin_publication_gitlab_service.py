# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import hashlib
import hmac
import io
import json
import zipfile

import httpx
import pytest

from app.services.plugin_publication_artifact import (
    canonical_complete_plugin_files,
    canonical_complete_tree_sha256,
    canonical_source_tree_sha256,
)
from app.services.plugin_publication_gitlab_service import (
    AUTO_MERGE_RETRY_DELAYS_SECONDS,
    PluginPublicationGitLabError,
    PluginPublicationGitLabService,
    PluginPublicationGitLabVerificationError,
)


def _package(slug: str = "draft-test", *, risk_body: str | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": slug,
                    "version": "1.0.0",
                    "description": "MR test",
                }
            ),
        )
        executable = zipfile.ZipInfo("scripts/run.sh")
        executable.external_attr = 0o755 << 16
        archive.writestr(executable, b"#!/bin/sh\n")
        if risk_body is not None:
            archive.writestr("plugin-risk.json", risk_body)
    return output.getvalue()


class FakeClient:
    def __init__(self, calls: list, **kwargs) -> None:
        del kwargs
        self.calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *args) -> None:
        del args

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        self.calls.append((method, url, kwargs))
        request = httpx.Request(method, url)
        if method == "GET" and url.endswith("/api/v4/user"):
            return httpx.Response(
                200,
                request=request,
                json={"id": 77, "username": "wegent-materializer"},
            )
        if method == "GET" and url.endswith("/projects/42"):
            return httpx.Response(
                200,
                request=request,
                json={
                    "id": 42,
                    "only_allow_merge_if_pipeline_succeeds": True,
                },
            )
        if method == "GET" and url.endswith("/merge_requests"):
            return httpx.Response(200, request=request, json=[])
        if method == "GET" and url.endswith("/merge_requests/8"):
            return httpx.Response(
                200,
                request=request,
                json={
                    "iid": 8,
                    "state": "opened",
                    "sha": "a" * 40,
                    "source_branch": "wework/publication-12-r3",
                    "target_branch": "master",
                    "head_pipeline": {
                        "id": 73,
                        "status": "pending",
                        "sha": "a" * 40,
                    },
                },
            )
        if method == "GET" and "/repository/branches/" in url:
            return httpx.Response(404, request=request, json={"message": "missing"})
        if method == "GET" and "/repository/files/" in url:
            marketplace = {
                "name": "wework-official",
                "interface": {"displayName": "WeWork Official"},
                "plugins": [
                    {
                        "name": "existing-plugin",
                        "source": {
                            "source": "local",
                            "path": "./plugins/existing-plugin",
                        },
                        "category": "开发工具",
                    }
                ],
            }
            return httpx.Response(
                200,
                request=request,
                json={
                    "encoding": "base64",
                    "content": base64.b64encode(
                        json.dumps(marketplace).encode("utf-8")
                    ).decode("ascii"),
                },
            )
        if method == "GET" and url.endswith("/repository/tree"):
            return httpx.Response(200, request=request, json=[])
        if method == "POST" and url.endswith("/repository/branches"):
            return httpx.Response(201, request=request, json={"name": "branch"})
        if method == "POST" and url.endswith("/repository/commits"):
            return httpx.Response(201, request=request, json={"id": "a" * 40})
        if method == "POST" and url.endswith("/merge_requests"):
            payload = kwargs["json"]
            return httpx.Response(
                201,
                request=request,
                json={
                    "iid": 8,
                    "web_url": "https://git.invalid/project/-/merge_requests/8",
                    "state": "opened",
                    "sha": "a" * 40,
                    "author": {"id": 77},
                    "source_project_id": 42,
                    "target_project_id": 42,
                    "source_branch": payload["source_branch"],
                    "target_branch": payload["target_branch"],
                    "description": payload["description"],
                },
            )
        if method == "PUT" and url.endswith("/merge_requests/8/merge"):
            payload = kwargs["json"]
            return httpx.Response(
                200,
                request=request,
                json={
                    "iid": 8,
                    "web_url": "https://git.invalid/project/-/merge_requests/8",
                    "state": "opened",
                    "sha": payload["sha"],
                    "source_branch": "wework/publication-12-r3",
                    "target_branch": "master",
                    "merge_when_pipeline_succeeds": True,
                },
            )
        raise AssertionError(f"Unexpected GitLab call: {method} {url}")


class AuthorityClient:
    def __init__(
        self,
        calls: list,
        *,
        repository_package: bytes,
        **kwargs,
    ) -> None:
        del kwargs
        self.calls = calls
        files = canonical_complete_plugin_files(repository_package)
        self.blobs = {
            f"{index:040x}": file for index, file in enumerate(files.values(), start=1)
        }

    def __enter__(self):
        return self

    def __exit__(self, *args) -> None:
        del args

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        self.calls.append((method, url, kwargs))
        request = httpx.Request(method, url)
        if method == "GET" and "/repository/branches/master" in url:
            return httpx.Response(
                200,
                request=request,
                json={"name": "master", "protected": True},
            )
        if method == "GET" and url.endswith("/pipelines/99"):
            return httpx.Response(
                200,
                request=request,
                json={
                    "ref": "master",
                    "sha": "b" * 40,
                    "source": "push",
                    "status": "success",
                    "web_url": "https://git.invalid/project/-/pipelines/99",
                },
            )
        if method == "GET" and url.endswith("/repository/tree"):
            params = kwargs["params"]
            if params["page"] != 1:
                return httpx.Response(200, request=request, json=[])
            root = params["path"]
            return httpx.Response(
                200,
                request=request,
                json=[
                    {
                        "id": blob_id,
                        "type": "blob",
                        "path": f"{root}/{file.path}",
                        "mode": "100755" if file.mode == 0o755 else "100644",
                    }
                    for blob_id, file in self.blobs.items()
                ],
            )
        if method == "GET" and "/repository/blobs/" in url:
            blob_id = url.rsplit("/", 1)[-1]
            file = self.blobs[blob_id]
            return httpx.Response(
                200,
                request=request,
                json={
                    "encoding": "base64",
                    "content": base64.b64encode(file.content).decode("ascii"),
                },
            )
        if method == "GET" and url.endswith("/merge_requests/8"):
            return httpx.Response(
                200,
                request=request,
                json={
                    "state": "merged",
                    "target_branch": "master",
                    "source_branch": "wework/publication-12-r3",
                    "merge_commit_sha": "b" * 40,
                },
            )
        raise AssertionError(f"Unexpected GitLab call: {method} {url}")


class PreoccupiedClient(FakeClient):
    def __init__(self, calls: list, *, existing_mr: bool, **kwargs) -> None:
        super().__init__(calls, **kwargs)
        self.existing_mr = existing_mr

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        request = httpx.Request(method, url)
        if method == "GET" and url.endswith("/merge_requests"):
            self.calls.append((method, url, kwargs))
            if not self.existing_mr:
                return httpx.Response(200, request=request, json=[])
            return httpx.Response(
                200,
                request=request,
                json=[
                    {
                        "iid": 91,
                        "state": "opened",
                        "author": {"id": 999},
                        "source_project_id": 42,
                        "target_project_id": 42,
                        "source_branch": "wework/publication-12-r3",
                        "target_branch": "master",
                        "description": "attacker controlled",
                    }
                ],
            )
        if not self.existing_mr and method == "GET" and "/repository/branches/" in url:
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=request,
                json={
                    "name": "wework/publication-12-r3",
                    "commit": {"message": "attacker controlled"},
                },
            )
        return super().request(method, url, **kwargs)


class PipelineCheckDisabledClient(FakeClient):
    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        if method == "GET" and url.endswith("/projects/42"):
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=httpx.Request(method, url),
                json={
                    "id": 42,
                    "only_allow_merge_if_pipeline_succeeds": False,
                },
            )
        return super().request(method, url, **kwargs)


class AutoMergeNotScheduledClient(FakeClient):
    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        if method == "PUT" and url.endswith("/merge_requests/8/merge"):
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=httpx.Request(method, url),
                json={
                    "iid": 8,
                    "state": "opened",
                    "sha": "a" * 40,
                    "source_branch": "wework/publication-12-r3",
                    "target_branch": "master",
                    "merge_when_pipeline_succeeds": False,
                },
            )
        return super().request(method, url, **kwargs)


class DelayedAutoMergeClient(FakeClient):
    def __init__(self, calls: list, **kwargs) -> None:
        super().__init__(calls, **kwargs)
        self.merge_request_reads = 0
        self.merge_attempts = 0

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        request = httpx.Request(method, url)
        if method == "GET" and url.endswith("/merge_requests/8"):
            self.calls.append((method, url, kwargs))
            self.merge_request_reads += 1
            payload = {
                "iid": 8,
                "state": "opened",
                "sha": "a" * 40,
                "source_branch": "wework/publication-12-r3",
                "target_branch": "master",
                "head_pipeline": None,
            }
            if self.merge_request_reads > 1:
                payload["head_pipeline"] = {
                    "id": 73,
                    "status": "pending",
                    "sha": "a" * 40,
                }
            return httpx.Response(200, request=request, json=payload)
        if method == "PUT" and url.endswith("/merge_requests/8/merge"):
            self.calls.append((method, url, kwargs))
            self.merge_attempts += 1
            if self.merge_attempts == 1:
                return httpx.Response(
                    405,
                    request=request,
                    json={"message": "405 Method Not Allowed"},
                )
            return httpx.Response(
                200,
                request=request,
                json={
                    "iid": 8,
                    "state": "opened",
                    "sha": "a" * 40,
                    "source_branch": "wework/publication-12-r3",
                    "target_branch": "master",
                    "merge_when_pipeline_succeeds": True,
                },
            )
        return super().request(method, url, **kwargs)


class MissingPipelineClient(FakeClient):
    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        if method == "GET" and url.endswith("/merge_requests/8"):
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=httpx.Request(method, url),
                json={
                    "iid": 8,
                    "state": "opened",
                    "sha": "a" * 40,
                    "source_branch": "wework/publication-12-r3",
                    "target_branch": "master",
                    "head_pipeline": None,
                },
            )
        return super().request(method, url, **kwargs)


class AutoMergeUnauthorizedClient(FakeClient):
    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        if method == "PUT" and url.endswith("/merge_requests/8/merge"):
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                401,
                request=httpx.Request(method, url),
                json={"message": "401 Unauthorized"},
            )
        return super().request(method, url, **kwargs)


class ExistingControlledMergeRequestClient(FakeClient):
    def __init__(
        self,
        calls: list,
        *,
        binding: str,
        source_tree_sha256: str,
        **kwargs,
    ) -> None:
        super().__init__(calls, **kwargs)
        self.binding = binding
        self.source_tree_sha256 = source_tree_sha256

    def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        request = httpx.Request(method, url)
        if method == "GET" and url.endswith("/merge_requests"):
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=request,
                json=[
                    {
                        "iid": 8,
                        "web_url": ("https://git.invalid/project/-/merge_requests/8"),
                        "state": "opened",
                        "sha": "a" * 40,
                        "author": {"id": 77},
                        "source_project_id": 42,
                        "target_project_id": 42,
                        "source_branch": "wework/publication-12-r3",
                        "target_branch": "master",
                        "description": (
                            "Wework publication request #12, revision 3.\n\n"
                            f"Snapshot SHA256: `{'b' * 64}`\n\n"
                            "<!-- Wegent-Materializer-Binding: "
                            f"{self.binding} -->"
                        ),
                    }
                ],
            )
        if method == "GET" and "/repository/branches/" in url:
            self.calls.append((method, url, kwargs))
            return httpx.Response(
                200,
                request=request,
                json={
                    "name": "wework/publication-12-r3",
                    "commit": {
                        "id": "a" * 40,
                        "message": (
                            "feat(plugin): submit draft-test publication\n\n"
                            f"Wegent-Materializer-Binding: {self.binding}"
                        ),
                    },
                },
            )
        if method == "GET" and "/repository/files/" in url:
            self.calls.append((method, url, kwargs))
            if ".wework-publication.json" in url:
                payload = {
                    "requestId": 12,
                    "revision": 3,
                    "snapshotSha256": "b" * 64,
                    "sourceTreeSha256": self.source_tree_sha256,
                }
            else:
                payload = {
                    "plugins": [
                        {
                            "name": "draft-test",
                            "source": {
                                "source": "local",
                                "path": "./plugins/draft-test",
                            },
                        }
                    ]
                }
            return httpx.Response(
                200,
                request=request,
                json={
                    "encoding": "base64",
                    "content": base64.b64encode(
                        json.dumps(payload).encode("utf-8")
                    ).decode("ascii"),
                },
            )
        return super().request(method, url, **kwargs)


def test_materialization_writes_exact_risk_marker_and_review_ready_mr() -> None:
    package = _package()
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: FakeClient(calls, **kwargs),
    )
    declaration = {
        "externalNetworkAccess": True,
        "externalDomains": ["api.example.com"],
        "executesCommands": False,
        "commandExamples": [],
        "readsOrWritesLocalFiles": False,
        "usesCredentials": False,
        "applicationPermissions": [],
        "additionalNotes": "",
    }
    tree_sha256 = canonical_source_tree_sha256(package)

    result = service.materialize(
        request_id=12,
        revision=3,
        slug="draft-test",
        plugin_name="发布测试插件",
        version="1.0.0",
        snapshot_sha256="b" * 64,
        source_tree_sha256=tree_sha256,
        package=package,
        risk_declaration=declaration,
        test_notes="Tested on both desktop platforms",
    )

    commit_payload = next(
        kwargs["json"]
        for method, url, kwargs in calls
        if method == "POST" and url.endswith("/repository/commits")
    )
    actions = {action["file_path"]: action for action in commit_payload["actions"]}
    risk = json.loads(
        base64.b64decode(actions["plugins/draft-test/plugin-risk.json"]["content"])
    )
    marker = json.loads(
        base64.b64decode(
            actions["plugins/draft-test/.wework-publication.json"]["content"]
        )
    )
    marketplace = json.loads(
        base64.b64decode(actions[".agents/plugins/marketplace.json"]["content"])
    )
    assert risk == {
        "schemaVersion": 1,
        "riskDeclaration": declaration,
        "testNotes": "Tested on both desktop platforms",
    }
    assert marker == {
        "requestId": 12,
        "revision": 3,
        "snapshotSha256": "b" * 64,
        "sourceTreeSha256": tree_sha256,
    }
    assert marketplace["name"] == "wework-official"
    assert marketplace["interface"] == {"displayName": "WeWork Official"}
    assert marketplace["plugins"][0] == {
        "name": "existing-plugin",
        "source": {
            "source": "local",
            "path": "./plugins/existing-plugin",
        },
        "category": "开发工具",
    }
    assert marketplace["plugins"][1] == {
        "name": "draft-test",
        "source": {"source": "local", "path": "./plugins/draft-test"},
        "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL",
        },
        "category": "其他",
    }
    assert actions[".agents/plugins/marketplace.json"]["action"] == "update"
    assert actions["plugins/draft-test/scripts/run.sh"]["execute_filemode"] is True
    assert "test-token" not in commit_payload["commit_message"]
    assert "Wegent-Materializer-User-Id: 77" in commit_payload["commit_message"]
    merge_request_payload = next(
        kwargs["json"]
        for method, url, kwargs in calls
        if method == "POST" and url.endswith("/merge_requests")
    )
    assert merge_request_payload["title"] == (
        "Plugin publication: 发布测试插件 (draft-test) v1.0.0"
    )
    assert not merge_request_payload["title"].startswith("Draft:")
    assert "- Name: 发布测试插件" in merge_request_payload["description"]
    assert "- Slug: `draft-test`" in merge_request_payload["description"]
    assert "- Version: `v1.0.0`" in merge_request_payload["description"]
    auto_merge_payload = next(
        kwargs["json"]
        for method, url, kwargs in calls
        if method == "PUT" and url.endswith("/merge_requests/8/merge")
    )
    assert auto_merge_payload == {
        "merge_when_pipeline_succeeds": True,
        "sha": "a" * 40,
        "should_remove_source_branch": True,
    }
    assert result.merge_request_iid == 8


def test_materialization_updates_only_the_matching_marketplace_entry() -> None:
    package = _package("existing-plugin")
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: FakeClient(calls, **kwargs),
    )

    service.materialize(
        request_id=12,
        revision=3,
        slug="existing-plugin",
        plugin_name="Existing Plugin",
        version="1.0.0",
        snapshot_sha256="b" * 64,
        source_tree_sha256=canonical_source_tree_sha256(package),
        package=package,
        risk_declaration={},
        test_notes="tested",
    )

    commit_payload = next(
        kwargs["json"]
        for method, url, kwargs in calls
        if method == "POST" and url.endswith("/repository/commits")
    )
    marketplace_action = next(
        action
        for action in commit_payload["actions"]
        if action["file_path"] == ".agents/plugins/marketplace.json"
    )
    marketplace = json.loads(base64.b64decode(marketplace_action["content"]))
    assert marketplace == {
        "name": "wework-official",
        "interface": {"displayName": "WeWork Official"},
        "plugins": [
            {
                "name": "existing-plugin",
                "source": {
                    "source": "local",
                    "path": "./plugins/existing-plugin",
                },
                "category": "开发工具",
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
            }
        ],
    }


def test_release_provenance_is_verified_against_authoritative_gitlab_state() -> None:
    repository_package = _package(risk_body='{"approved":true}')
    artifact_tree_sha256 = canonical_complete_tree_sha256(repository_package)
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: AuthorityClient(
            calls,
            repository_package=repository_package,
            **kwargs,
        ),
    )

    service.verify_release_provenance(
        project_id="42",
        ref="refs/heads/master",
        commit_sha="b" * 40,
        pipeline_id=99,
        pipeline_url="https://git.invalid/project/-/pipelines/99",
        slug="draft-test",
        artifact_tree_sha256=artifact_tree_sha256,
        merge_request_iid=8,
        source_branch="wework/publication-12-r3",
    )

    with pytest.raises(PluginPublicationGitLabVerificationError):
        service.verify_release_provenance(
            project_id="42",
            ref="master",
            commit_sha="c" * 40,
            pipeline_id=99,
            pipeline_url="https://git.invalid/project/-/pipelines/99",
            slug="draft-test",
            artifact_tree_sha256=artifact_tree_sha256,
            merge_request_iid=8,
            source_branch="wework/publication-12-r3",
        )

    for project_id, ref in (("41", "master"), ("42", "feature/release")):
        with pytest.raises(PluginPublicationGitLabVerificationError):
            service.verify_release_provenance(
                project_id=project_id,
                ref=ref,
                commit_sha="b" * 40,
                pipeline_id=99,
                pipeline_url="https://git.invalid/project/-/pipelines/99",
                slug="draft-test",
                artifact_tree_sha256=artifact_tree_sha256,
            )

    tampered_generated_metadata = _package(risk_body='{"approved":false}')
    with pytest.raises(PluginPublicationGitLabVerificationError):
        service.verify_release_provenance(
            project_id="42",
            ref="master",
            commit_sha="b" * 40,
            pipeline_id=99,
            pipeline_url="https://git.invalid/project/-/pipelines/99",
            slug="draft-test",
            artifact_tree_sha256=canonical_complete_tree_sha256(
                tampered_generated_metadata
            ),
        )


def test_materialization_requires_the_configured_dedicated_identity() -> None:
    package = _package()
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=78,
        target_branch="master",
        client_factory=lambda **kwargs: FakeClient(calls, **kwargs),
    )

    with pytest.raises(PluginPublicationGitLabVerificationError):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )

    assert not any(method == "POST" for method, _url, _kwargs in calls)


def test_materialization_requires_pipeline_success_before_merge() -> None:
    package = _package()
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: PipelineCheckDisabledClient(calls, **kwargs),
    )

    with pytest.raises(
        PluginPublicationGitLabVerificationError,
        match="must require a successful pipeline",
    ):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )

    assert not any(method in {"POST", "PUT"} for method, _url, _kwargs in calls)


def test_materialization_fails_when_gitlab_does_not_register_auto_merge() -> None:
    package = _package()
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: AutoMergeNotScheduledClient(calls, **kwargs),
    )

    with pytest.raises(
        PluginPublicationGitLabVerificationError,
        match="did not register auto-merge",
    ):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )


def test_materialization_waits_for_pipeline_and_retries_transient_405() -> None:
    package = _package()
    calls: list = []
    sleeps: list[float] = []
    client = DelayedAutoMergeClient(calls)
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **_kwargs: client,
        sleep=sleeps.append,
    )

    result = service.materialize(
        request_id=12,
        revision=3,
        slug="draft-test",
        plugin_name="Draft Test",
        version="1.0.0",
        snapshot_sha256="b" * 64,
        source_tree_sha256=canonical_source_tree_sha256(package),
        package=package,
        risk_declaration={},
        test_notes="tested",
    )

    assert result.merge_request_iid == 8
    assert client.merge_request_reads == 3
    assert client.merge_attempts == 2
    assert sleeps == [0.25, 0.25]


def test_materialization_stops_when_pipeline_never_appears() -> None:
    package = _package()
    calls: list = []
    sleeps: list[float] = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: MissingPipelineClient(calls, **kwargs),
        sleep=sleeps.append,
    )

    with pytest.raises(
        PluginPublicationGitLabError,
        match="pipeline was not created before the auto-merge deadline",
    ):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )

    assert sleeps == list(AUTO_MERGE_RETRY_DELAYS_SECONDS)
    assert not any(method == "PUT" for method, _url, _kwargs in calls)


def test_materialization_does_not_retry_non_transient_auto_merge_error() -> None:
    package = _package()
    calls: list = []
    sleeps: list[float] = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: AutoMergeUnauthorizedClient(calls, **kwargs),
        sleep=sleeps.append,
    )

    with pytest.raises(PluginPublicationGitLabError):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )

    assert sleeps == []
    assert (
        sum(
            method == "PUT" and url.endswith("/merge_requests/8/merge")
            for method, url, _kwargs in calls
        )
        == 1
    )


def test_materialization_reuses_controlled_mr_and_registers_auto_merge() -> None:
    package = _package()
    source_tree_sha256 = canonical_source_tree_sha256(package)
    calls: list = []
    binding_payload = "\0".join(
        (
            "wegent-plugin-materializer-v1",
            "77",
            "42",
            "wework/publication-12-r3",
            "12",
            "3",
            "draft-test",
            "b" * 64,
            source_tree_sha256,
        )
    ).encode("utf-8")
    binding = (
        "v1:" + hmac.new(b"test-token", binding_payload, hashlib.sha256).hexdigest()
    )
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: ExistingControlledMergeRequestClient(
            calls,
            binding=binding,
            source_tree_sha256=source_tree_sha256,
            **kwargs,
        ),
    )

    result = service.materialize(
        request_id=12,
        revision=3,
        slug="draft-test",
        plugin_name="Draft Test",
        version="1.0.0",
        snapshot_sha256="b" * 64,
        source_tree_sha256=source_tree_sha256,
        package=package,
        risk_declaration={},
        test_notes="tested",
    )

    assert result.merge_request_iid == 8
    assert not any(method == "POST" for method, _url, _kwargs in calls)
    assert any(
        method == "PUT" and url.endswith("/merge_requests/8/merge")
        for method, url, _kwargs in calls
    )


@pytest.mark.parametrize("existing_mr", [False, True])
def test_materialization_rejects_preoccupied_branch_or_merge_request(
    existing_mr: bool,
) -> None:
    package = _package()
    calls: list = []
    service = PluginPublicationGitLabService(
        api_url="https://git.invalid/api/v4",
        project_id="42",
        project_url="https://git.invalid/project",
        token="test-token",
        materializer_user_id=77,
        target_branch="master",
        client_factory=lambda **kwargs: PreoccupiedClient(
            calls, existing_mr=existing_mr, **kwargs
        ),
    )

    with pytest.raises(PluginPublicationGitLabVerificationError):
        service.materialize(
            request_id=12,
            revision=3,
            slug="draft-test",
            plugin_name="Draft Test",
            version="1.0.0",
            snapshot_sha256="b" * 64,
            source_tree_sha256=canonical_source_tree_sha256(package),
            package=package,
            risk_declaration={},
            test_notes="tested",
        )

    assert not any(method == "POST" for method, _url, _kwargs in calls)
