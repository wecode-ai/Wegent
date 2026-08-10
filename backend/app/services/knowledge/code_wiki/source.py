# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Source repository binding for code wikis, and the gate guarding it.

A code wiki is derived from a repository, so its pages can expose whatever that
repository contains. Access is therefore split in two:

- **Creating** a code wiki is gated here: the requester must be able to read the
  repository. This stops someone from having a wiki built for a private repository
  they cannot read themselves.
- **Reading** an existing code wiki is governed purely by knowledge-base permissions
  (namespace roles, resource members, organization visibility). Re-checking the
  repository on every read was slow and fragile, and it is not what decides who may
  see a knowledge base.

Leak protection therefore rests on this gate plus the namespace the creator picks,
which is the same trust model as pasting private code into any other knowledge base.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.services.git_skill.utils import get_user_git_info, parse_repo_url

logger = logging.getLogger(__name__)

SUPPORTED_SOURCE_TYPES = ("github", "gitlab", "gitea")


class SourceAccessDenied(Exception):
    """Raised when a user cannot read the repository they asked to document."""


@dataclass(frozen=True)
class SourceRepository:
    """The repository a code wiki is generated from.

    Every field except the type is derived from the URL rather than accepted
    separately, so the repository this gate checks is necessarily the repository that
    later gets cloned. Taking the domain and project name as independent inputs would
    let a caller pass a repository they can read while storing a URL pointing
    somewhere else entirely — the gate would approve one repository and the wiki would
    be built from another.
    """

    source_type: str
    # Credentials stripped: a URL may arrive with a token embedded, and this value is
    # stored on the knowledge base where anyone who can read it would see them.
    source_url: str
    project_name: str
    source_domain: str

    @classmethod
    def from_url(cls, source_type: str, source_url: str) -> "SourceRepository":
        """Build from a repository URL, deriving the domain and project name.

        Raises:
            SourceAccessDenied: If the type is unsupported or the URL is unusable.
                Both are refusals to bind a repository, so they surface the same way.
        """
        if source_type not in SUPPORTED_SOURCE_TYPES:
            raise SourceAccessDenied(
                f"Unsupported repository type '{source_type}'. "
                f"Supported types: {', '.join(SUPPORTED_SOURCE_TYPES)}"
            )

        try:
            parsed = parse_repo_url(source_url)
        except HTTPException as exc:
            raise SourceAccessDenied(
                f"Could not read a repository from '{source_url}': {exc.detail}"
            ) from exc
        except Exception as exc:
            raise SourceAccessDenied(
                f"Could not read a repository from '{source_url}'"
            ) from exc

        if not parsed.domain or not parsed.owner or not parsed.repo:
            raise SourceAccessDenied(
                f"Could not read a host and project from '{source_url}'"
            )

        _assert_host_is_addressable(parsed.domain)

        repo = parsed.repo[:-4] if parsed.repo.endswith(".git") else parsed.repo
        return cls(
            source_type=source_type,
            source_url=f"https://{parsed.domain}/{parsed.owner}/{repo}.git",
            project_name=f"{parsed.owner}/{repo}",
            source_domain=parsed.domain,
        )

    def to_spec(self) -> Dict[str, Any]:
        """Render as the ``spec.source`` object stored on the knowledge base."""
        return {
            "sourceType": self.source_type,
            "sourceUrl": self.source_url,
            "sourceDomain": self.source_domain,
            "projectName": self.project_name,
        }

    @classmethod
    def from_spec(
        cls, spec_source: Optional[Dict[str, Any]]
    ) -> Optional["SourceRepository"]:
        """Read back a stored source, or ``None`` when one was never recorded."""
        if not spec_source:
            return None
        return cls(
            source_type=str(spec_source.get("sourceType", "")),
            source_url=str(spec_source.get("sourceUrl", "")),
            project_name=str(spec_source.get("projectName", "")),
            source_domain=str(spec_source.get("sourceDomain", "")),
        )


