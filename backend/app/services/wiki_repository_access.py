# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Whether a user may read the repository behind a wiki project.

A wiki is only as private as the repository it documents, so every read path has to
answer this question and none of them may answer it differently. It lives apart from
the rest of the wiki service because it is a different subject entirely: the service
stores and publishes wiki content, while this talks to git providers, caches, and
tokens, and knows nothing about pages.

Answered from the repository list cached in Redis where possible — one lookup covers a
whole page of projects — and by asking the provider only where the cache has nothing
to say about that domain at all.

The granularity there is the domain, not the project, and it is worth being precise
about: once a domain has a cached list, that list is treated as complete, so a project
missing from it is denied without asking the provider. A repository the user gained
access to after the list was cached therefore stays invisible until it expires. The
alternative — asking the provider for every miss — turns one cache lookup into an API
call per inaccessible project, which is most of them on a shared instance.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from app.core.cache import cache_manager
from app.models.user import User
from app.models.wiki import WikiProject
from shared.utils.url_util import domains_match

logger = logging.getLogger(__name__)


def check_task_user_repo_access(
    task_user,
    source_type: str,
    source_url: str,
    source_id: Optional[str],
    source_domain: Optional[str],
    project_name: str,
) -> Dict[str, Any]:
    """
    Check if task_user has access to the specified repository.

    Args:
        task_user: User object for the task execution user
        source_type: Repository source type ('gitlab' or 'github')
        source_url: Repository source URL
        source_id: Repository ID (from source platform)
        source_domain: Git domain (e.g., gitlab.com, github.com)
        project_name: Repository name (e.g., "owner/repo")

    Returns:
        Dictionary with access check results:
        - has_access: bool
        - access_level: int
        - access_level_name: str
        - username: str
    """
    # If task_user has no git_info configured, they can't have access
    if not task_user.git_info:
        return {
            "has_access": False,
            "access_level": 0,
            "access_level_name": "No Access",
            "username": task_user.user_name,
            "error": "Git information not configured for task user",
        }

    # Find token for the task_user matching the source_type and source_domain
    git_token = None
    for git_info in task_user.git_info:
        if git_info.get("type") == source_type:
            if source_domain and domains_match(
                git_info.get("git_domain", ""), source_domain
            ):
                git_token = git_info.get("git_token")
                break
            elif not git_token:
                # Fallback to first matching type token if no domain match
                git_token = git_info.get("git_token")

    if not git_token:
        platform_name = "GitLab" if source_type == "gitlab" else "GitHub"
        return {
            "has_access": False,
            "access_level": 0,
            "access_level_name": "No Access",
            "username": task_user.user_name,
            "error": f"No {platform_name} token configured for task user for domain {source_domain}",
        }

    # Determine project identifier
    # For GitLab: use source_id (numeric project ID) or project path
    # For GitHub: use project_name (owner/repo format)
    project_identifier = source_id if source_id else project_name

    if not project_identifier:
        # Try to extract project path from source_url
        # URL format: https://gitlab.com/namespace/project.git or https://github.com/owner/repo.git
        try:
            import re

            match = re.search(r"(?:https?://[^/]+/)?(.+?)(?:\.git)?$", source_url)
            if match:
                project_identifier = match.group(1)
        except Exception as e:
            logger.warning(f"Failed to extract project ID from URL: {e}")
            return {
                "has_access": False,
                "access_level": 0,
                "access_level_name": "No Access",
                "username": task_user.user_name,
                "error": f"Could not determine project ID from URL: {source_url}",
            }

    if not project_identifier:
        return {
            "has_access": False,
            "access_level": 0,
            "access_level_name": "No Access",
            "username": task_user.user_name,
            "error": "Project identifier is required for access check",
        }

    try:
        if source_type == "gitlab":
            from app.repository.gitlab_provider import GitLabProvider

            provider = GitLabProvider()
            result = provider.check_user_project_access(
                token=git_token,
                git_domain=source_domain or "",
                project_id=project_identifier,
            )
        elif source_type == "github":
            from app.repository.github_provider import GitHubProvider

            provider = GitHubProvider()
            result = provider.check_user_project_access(
                token=git_token,
                git_domain=source_domain or "",
                repo_name=project_name,
            )
        elif source_type == "gitea":
            from app.repository.gitea_provider import GiteaProvider

            provider = GiteaProvider()
            result = provider.check_user_project_access(
                token=git_token,
                git_domain=source_domain or "",
                repo_name=project_name,
            )
        else:
            return {
                "has_access": True,  # Skip check for unsupported source types
                "access_level": 0,
                "access_level_name": "Unknown",
                "username": task_user.user_name,
                "error": f"Access check not supported for source type: {source_type}",
            }
        return result
    except Exception as e:
        logger.error(f"Failed to check repository access: {e}")
        return {
            "has_access": False,
            "access_level": 0,
            "access_level_name": "No Access",
            "username": task_user.user_name,
            "error": str(e),
        }


