"""The release credential cannot substitute untested generated binaries."""

import hashlib
from unittest.mock import Mock

import httpx
import pytest

from app.services.plugin_build_attestation import verify_build_artifact
from app.services.plugin_publication_gitlab_service import (
    PluginPublicationGitLabError,
    PluginPublicationGitLabVerificationError,
)


@pytest.fixture
def context():
    payload = b"compiled fixture archive"
    jobs = [
        dict(
            id=i,
            name=name,
            status="success",
            pipeline={"id": 4},
            commit={"id": "a" * 40},
        )
        for i, name in [(10, "package_plugin"), (11, "unit_linux")]
    ]
    return payload, jobs


def verify(payload, jobs, expected=None, handler=None):
    def transport(request):
        if request.url.path.endswith(
            "/jobs/11/artifacts/.ci-artifacts/tested-plugin.sha256"
        ):
            return httpx.Response(
                200, content=(hashlib.sha256(payload).hexdigest() + "\n").encode()
            )
        assert (
            request.url.path
            == "/api/v4/projects/42/jobs/10/artifacts/.ci-artifacts/plugin.zip"
        )
        return httpx.Response(200, content=payload)

    with httpx.Client(transport=httpx.MockTransport(handler or transport)) as client:
        verify_build_artifact(
            client=client,
            request_json=Mock(return_value=jobs),
            project_api="https://gitlab.test/api/v4/projects/42",
            pipeline_id=4,
            commit_sha="a" * 40,
            expected_sha256=expected or hashlib.sha256(payload).hexdigest(),
        )


def test_exact_successful_artifact_is_accepted(context):
    verify(*context)


def test_replacement_artifact_is_rejected(context):
    with pytest.raises(
        PluginPublicationGitLabVerificationError, match="did not verify|differs"
    ):
        verify(*context, expected="b" * 64)


@pytest.mark.parametrize(
    "field,value",
    [("status", "failed"), ("pipeline", {"id": 5}), ("commit", {"id": "b" * 40})],
)
@pytest.mark.parametrize("index", [0, 1])
def test_build_and_tests_must_match_pipeline(context, field, value, index):
    payload, jobs = context
    jobs[index][field] = value
    with pytest.raises(PluginPublicationGitLabVerificationError, match="did not pass"):
        verify(payload, jobs)


def test_missing_build_job_is_rejected(context):
    payload, jobs = context
    with pytest.raises(
        PluginPublicationGitLabVerificationError, match="Missing unique"
    ):
        verify(payload, jobs[1:])


def test_redirect_cannot_forward_gitlab_credentials(context):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            302, headers={"Location": "https://external.invalid/artifact"}
        )

    with pytest.raises(PluginPublicationGitLabError):
        verify(*context, handler=handler)
    assert len(calls) == 1


def test_rebuilt_package_requires_tests_of_the_new_bytes(context):
    payload, jobs = context

    def handler(request):
        if request.url.path.endswith("tested-plugin.sha256"):
            return httpx.Response(200, content=b"a" * 64 + b"\n")
        return httpx.Response(200, content=payload)

    with pytest.raises(
        PluginPublicationGitLabVerificationError, match="did not verify"
    ):
        verify(payload, jobs, handler=handler)
