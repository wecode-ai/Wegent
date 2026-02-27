# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch GitLabProvider methods to resolve real token at runtime,
without modifying open-source app/ code. This keeps changes confined
to wecode directory and adheres to the minimal-intrusion principle.
"""
from typing import Dict, Any, List, Tuple

try:
    # Import target class from app
    from app.repository.gitlab_provider import GitLabProvider
except Exception:
    # If import fails at very early bootstrap, skip patching; the main app import
    # order should import this module after app is ready via wecode.api.__init__.
    GitLabProvider = None  # type: ignore

from wecode.service.token_resolver import token_resolver


def _is_gitlab_item(item: Dict[str, Any]) -> bool:
    return (item or {}).get("type") == "gitlab"


def _resolve_tokens_for_user(user) -> List[Tuple[Dict[str, Any], str]]:
    """
    Resolve real tokens for gitlab items in user's git_info when placeholder '***' is present.
    Returns a list of (item_ref, original_token) to allow restoration afterwards.
    """
    restored: List[Tuple[Dict[str, Any], str]] = []
    if not getattr(user, "git_info", None):
        return restored

    # Resolve tokens for gitlab entries with placeholder
    for idx, item in enumerate(user.git_info):
        if not isinstance(item, dict):
            # Some ORM setups may give mutable dict-like objects; convert via copy interface if present
            try:
                d = dict(item)
            except Exception:
                d = item
        else:
            d = item

        if _is_gitlab_item(d) and d.get("git_token") == "***":
            git_domain = d.get("git_domain", "")
            user_name = d.get("git_login", "")
            try:
                token_result = token_resolver.resolve_git_token(user_name, git_domain, fallback_token="***")
                if token_result:
                    # store original
                    original_token = user.git_info[idx].get("git_token")
                    restored.append((user.git_info[idx], original_token))
                    # replace with real token temporarily
                    user.git_info[idx]["git_token"] = token_result
            except Exception:
                continue

    return restored


def _restore_tokens(restored: List[Tuple[Dict[str, Any], str]]) -> None:
    for item_ref, original in restored:
        try:
            item_ref["git_token"] = original
        except Exception:
            pass


def apply_patch() -> None:
    """
    Apply monkey patches to GitLabProvider.get_repositories and search_repositories.
    """
    if GitLabProvider is None:
        return

    # Keep original methods
    _orig_get_repositories = GitLabProvider.get_repositories
    _orig_search_repositories = GitLabProvider.search_repositories
    _orig_get_branches = GitLabProvider.get_branches
    _orig_get_diff_branchs = GitLabProvider.get_branch_diff

    async def patched_get_repositories(self, user, page: int = 1, limit: int = 100):
        restored = _resolve_tokens_for_user(user)
        try:
            return await _orig_get_repositories(self, user, page=page, limit=limit)
        finally:
            _restore_tokens(restored)

    async def patched_search_repositories(self, user, query: str, timeout: int = 30, fullmatch: bool = False):
        restored = _resolve_tokens_for_user(user)
        try:
            return await _orig_search_repositories(self, user, query=query, timeout=timeout, fullmatch=fullmatch)
        finally:
            _restore_tokens(restored)

    async def patched_get_branches(self, user, repo_name: str, git_domain: str):
        restored = _resolve_tokens_for_user(user)
        try:
            return await _orig_get_branches(self, user, repo_name, git_domain)
        finally:
            _restore_tokens(restored)

    async def patched_get_diff_branches( self,
        user,
        repo_name,
        source_branch,
        target_branch,
        git_domain):
        restored = _resolve_tokens_for_user(user)
        try:
            return await _orig_get_diff_branchs(self, user, repo_name, source_branch, target_branch, git_domain)
        finally:
            _restore_tokens(restored)
    # Assign patched methods
    GitLabProvider.get_repositories = patched_get_repositories  # type: ignore[attr-defined]
    GitLabProvider.search_repositories = patched_search_repositories  # type: ignore[attr-defined]
    GitLabProvider.get_branches = patched_get_branches  # type: ignore[attr-defined]
    GitLabProvider.get_branch_diff = patched_get_diff_branches  # type: ignore[attr-defined]


# Auto-apply on import to reduce changes elsewhere
apply_patch()