def filter_projects_by_user_access(
    projects: List[WikiProject], user: User
) -> List[WikiProject]:
    """
    Filter projects based on user's repository access permissions.

    Uses cached repository list from Redis for fast batch permission checking.
    First builds a lookup set from all cached repos, then batch matches all projects.
    Falls back to API calls only for projects where cache is not available.

    Args:
        projects: List of WikiProject objects to filter
        user: User object with git_info containing tokens

    Returns:
        List of projects the user has read access to
    """
    if not user.git_info:
        # User has no git info configured, return empty list
        logger.warning(
            f"User {user.id} has no git_info configured, returning empty project list"
        )
        return []

    # Build a map of user's git tokens by source_type and domain
    user_tokens: Dict[str, Dict[str, str]] = {}

    # Build lookup sets for fast batch matching from cached repos
    # Key: (source_type, domain) -> set of (repo_id, full_name_lower)
    cached_repo_ids: Dict[Tuple[str, str], set] = {}
    cached_repo_names: Dict[Tuple[str, str], set] = {}
    has_cache_for_domain: Dict[Tuple[str, str], bool] = {}

    for git_info in user.git_info:
        git_type = git_info.get("type", "")
        git_domain = git_info.get("git_domain", "")
        git_token = git_info.get("git_token", "")
        if git_type and git_token:
            if git_type not in user_tokens:
                user_tokens[git_type] = {}
            user_tokens[git_type][git_domain] = git_token

            # Try to get cached repositories for this domain
            cache_key = (git_type, git_domain)
            cached_repos = cache_manager.get_user_repositories_sync(user.id, git_domain)

            if cached_repos:
                has_cache_for_domain[cache_key] = True
                # Build lookup sets for batch matching
                repo_ids = set()
                repo_names = set()
                for repo in cached_repos:
                    repo_id = str(repo.get("id", ""))
                    repo_full_name = repo.get("full_name", "").lower()
                    if repo_id:
                        repo_ids.add(repo_id)
                    if repo_full_name:
                        repo_names.add(repo_full_name)

                cached_repo_ids[cache_key] = repo_ids
                cached_repo_names[cache_key] = repo_names

                logger.debug(
                    f"Built lookup sets for user {user.id}, domain {git_domain}: "
                    f"{len(repo_ids)} repo IDs, {len(repo_names)} repo names"
                )
            else:
                has_cache_for_domain[cache_key] = False

    # Batch filter projects using lookup sets
    accessible_projects = []
    projects_needing_api_check = []

    for project in projects:
        source_type = project.source_type
        source_domain = project.source_domain or ""
        source_id = project.source_id
        project_name = project.project_name

        # Check if user has token for this source type
        if source_type not in user_tokens:
            logger.debug(
                f"User has no token for source_type '{source_type}', skipping project {project.id}"
            )
            continue

        # Find the best matching cache key
        cache_key = (source_type, source_domain)

        # If no exact domain match, try to find any cache for this source type
        if cache_key not in has_cache_for_domain:
            # Look for any cached domain for this source type
            for (
                cached_type,
                cached_domain,
            ), has_cache in has_cache_for_domain.items():
                if cached_type == source_type and has_cache:
                    cache_key = (cached_type, cached_domain)
                    break

        # Check if we have cache for this domain
        if has_cache_for_domain.get(cache_key, False):
            # Fast batch lookup using sets
            repo_ids = cached_repo_ids.get(cache_key, set())
            repo_names = cached_repo_names.get(cache_key, set())

            # Match by source_id (numeric project ID)
            if source_id and source_id in repo_ids:
                logger.debug(
                    f"User has access to project {project.id} (matched by source_id from cache)"
                )
                accessible_projects.append(project)
                continue

            # Match by project_name (full path like "namespace/project")
            if project_name and project_name.lower() in repo_names:
                logger.debug(
                    f"User has access to project {project.id} (matched by project_name from cache)"
                )
                accessible_projects.append(project)
                continue

            # Project not found in cached repos, user doesn't have access
            logger.debug(
                f"Project {project.id} ({project_name}) not found in user's cached repos, denying access"
            )
        else:
            # No cache available for this domain, need API check
            projects_needing_api_check.append(project)

    # Fallback: Check projects without cache via API (batch if possible)
    if projects_needing_api_check:
        logger.info(
            f"Checking {len(projects_needing_api_check)} projects via API (no cache available)"
        )
        for project in projects_needing_api_check:
            if _check_via_api(project, user_tokens):
                accessible_projects.append(project)

    logger.info(
        f"User {user.id} has access to {len(accessible_projects)}/{len(projects)} wiki projects"
    )
    return accessible_projects


