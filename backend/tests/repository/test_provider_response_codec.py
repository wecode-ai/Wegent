# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Repository response decoding must never run on the serving event loop."""

import ast
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.repository.gerrit_provider import GerritProvider
from app.repository.gitea_provider import GiteaProvider


@pytest.mark.asyncio
async def test_standard_provider_response_json_runs_in_codec_worker(
    monkeypatch,
) -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None

    class Response:
        content = b"[]"
        headers: dict[str, str] = {}

        @staticmethod
        def raise_for_status() -> None:
            return None

        @staticmethod
        def json() -> list[object]:
            nonlocal decoder_thread
            decoder_thread = threading.get_ident()
            return []

    provider = GiteaProvider()
    monkeypatch.setattr(
        provider,
        "_get_git_infos",
        lambda user: [
            {
                "git_token": "token",
                "git_domain": "gitea.example.com",
                "user_name": "alice",
            }
        ],
    )
    monkeypatch.setattr(
        provider,
        "_get_all_repositories_from_cache",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "app.repository.gitea_provider.run_repository_io",
        AsyncMock(return_value=Response()),
    )
    monkeypatch.setattr(
        "app.repository.gitea_provider.cache_manager",
        SimpleNamespace(
            generate_full_cache_key=lambda *_args: "repos",
            set=AsyncMock(),
        ),
    )

    user = SimpleNamespace(id=1, user_name="alice")
    assert await provider.get_repositories(user) == []
    assert decoder_thread is not None
    assert decoder_thread != loop_thread


@pytest.mark.asyncio
async def test_gerrit_text_and_xssi_decode_run_in_codec_worker() -> None:
    loop_thread = threading.get_ident()
    text_thread: int | None = None

    class Response:
        content = b')]}\'\n{"project": {"description": "example"}}'

        @property
        def text(self) -> str:
            nonlocal text_thread
            text_thread = threading.get_ident()
            return self.content.decode("utf-8")

    result = await GerritProvider()._decode_json_response_async(Response())

    assert result == {"project": {"description": "example"}}
    assert text_thread is not None
    assert text_thread != loop_thread


def test_async_provider_methods_do_not_decode_json_directly() -> None:
    repository_root = Path(__file__).parents[2] / "app" / "repository"
    violations: list[str] = []

    for path in repository_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        parents = {
            child: node
            for node in ast.walk(tree)
            for child in ast.iter_child_nodes(node)
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            callable_name = ast.unparse(node.func)
            if not callable_name.endswith((".json", ".loads", ".dumps")):
                continue

            parent = node
            while parent in parents and not isinstance(
                parent, (ast.FunctionDef, ast.AsyncFunctionDef)
            ):
                parent = parents[parent]
            if isinstance(parent, ast.AsyncFunctionDef):
                violations.append(
                    f"{path.relative_to(repository_root)}:{node.lineno}: "
                    f"{parent.name} calls {callable_name}"
                )

    assert violations == []