def _assert_host_is_addressable(host: str) -> None:
    """Refuse hosts that are never a Git server but are a useful SSRF target.

    Binding a repository makes the server fetch from whatever host the URL names,
    carrying the caller's token, so the host is attacker-chosen input. The cloud
    metadata endpoint sits on a link-local address and answers unauthenticated
    requests with instance credentials — that is the one worth ruling out by name.

    Private ranges are deliberately still allowed: a self-hosted GitLab or Gitea on
    an internal network is the normal deployment here, and blocking those would
    break the product to close a much smaller hole.

    This bounds what a URL may *name*. It does not stop a public name that resolves
    inward, which needs a check at connection time rather than here.
    """
    import ipaddress

    if host in {"localhost", "localhost.localdomain"}:
        raise SourceAccessDenied(f"'{host}' is not a reachable repository host")

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # A name rather than a literal; nothing more to check without resolving it.
        return

    # ``is_unspecified`` is checked alongside the other two because 0.0.0.0 and ::
    # are neither loopback nor link-local, and connecting to them reaches the local
    # host anyway. Python already folds IPv4-mapped forms into these properties, so
    # ::ffff:127.0.0.1 and ::ffff:169.254.169.254 are covered without special casing;
    # the tests pin that, since it is a property of the standard library rather than
    # of anything written here.
    if address.is_loopback or address.is_link_local or address.is_unspecified:
        raise SourceAccessDenied(f"'{host}' is not a reachable repository host")


def provider_for(source_type: str):
    if source_type == "github":
        from app.repository.github_provider import GitHubProvider

        return GitHubProvider()
    if source_type == "gitlab":
        from app.repository.gitlab_provider import GitLabProvider

        return GitLabProvider()
    if source_type == "gitea":
        from app.repository.gitea_provider import GiteaProvider

        return GiteaProvider()
    return None


# Where "may write" starts, on the scale both providers are mapped onto: GitLab's
# Developer is 30, and GitHub's "push" is mapped to the same number. Anything below
# it can read the repository but not change it.
WRITE_ACCESS_LEVEL = 30


def _check_access(provider, source_type: str, token: str, source: SourceRepository):
    """Ask the provider whether the token can read the repository.

    GitLab names its parameter ``project_id`` but accepts a full project path, which
    is what is used here: a caller-supplied numeric id could point at a different
    project than the URL, which is the mismatch this module exists to rule out.
    """
    if source_type == "gitlab":
        return provider.check_user_project_access(
            token=token,
            git_domain=source.source_domain,
            project_id=source.project_name,
        )
    return provider.check_user_project_access(
        token=token,
        git_domain=source.source_domain,
        repo_name=source.project_name,
    )


def _anonymous_read_access(source: SourceRepository) -> Dict[str, Any]:
    """Read access granted by the repository being public, or a refusal.

    The access level reported is read and no more: nobody has write access to a
    repository they reached without a credential, so this can never satisfy the
    write gate.
    """
    provider = provider_for(source.source_type)
    described = (
        provider.describe_repository(
            token="",
            git_domain=source.source_domain,
            repo_name=source.project_name,
        )
        if provider is not None
        else None
    )
    if not described or described.get("visibility") != "public":
        raise SourceAccessDenied(
            f"No credentials configured for {source.source_domain}, and "
            f"'{source.project_name}' is not readable without one. Add a token for "
            "this Git domain, or check the repository address."
        )

    logger.info(
        "[code_wiki] user reached public repository %s without a credential",
        source.project_name,
    )
    return {
        "has_access": True,
        "access_level": 10,
        "access_level_name": "Read",
        "visibility": "public",
    }


