# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Repository providers must bound every outbound HTTP request."""

import ast
import inspect
from types import ModuleType

import pytest

from app.core.config import settings
from app.repository import gitea_provider, gitee_provider, github_provider
from app.repository.gitlab_provider import GitLabProvider

DIRECT_REQUEST_MODULES = [gitea_provider, gitee_provider, github_provider]
REQUEST_METHODS = {"get", "post", "put", "patch", "delete", "request"}


def _requests_without_timeout(module: ModuleType) -> list[int]:
    tree = ast.parse(inspect.getsource(module))
    return [
        call.lineno
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id == "requests"
        and call.func.attr in REQUEST_METHODS
        and not any(keyword.arg == "timeout" for keyword in call.keywords)
    ]


@pytest.mark.parametrize("module", DIRECT_REQUEST_MODULES)
def test_direct_provider_requests_always_have_timeouts(module):
    assert _requests_without_timeout(module) == []


def test_gitlab_request_wrapper_supplies_a_default_timeout(mocker):
    provider = GitLabProvider()
    response = mocker.Mock(status_code=200)
    response.raise_for_status.return_value = None
    request = mocker.patch(
        "app.repository.gitlab_provider.requests.request", return_value=response
    )

    provider._make_request_with_auth_retry(
        method="GET",
        url="https://gitlab.example.com/api/v4/projects",
        token="token",
    )

    assert (
        request.call_args.kwargs["timeout"] == settings.REPOSITORY_READ_TIMEOUT_SECONDS
    )
