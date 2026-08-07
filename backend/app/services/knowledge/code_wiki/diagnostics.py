# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Walk the provider calls a code wiki makes, and time each one.

Reading a repository fails in ways that look alike from the outside — a wrong token,
a host that is unreachable, a proxy that is bypassed for internal names, a provider
that answers slowly enough to hit the connect timeout. The request that triggered it
reports one thing: it took a while and then said no.

So each step is run separately here, timed, and reported whether it succeeds or not.
The point is to tell those causes apart, which means the diagnosis has to say **how**
the call was routed, not only whether it worked: a direct connection and one through
a proxy are the same code and different networks.

**No token is ever returned.** Only whether one was found, and whether it decrypted.
"""

import logging
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.services.git_skill.utils import get_user_git_info
from app.services.knowledge.code_wiki.source import (
    SourceRepository,
    provider_for,
)

logger = logging.getLogger(__name__)


@dataclass
class Step:
    """One provider call, with how long it took and what came back."""

    name: str
    ok: bool = False
    seconds: float = 0.0
    detail: str = ""

    @classmethod
    def run(cls, name: str, call) -> "Step":
        started = time.monotonic()
        try:
            detail = call()
            return cls(
                name=name,
                ok=True,
                seconds=round(time.monotonic() - started, 3),
                detail=str(detail)[:400],
            )
        except Exception as exc:
            # The class as well as the message: a ConnectTimeout and an HTTPError
            # with a 401 body read very differently, and the message alone can hide
            # which one it was.
            return cls(
                name=name,
                ok=False,
                seconds=round(time.monotonic() - started, 3),
                detail=f"{type(exc).__name__}: {exc}"[:400],
            )


@dataclass
class Diagnosis:
    """What the server can and cannot do with this repository, and how."""

    project_name: str
    source_domain: str
    credential: dict[str, Any] = field(default_factory=dict)
    routing: dict[str, Any] = field(default_factory=dict)
    # Contradictions the report can see but no single step reports, because each
    # step only knows its own outcome. Listed first in the payload so they are read
    # before the timings, which is where the eye goes otherwise.
    warnings: list[str] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["steps"] = [asdict(step) for step in self.steps]
        return payload


def diagnose(db: Session, user_id: int, source: SourceRepository) -> dict[str, Any]:
    """Run every provider call a code wiki makes, in order, and time each."""
    provider = provider_for(source.source_type)
    if provider is None:
        return Diagnosis(
            project_name=source.project_name,
            source_domain=source.source_domain,
            credential={"error": f"unsupported type '{source.source_type}'"},
        ).as_dict()

    credential = _credential_shape(db, user_id, source)
    diagnosis = Diagnosis(
        project_name=source.project_name,
        source_domain=source.source_domain,
        credential=credential,
        routing=_routing(source.source_domain),
        warnings=_warnings(source, credential),
    )
    token = _token(db, user_id, source)

    diagnosis.steps.append(
        Step.run(
            "describe_repository (anonymous)",
            lambda: provider.describe_repository(
                token="",
                git_domain=source.source_domain,
                repo_name=source.project_name,
            ),
        )
    )
    if token:
        diagnosis.steps.append(
            Step.run(
                "describe_repository (with credential)",
                lambda: provider.describe_repository(
                    token=token,
                    git_domain=source.source_domain,
                    repo_name=source.project_name,
                ),
            )
        )
        diagnosis.steps.append(
            Step.run(
                "check_user_project_access",
                lambda: _access(provider, source, token),
            )
        )
        # The call that timed out on the create path. Kept last so the cheaper ones
        # have already reported by the time this spends its connect timeout.
        diagnosis.steps.append(
            Step.run(
                "get_default_branch_head",
                lambda: provider.get_default_branch_head(
                    token=token,
                    git_domain=source.source_domain,
                    repo_name=source.project_name,
                ),
            )
        )
    return diagnosis.as_dict()


def _warnings(source: SourceRepository, credential: dict[str, Any]) -> list[str]:
    """Contradictions that make every step below fail for the same, hidden reason.

    A type mismatch is the one worth naming: asking one provider about a repository
    hosted by another produces answers that look like network faults — a 410 from a
    retired API version, an "Invalid token" for a credential that is perfectly good
    somewhere else. ``assert_user_can_read_source`` refuses this outright; the report
    runs anyway, because seeing what each provider says is the point, but it must not
    let the reader take those answers at face value.
    """
    warnings: list[str] = []
    configured = credential.get("type") or ""
    if configured and configured != source.source_type:
        warnings.append(
            f"Requested source_type is '{source.source_type}', but the credential "
            f"configured for {source.source_domain} is '{configured}'. Every step "
            f"below asks the {source.source_type} API about a {configured} host, so "
            f"its answers describe the mismatch rather than the repository."
        )
    if credential.get("found") and credential.get("still_looks_encrypted"):
        warnings.append(
            "The credential still looks like ciphertext after decryption, which is "
            "what a failed decrypt leaves behind — decrypt_sensitive_data returns "
            "its input unchanged. Check GIT_TOKEN_AES_KEY and GIT_TOKEN_AES_IV."
        )
    return warnings


def _access(provider, source: SourceRepository, token: str):
    if source.source_type == "gitlab":
        return provider.check_user_project_access(
            token=token,
            git_domain=source.source_domain,
            project_id=source.project_name,
        )
    return provider.check_user_project_access(
        token=token, git_domain=source.source_domain, repo_name=source.project_name
    )


def _token(db: Session, user_id: int, source: SourceRepository) -> str:
    git_info = get_user_git_info(user_id=user_id, domain=source.source_domain, db=db)
    return (git_info or {}).get("token") or ""


def _credential_shape(
    db: Session, user_id: int, source: SourceRepository
) -> dict[str, Any]:
    """What is known about the credential, without any part of the credential.

    ``decrypted`` false is worth seeing on its own: ``decrypt_sensitive_data`` returns
    the input unchanged when it cannot decrypt, so a token stored in plain text and a
    token that failed to decrypt reach the provider looking identical.
    """
    from shared.utils.crypto import is_token_encrypted

    git_info = get_user_git_info(user_id=user_id, domain=source.source_domain, db=db)
    if not git_info:
        return {"found": False}

    token = git_info.get("token") or ""
    return {
        "found": bool(token),
        "type": git_info.get("type") or "",
        "configured_domain": git_info.get("git_domain") or "",
        "length": len(token),
        # True here after decryption means it still looks like ciphertext, which is
        # what a failed decrypt leaves behind.
        "still_looks_encrypted": is_token_encrypted(token),
    }


def _routing(host: str) -> dict[str, Any]:
    """How an outbound request to this host would be routed.

    A process started from a shell without the proxy variables reaches an internal
    host directly; one started with them goes through the proxy. Both are the same
    code, and the failure modes are entirely different — which is why this is
    reported rather than inferred from the error text.
    """
    from urllib.request import getproxies, proxy_bypass

    proxies = getproxies()
    try:
        bypassed = bool(proxy_bypass(host))
    except Exception:  # pragma: no cover - platform dependent
        bypassed = False
    return {
        "https_proxy": proxies.get("https") or "",
        "http_proxy": proxies.get("http") or "",
        "no_proxy": os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "",
        "bypasses_proxy": bypassed,
        "effective": (
            "direct"
            if bypassed or not proxies.get("https")
            else proxies.get("https", "")
        ),
    }
