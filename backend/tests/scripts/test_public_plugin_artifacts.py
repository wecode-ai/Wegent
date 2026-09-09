"""Source sync and local publication share the self-contained build contract."""

import io
import zipfile

import pytest
from fastapi import HTTPException

from app.services.official_plugin_publisher import official_plugin_publisher
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_publication_artifact import (
    canonical_complete_tree_sha256,
    release_source_tree,
)
from app.services.plugin_publication_gitlab_service import (
    PluginPublicationGitLabService,
)
from shared.tests.test_plugin_build import DeclaredBuildTests


@pytest.fixture
def declared():
    fixture = DeclaredBuildTests()
    fixture.setUp()
    yield fixture
    fixture.doCleanups()


def source_zip(fixture, prefix=""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for path in fixture.source.rglob("*"):
            if path.is_file():
                entry = zipfile.ZipInfo(
                    prefix + path.relative_to(fixture.source).as_posix()
                )
                entry.create_system = 3
                entry.external_attr = (
                    0o755 if path.stat().st_mode & 0o111 else 0o644
                ) << 16
                archive.writestr(entry, path.read_bytes())
    return output.getvalue()


def test_repository_sync_retains_build_inputs_for_gitlab(declared):
    package = plugin_marketplace_service._select_upstream_plugin_package(
        source_zip(declared, "repository/plugins/fixture/"), "fixture"
    )
    files = PluginPublicationGitLabService()._archive_files(package, slug="fixture")
    assert "plugins/fixture/.wework-build.json" in files
    assert "plugins/fixture/.wework-build/build.py" in files


def test_local_publish_builds_and_preserves_input_identity(declared):
    built = official_plugin_publisher.build_package(declared.source)
    tree, compiled = release_source_tree(built.package)
    assert compiled
    assert tree == canonical_complete_tree_sha256(source_zip(declared))
    with zipfile.ZipFile(io.BytesIO(built.package)) as archive:
        assert archive.read("scripts/native/fixture.bin") == b"compiled fixture"


def test_unbuilt_source_cannot_be_released(declared):
    with pytest.raises(HTTPException, match="output is missing"):
        release_source_tree(source_zip(declared))


def test_old_artifact_cannot_override_new_source(declared):
    built = official_plugin_publisher.build_package(declared.source)
    (declared.source / ".codex-plugin/plugin.json").write_text(
        '{"name":"fixture","version":"1.0.1"}'
    )
    assert release_source_tree(built.package)[0] != canonical_complete_tree_sha256(
        source_zip(declared)
    )


def test_release_service_requires_build_attestation_for_generated_outputs(
    declared, test_db
):
    from unittest.mock import Mock

    from app.schemas.plugin_publication import PluginReleaseMetadata
    from app.services.plugin_publication_service import PluginPublicationService

    built = official_plugin_publisher.build_package(declared.source)
    gateway = Mock()
    service = PluginPublicationService(gitlab=gateway)
    metadata = PluginReleaseMetadata.model_validate(
        {
            "schemaVersion": 1,
            "changed": True,
            "plugin": {"slug": "fixture", "version": "1.0.0", "listingType": "plugin"},
            "artifact": {
                "file": "plugin.zip",
                "sha256": built.sha256,
                "sizeBytes": built.size_bytes,
            },
            "source": {
                "projectId": "42",
                "ref": "master",
                "sourceCommitSha": "a" * 40,
                "pipelineId": 73,
                "pipelineUrl": "https://gitlab.test/pipelines/73",
                "metadata": {"projectPath": "wework/plugins"},
            },
        }
    )
    service._authorize_release_provenance(
        test_db, metadata=metadata, package=built.package
    )
    arguments = gateway.verify_release_provenance.call_args.kwargs
    assert arguments["build_artifact_sha256"] == built.sha256
    assert arguments["artifact_tree_sha256"] == canonical_complete_tree_sha256(
        source_zip(declared)
    )
