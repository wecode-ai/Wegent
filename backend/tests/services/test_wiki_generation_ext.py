# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests ensuring wiki generation ext never carries the internal write token.

Guards against re-introducing the leak where the internal content-write token was
persisted into generation ext and returned by the generation/project APIs. Two
layers protect against it:
- the write path no longer stores the token (TestBuildGenerationExt)
- the response schema strips it on serialization, covering legacy rows
  (TestExtSerialization)
"""

from types import SimpleNamespace

from app.schemas.wiki import WikiGenerationInDB
from app.services.wiki_service import wiki_service


class TestBuildGenerationExt:
    def test_does_not_persist_internal_token(self) -> None:
        generation = SimpleNamespace(id=42)

        ext = wiki_service._build_generation_ext(generation=generation, base_ext=None)

        assert "wiki_env" not in ext
        assert "auth_token" not in ext.get("content_write", {})
        # Non-secret bookkeeping metadata is still populated.
        assert ext["content_write"]["generation_id"] == 42

    def test_strips_token_supplied_via_request_ext(self) -> None:
        generation = SimpleNamespace(id=7)
        base_ext = {"content_write": {"auth_token": "attacker-supplied"}}

        ext = wiki_service._build_generation_ext(
            generation=generation, base_ext=base_ext
        )

        assert "auth_token" not in ext["content_write"]


class TestExtSerialization:
    """The response schema must strip secrets, protecting legacy rows in the DB."""

    def _make(self, ext: dict) -> WikiGenerationInDB:
        return WikiGenerationInDB(
            id=1,
            project_id=1,
            user_id=1,
            task_id=1,
            team_id=1,
            generation_type="full",
            source_snapshot={},
            status="RUNNING",
            ext=ext,
            created_at="2026-01-01T00:00:00",
            updated_at="2026-01-01T00:00:00",
            completed_at=None,
        )

    def test_removes_wiki_env_and_auth_token(self) -> None:
        model = self._make(
            {
                "wiki_env": {"WIKI_TOKEN": "weki"},
                "content_write": {"auth_token": "weki", "total_sections": 3},
            }
        )

        assert model.ext is not None
        assert "wiki_env" not in model.ext
        assert "auth_token" not in model.ext["content_write"]
        # Legitimate metadata survives.
        assert model.ext["content_write"]["total_sections"] == 3

    def test_leaves_clean_ext_untouched(self) -> None:
        model = self._make({"content_write": {"total_sections": 1}})

        assert model.ext == {"content_write": {"total_sections": 1}}