def _or_public(source: SourceRepository, refusal: SourceAccessDenied) -> Dict[str, Any]:
    """Fall back to reading the repository as anyone would, or raise ``refusal``.

    Raising the original refusal rather than the public probe's own wording keeps
    the more specific answer: "your token does not reach this" is more use than
    "this is not public".

    Answering a *successful* public probe is not the same as answering an absent
    one — it is positive evidence that the repository is world-readable, obtained
    from the provider we just failed to reach with a credential. So this does not
    turn an unreachable provider into an open door: if the provider is down, the
    probe fails too and the refusal stands.
    """
    try:
        return _anonymous_read_access(source)
    except SourceAccessDenied:
        raise refusal from None


def assert_user_can_read_source(
    db: Session, user_id: int, source: SourceRepository
) -> Dict[str, Any]:
    """Verify a user can read the repository, or raise ``SourceAccessDenied``.

    Returns the provider's access details so callers can log the granted level.
    """
    if source.source_type not in SUPPORTED_SOURCE_TYPES:
        raise SourceAccessDenied(
            f"Unsupported repository type '{source.source_type}'. "
            f"Supported types: {', '.join(SUPPORTED_SOURCE_TYPES)}"
        )

    git_info: Optional[Dict[str, Any]] = get_user_git_info(
        user_id=user_id, domain=source.source_domain, db=db
    )
    if not git_info or not git_info.get("token"):
        # No credential is not the same as no access: a public repository is readable
        # by anyone, and refusing here would make its wiki more closed than the
        # repository. Asked anonymously, so an unreadable one is reported as such
        # without disclosing whether it exists.
        return _anonymous_read_access(source)

    # The credential's own type must agree with the declared one. Asking one provider
    # about a repository hosted by another produces a meaningless answer, so require
    # agreement rather than guessing which side is right.
    configured_type = git_info.get("type")
    if configured_type and configured_type != source.source_type:
        raise SourceAccessDenied(
            f"Credentials for {source.source_domain} are configured as "
            f"'{configured_type}', but the repository was declared as "
            f"'{source.source_type}'."
        )

    provider = provider_for(source.source_type)
    if provider is None:
        raise SourceAccessDenied(f"Unsupported repository type '{source.source_type}'")

    try:
        result = _check_access(provider, source.source_type, git_info["token"], source)
    except Exception as exc:
        logger.warning(
            "[code_wiki] repository access check failed for %s: %s",
            source.project_name,
            exc,
        )
        # The provider's own error text is logged above but deliberately kept out of
        # the message, which reaches the client as a 403 body. It is an external
        # system's wording about our internal request, not an answer to the caller.
        return _or_public(
            source,
            SourceAccessDenied(
                f"Could not verify access to '{source.project_name}'. "
                "Please try again later."
            ),
        )

    if not result.get("has_access", False):
        # A credential that does not reach this repository is not the last word: the
        # membership check both providers use answers "not a member", which is also
        # the answer for a public repository the caller has never joined. Falling
        # through to the public probe is what stops a stale or unrelated token from
        # making a world-readable repository undocumentable.
        return _or_public(
            source,
            SourceAccessDenied(
                f"You do not have read access to '{source.project_name}'. "
                f"{result.get('error', '')}".strip()
            ),
        )

    logger.info(
        "[code_wiki] user %s has %s access to %s",
        user_id,
        result.get("access_level_name", "read"),
        source.project_name,
    )
    return result


def assert_user_can_write_source(
    db: Session, user_id: int, source: SourceRepository
) -> Dict[str, Any]:
    """Verify a user may change the repository, or raise ``SourceAccessDenied``.

    Triggering a run rewrites every page of the wiki, so it is closer to changing
    the repository than to reading it. Read access is checked first and separately,
    so that somebody who cannot see the repository at all is told that rather than
    being told their permissions are merely insufficient.
    """
    result = assert_user_can_read_source(db, user_id, source)

    level = result.get("access_level")
    if not isinstance(level, int) or level < WRITE_ACCESS_LEVEL:
        raise SourceAccessDenied(
            f"You have read access to '{source.project_name}' but not write access, "
            "which is what regenerating its wiki requires."
        )
    return result
