# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated GitHub and GitLab pull-request operations."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.project_workflow import ProjectRepositoryBinding
from app.services.connector_connections import connector_connection_service


@dataclass(frozen=True)
class PullRequestState:
    provider_id: str
    number: int
    url: str
    state: str
    draft: bool
    mergeable_state: str | None
    review_decision: str | None
    head_commit: str | None
    merged_commit: str | None
    checks: tuple["ProviderCheckState", ...] = ()
    review_threads: tuple["ProviderReviewThreadState", ...] = ()


@dataclass(frozen=True)
class ProviderCheckState:
    provider_id: str
    name: str
    status: str
    conclusion: str | None
    details_url: str | None
    started_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True)
class ProviderReviewThreadState:
    provider_id: str
    comment_id: str | None
    path: str | None
    line: int | None
    side: str | None
    author: str | None
    body: str
    url: str | None
    status: str
    review_state: str | None


class RepositoryProviderClient:
    """Small provider adapter that never returns or logs access tokens."""

    def _token(
        self,
        db: Session,
        *,
        repository: ProjectRepositoryBinding,
        user_id: int,
    ) -> str:
        slug = (repository.credential_ref or repository.provider).removeprefix(
            "connector:"
        )
        connection = connector_connection_service.get(
            db,
            slug=slug,
            user_id=user_id,
        )
        if connection is None and repository.created_by_user_id != user_id:
            connection = connector_connection_service.get(
                db,
                slug=slug,
                user_id=repository.created_by_user_id,
            )
        if connection is None or connection.status != "connected":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Repository credential is not connected: {slug}",
            )
        token = connection.access_token()
        if not token:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Repository credential has no access token",
            )
        return token

    def create_pull_request(
        self,
        db: Session,
        *,
        repository: ProjectRepositoryBinding,
        user_id: int,
        branch_name: str,
        base_branch: str,
        title: str,
        body: str,
        draft: bool,
    ) -> PullRequestState:
        token = self._token(db, repository=repository, user_id=user_id)
        if repository.provider == "github":
            data = self._request(
                "POST",
                self._github_url(repository, "pulls"),
                token=token,
                json={
                    "title": title,
                    "head": branch_name,
                    "base": base_branch,
                    "body": body,
                    "draft": draft,
                },
            )
            return self._github_state(data)
        if repository.provider == "gitlab":
            data = self._request(
                "POST",
                self._gitlab_url(repository, "merge_requests"),
                token=token,
                json={
                    "source_branch": branch_name,
                    "target_branch": base_branch,
                    "title": f"Draft: {title}" if draft else title,
                    "description": body,
                    "remove_source_branch": True,
                },
                gitlab=True,
            )
            return self._gitlab_state(data)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Generic repositories do not support pull-request actions",
        )

    def refresh_pull_request(
        self,
        db: Session,
        *,
        repository: ProjectRepositoryBinding,
        user_id: int,
        number: int,
    ) -> PullRequestState:
        token = self._token(db, repository=repository, user_id=user_id)
        if repository.provider == "github":
            data = self._request(
                "GET",
                self._github_url(repository, f"pulls/{number}"),
                token=token,
            )
            state = self._github_state(data)
            review_decision, review_threads = self._github_review_snapshot(
                repository,
                token=token,
                number=number,
            )
            return replace(
                state,
                review_decision=review_decision,
                checks=tuple(
                    self._github_checks(
                        repository,
                        token=token,
                        head_commit=state.head_commit,
                    )
                ),
                review_threads=tuple(review_threads),
            )
        if repository.provider == "gitlab":
            data = self._request(
                "GET",
                self._gitlab_url(repository, f"merge_requests/{number}"),
                token=token,
                gitlab=True,
            )
            state = self._gitlab_state(data)
            review_decision = self._gitlab_review_decision(
                repository,
                token=token,
                number=number,
            )
            return replace(
                state,
                review_decision=review_decision,
                checks=tuple(
                    self._gitlab_checks(
                        repository,
                        token=token,
                        number=number,
                    )
                ),
                review_threads=tuple(
                    self._gitlab_review_threads(
                        repository,
                        token=token,
                        number=number,
                        review_decision=review_decision,
                    )
                ),
            )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Generic repositories do not support pull-request actions",
        )

    def merge_pull_request(
        self,
        db: Session,
        *,
        repository: ProjectRepositoryBinding,
        user_id: int,
        number: int,
        method: str,
    ) -> PullRequestState:
        token = self._token(db, repository=repository, user_id=user_id)
        if repository.provider == "github":
            self._request(
                "PUT",
                self._github_url(repository, f"pulls/{number}/merge"),
                token=token,
                json={"merge_method": method},
            )
        elif repository.provider == "gitlab":
            self._request(
                "PUT",
                self._gitlab_url(repository, f"merge_requests/{number}/merge"),
                token=token,
                json={
                    "squash": method == "squash",
                    "should_remove_source_branch": True,
                },
                gitlab=True,
            )
        else:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Generic repositories do not support pull-request actions",
            )
        return self.refresh_pull_request(
            db,
            repository=repository,
            user_id=user_id,
            number=number,
        )

    @staticmethod
    def _github_url(repository: ProjectRepositoryBinding, suffix: str) -> str:
        base = str((repository.provider_settings_json or {}).get("apiBase") or "")
        base = base.rstrip("/") or "https://api.github.com"
        return f"{base}/repos/{repository.repository_identity}/{suffix}"

    @staticmethod
    def _gitlab_url(repository: ProjectRepositoryBinding, suffix: str) -> str:
        base = str((repository.provider_settings_json or {}).get("apiBase") or "")
        base = base.rstrip("/") or "https://gitlab.com/api/v4"
        identity = quote(repository.repository_identity, safe="")
        return f"{base}/projects/{identity}/{suffix}"

    @staticmethod
    def _github_graphql_url(repository: ProjectRepositoryBinding) -> str:
        settings = repository.provider_settings_json or {}
        configured = str(settings.get("graphqlBase") or "").rstrip("/")
        if configured:
            return configured
        api_base = str(settings.get("apiBase") or "").rstrip("/")
        if not api_base or api_base == "https://api.github.com":
            return "https://api.github.com/graphql"
        if api_base.endswith("/api/v3"):
            return f"{api_base.removesuffix('/api/v3')}/api/graphql"
        return f"{api_base}/graphql"

    @staticmethod
    def _request(
        method: str,
        url: str,
        *,
        token: str,
        json: dict | None = None,
        gitlab: bool = False,
    ) -> dict[str, Any]:
        data = RepositoryProviderClient._request_json(
            method,
            url,
            token=token,
            json=json,
            gitlab=gitlab,
        )
        if not isinstance(data, dict):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Repository provider returned an invalid response",
            )
        return data

    @staticmethod
    def _request_list(
        method: str,
        url: str,
        *,
        token: str,
        gitlab: bool = False,
    ) -> list[dict[str, Any]]:
        data = RepositoryProviderClient._request_json(
            method,
            url,
            token=token,
            gitlab=gitlab,
        )
        if not isinstance(data, list) or not all(
            isinstance(item, dict) for item in data
        ):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Repository provider returned an invalid response",
            )
        return data

    @staticmethod
    def _request_json(
        method: str,
        url: str,
        *,
        token: str,
        json: dict | None = None,
        gitlab: bool = False,
    ) -> Any:
        headers = (
            {"PRIVATE-TOKEN": token}
            if gitlab
            else {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        )
        try:
            with httpx.Client(timeout=30, trust_env=False) as client:
                response = client.request(method, url, headers=headers, json=json)
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Repository provider request failed",
            ) from exc
        return data

    def _github_checks(
        self,
        repository: ProjectRepositoryBinding,
        *,
        token: str,
        head_commit: str | None,
    ) -> list[ProviderCheckState]:
        if not head_commit:
            return []
        data = self._request(
            "GET",
            self._github_url(repository, f"commits/{head_commit}/check-runs"),
            token=token,
        )
        rows = data.get("check_runs")
        if not isinstance(rows, list):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub check-runs response is invalid",
            )
        return [
            ProviderCheckState(
                provider_id=str(row.get("id") or ""),
                name=str(row.get("name") or "check"),
                status=str(row.get("status") or "queued"),
                conclusion=str(row.get("conclusion") or "") or None,
                details_url=str(row.get("details_url") or "") or None,
                started_at=_provider_datetime(row.get("started_at")),
                completed_at=_provider_datetime(row.get("completed_at")),
            )
            for row in rows
            if isinstance(row, dict) and row.get("id")
        ]

    def _github_review_snapshot(
        self,
        repository: ProjectRepositoryBinding,
        *,
        token: str,
        number: int,
    ) -> tuple[str | None, list[ProviderReviewThreadState]]:
        parts = repository.repository_identity.split("/", 1)
        if len(parts) != 2:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "GitHub repository identity must be owner/name",
            )
        data = self._request(
            "POST",
            self._github_graphql_url(repository),
            token=token,
            json={
                "query": """
                    query PullRequestReviewThreads(
                      $owner: String!, $name: String!, $number: Int!
                    ) {
                      repository(owner: $owner, name: $name) {
                        pullRequest(number: $number) {
                          reviewDecision
                          reviewThreads(first: 100) {
                            nodes {
                              id
                              isResolved
                              isOutdated
                              path
                              line
                              originalLine
                              comments(last: 1) {
                                nodes {
                                  id
                                  body
                                  url
                                  createdAt
                                  author { login }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                """,
                "variables": {
                    "owner": parts[0],
                    "name": parts[1],
                    "number": number,
                },
            },
        )
        if data.get("errors"):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "GitHub review thread query failed",
            )
        pull_request = ((data.get("data") or {}).get("repository") or {}).get(
            "pullRequest"
        ) or {}
        decision = _review_decision(pull_request.get("reviewDecision"))
        nodes = (pull_request.get("reviewThreads") or {}).get("nodes") or []
        threads: list[ProviderReviewThreadState] = []
        for node in nodes:
            if not isinstance(node, dict) or not node.get("id"):
                continue
            comments = (node.get("comments") or {}).get("nodes") or []
            comment = (
                comments[-1] if comments and isinstance(comments[-1], dict) else {}
            )
            thread_status = (
                "outdated"
                if bool(node.get("isOutdated"))
                else "resolved" if bool(node.get("isResolved")) else "open"
            )
            author = (
                comment.get("author") if isinstance(comment.get("author"), dict) else {}
            )
            threads.append(
                ProviderReviewThreadState(
                    provider_id=str(node["id"]),
                    comment_id=str(comment.get("id") or "") or None,
                    path=str(node.get("path") or "") or None,
                    line=_positive_int(node.get("line") or node.get("originalLine")),
                    side="right",
                    author=str(author.get("login") or "") or None,
                    body=str(comment.get("body") or ""),
                    url=str(comment.get("url") or "") or None,
                    status=thread_status,
                    review_state=(
                        "changes_requested"
                        if thread_status == "open" and decision == "changes_requested"
                        else decision
                    ),
                )
            )
        return decision, threads

    def _gitlab_checks(
        self,
        repository: ProjectRepositoryBinding,
        *,
        token: str,
        number: int,
    ) -> list[ProviderCheckState]:
        rows = self._request_list(
            "GET",
            self._gitlab_url(repository, f"merge_requests/{number}/pipelines"),
            token=token,
            gitlab=True,
        )
        terminal = {"success", "failed", "canceled", "skipped"}
        return [
            ProviderCheckState(
                provider_id=str(row.get("id") or ""),
                name=f"pipeline #{row.get('iid') or row.get('id')}",
                status=(
                    "completed"
                    if str(row.get("status") or "") in terminal
                    else "in_progress"
                ),
                conclusion=_gitlab_conclusion(str(row.get("status") or "")),
                details_url=str(row.get("web_url") or "") or None,
                started_at=_provider_datetime(row.get("created_at")),
                completed_at=(
                    _provider_datetime(row.get("updated_at"))
                    if str(row.get("status") or "") in terminal
                    else None
                ),
            )
            for row in rows
            if row.get("id")
        ]

    def _gitlab_review_decision(
        self,
        repository: ProjectRepositoryBinding,
        *,
        token: str,
        number: int,
    ) -> str | None:
        data = self._request(
            "GET",
            self._gitlab_url(repository, f"merge_requests/{number}/approvals"),
            token=token,
            gitlab=True,
        )
        if bool(data.get("approved")) or int(data.get("approvals_left") or 0) == 0:
            return "approved"
        return "review_required"

    def _gitlab_review_threads(
        self,
        repository: ProjectRepositoryBinding,
        *,
        token: str,
        number: int,
        review_decision: str | None,
    ) -> list[ProviderReviewThreadState]:
        discussions = self._request_list(
            "GET",
            self._gitlab_url(repository, f"merge_requests/{number}/discussions"),
            token=token,
            gitlab=True,
        )
        threads: list[ProviderReviewThreadState] = []
        for discussion in discussions:
            notes = discussion.get("notes")
            if not isinstance(notes, list):
                continue
            review_notes = [
                note
                for note in notes
                if isinstance(note, dict) and not bool(note.get("system"))
            ]
            if not review_notes:
                continue
            comment = review_notes[-1]
            position = (
                comment.get("position")
                if isinstance(comment.get("position"), dict)
                else {}
            )
            resolvable = [note for note in review_notes if bool(note.get("resolvable"))]
            resolved = bool(resolvable) and all(
                bool(note.get("resolved")) for note in resolvable
            )
            author = (
                comment.get("author") if isinstance(comment.get("author"), dict) else {}
            )
            thread_status = "resolved" if resolved else "open"
            threads.append(
                ProviderReviewThreadState(
                    provider_id=str(discussion.get("id") or comment.get("id") or ""),
                    comment_id=str(comment.get("id") or "") or None,
                    path=str(position.get("new_path") or position.get("old_path") or "")
                    or None,
                    line=_positive_int(
                        position.get("new_line") or position.get("old_line")
                    ),
                    side="right" if position.get("new_line") else "left",
                    author=str(author.get("username") or author.get("name") or "")
                    or None,
                    body=str(comment.get("body") or ""),
                    url=str(comment.get("web_url") or "") or None,
                    status=thread_status,
                    review_state=(
                        "changes_requested"
                        if thread_status == "open"
                        else review_decision
                    ),
                )
            )
        return [thread for thread in threads if thread.provider_id]

    @staticmethod
    def _github_state(data: dict) -> PullRequestState:
        head = data.get("head") if isinstance(data.get("head"), dict) else {}
        merged = bool(data.get("merged"))
        return PullRequestState(
            provider_id=str(data.get("id") or ""),
            number=int(data.get("number") or 0),
            url=str(data.get("html_url") or ""),
            state="merged" if merged else str(data.get("state") or "open"),
            draft=bool(data.get("draft")),
            mergeable_state=str(data.get("mergeable_state") or "") or None,
            review_decision=None,
            head_commit=str(head.get("sha") or "") or None,
            merged_commit=str(data.get("merge_commit_sha") or "") if merged else None,
        )

    @staticmethod
    def _gitlab_state(data: dict) -> PullRequestState:
        state = str(data.get("state") or "opened")
        return PullRequestState(
            provider_id=str(data.get("id") or ""),
            number=int(data.get("iid") or 0),
            url=str(data.get("web_url") or ""),
            state=state,
            draft=bool(data.get("draft") or data.get("work_in_progress")),
            mergeable_state=str(data.get("merge_status") or "") or None,
            review_decision=("approved" if bool(data.get("approved")) else None),
            head_commit=str(data.get("sha") or "") or None,
            merged_commit=(
                str(data.get("merge_commit_sha") or "") if state == "merged" else None
            ),
        )


def _provider_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _positive_int(value: object) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _review_decision(value: object) -> str | None:
    normalized = str(value or "").strip().lower()
    return (
        normalized
        if normalized in {"approved", "changes_requested", "review_required"}
        else None
    )


def _gitlab_conclusion(value: str) -> str | None:
    return {
        "success": "success",
        "failed": "failure",
        "canceled": "cancelled",
        "skipped": "skipped",
    }.get(value)


repository_provider_client = RepositoryProviderClient()