def _check_via_api(
    project: WikiProject, user_tokens: Dict[str, Dict[str, str]]
) -> bool:
    """
    Check if user has access to a specific wiki project's repository via API call.

    This is the fallback method when cached repository list is not available.

    Args:
        project: WikiProject object
        user_tokens: Dict mapping source_type -> {domain -> token}

    Returns:
        True if user has read access, False otherwise
    """
    source_type = project.source_type
    source_domain = project.source_domain or ""
    source_id = project.source_id
    project_name = project.project_name

    # Find matching token for the domain
    domain_tokens = user_tokens.get(source_type, {})
    git_token = None

    # Try exact domain match first
    if source_domain and source_domain in domain_tokens:
        git_token = domain_tokens[source_domain]
    else:
        # Fallback to first available token for this source type
        if domain_tokens:
            git_token = next(iter(domain_tokens.values()))

    if not git_token:
        logger.debug(
            f"No matching token found for project {project.id} (source_type={source_type}, domain={source_domain})"
        )
        return False

    try:
        if source_type == "gitlab":
            from app.repository.gitlab_provider import GitLabProvider

            provider = GitLabProvider()
            # Use source_id if available, otherwise use project_name
            project_identifier = source_id if source_id else project_name
            result = provider.check_user_project_access(
                token=git_token,
                git_domain=source_domain,
                project_id=project_identifier,
            )
        elif source_type == "github":
            from app.repository.github_provider import GitHubProvider

            provider = GitHubProvider()
            result = provider.check_user_project_access(
                token=git_token,
                git_domain=source_domain,
                repo_name=project_name,
            )
        else:
            # For unsupported source types, allow access by default
            logger.debug(
                f"Unsupported source_type '{source_type}' for project {project.id}, allowing access"
            )
            return True

        has_access = result.get("has_access", False)
        if has_access:
            logger.debug(
                f"User has {result.get('access_level_name', 'Unknown')} access to project {project.id}"
            )
        else:
            logger.debug(
                f"User has no access to project {project.id}: {result.get('error', 'No access')}"
            )
        return has_access

    except Exception as e:
        # On error, deny access for security
        logger.warning(
            f"Error checking access for project {project.id}: {str(e)}, denying access"
        )
        return False


def user_can_read_project(project: WikiProject, user: Optional[User]) -> bool:
    """Check whether a user has read access to a single project's repository.

    Reuses the same repository-access logic as the project list endpoint so
    the detail endpoint cannot be used to bypass permission filtering.

    Args:
        project: WikiProject to check.
        user: Current user. Access is denied when user is None.

    Returns:
        True if the user has read access to the underlying repository.
    """
    if user is None:
        return False
    return bool(filter_projects_by_user_access([project], user))
