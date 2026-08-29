# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistent PR/MR identities stored on active Issue task bindings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItemTaskBinding,
    ProjectIncomingEvent,
    loop_datetime_is_unset,
)
from app.schemas.project_incoming_hook import ChangeRequestBindingInput
from app.services.project_automation_domain import utcnow


@dataclass(frozen=True)
class ChangeRequestResolution:
    binding: LoopItemTaskBinding | None
    reason: str | None = None


class ProjectChangeRequestBindingService:
    def upsert(
        self,
        db: Session,
        *,
        binding: LoopItemTaskBinding,
        values: ChangeRequestBindingInput,
        commit: bool = True,
    ) -> dict[str, Any]:
        instance_url, repository = self._identity_from_url(
            values.provider,
            values.url,
            values.number,
        )
        identity = (
            values.provider,
            instance_url,
            repository,
            values.number,
        )
        project_bindings = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.cloud_project_id == binding.cloud_project_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .with_for_update()
            .all()
        )
        for candidate in project_bindings:
            if candidate.id == binding.id:
                continue
            if any(
                self.identity(item) == identity
                for item in self.change_requests(candidate)
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Change request is already bound to another active task",
                )

        now = utcnow().isoformat()
        current = self.change_requests(binding)
        existing = next(
            (item for item in current if self.identity(item) == identity),
            None,
        )
        stored = {
            "provider": values.provider,
            "instance_url": instance_url,
            "repository": repository,
            "number": values.number,
            "url": values.url,
            "head_branch": values.head_branch,
            "base_branch": values.base_branch,
            "head_commit": values.head_commit,
            "source": values.source,
            "bound_at": existing.get("bound_at") if existing else now,
            "last_confirmed_at": now,
        }
        next_values = [
            stored if self.identity(item) == identity else item for item in current
        ]
        if existing is None:
            next_values.append(stored)
        metadata = (
            dict(binding.metadata_json)
            if isinstance(binding.metadata_json, dict)
            else {}
        )
        metadata["change_requests"] = next_values
        binding.metadata_json = metadata
        binding.version += 1
        self._mark_matching_unresolved_events(
            db,
            project_id=str(binding.cloud_project_id),
            identity=identity,
        )
        if commit:
            db.commit()
            db.refresh(binding)
        else:
            db.flush()
        return stored

    def _mark_matching_unresolved_events(
        self,
        db: Session,
        *,
        project_id: str,
        identity: tuple[str, str, str, int | None],
    ) -> None:
        events = (
            db.query(ProjectIncomingEvent)
            .filter(
                ProjectIncomingEvent.cloud_project_id == project_id,
                ProjectIncomingEvent.status == "unresolved",
                loop_datetime_is_unset(ProjectIncomingEvent.deleted_at),
            )
            .order_by(ProjectIncomingEvent.created_at.desc())
            .limit(200)
            .with_for_update()
            .all()
        )
        for event in events:
            metadata = (
                dict(event.metadata_json)
                if isinstance(event.metadata_json, dict)
                else {}
            )
            normalized_events = metadata.get("normalized_events")
            if not isinstance(normalized_events, list):
                continue
            if not any(
                isinstance(item, dict)
                and isinstance(item.get("subject"), dict)
                and self.identity(item["subject"]) == identity
                for item in normalized_events
            ):
                continue
            metadata["reason"] = "Change request binding added; pending reprocessing"
            metadata.pop("processed_at", None)
            event.metadata_json = metadata
            event.description = ""
            event.status = "received"
            event.due_at = None
            event.version += 1

    def resolve(
        self,
        db: Session,
        *,
        project_id: str,
        subject: Mapping[str, Any],
    ) -> ChangeRequestResolution:
        provider = self._text(subject.get("provider"))
        instance_url = self._normalized_instance(subject.get("instance_url"))
        repository = self._normalized_repository(subject.get("repository"))
        number = self._integer(subject.get("number"))
        head_commit = self._text(subject.get("head_commit"))
        head_branch = self._text(subject.get("head_branch"))

        matches: list[LoopItemTaskBinding] = []
        bindings = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.cloud_project_id == project_id,
                LoopItemTaskBinding.loop_item_id.isnot(None),
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .all()
        )
        for binding in bindings:
            for candidate in self.change_requests(binding):
                if provider and candidate.get("provider") != provider:
                    continue
                if (
                    instance_url
                    and self._normalized_instance(candidate.get("instance_url"))
                    != instance_url
                ):
                    continue
                if (
                    repository
                    and self._normalized_repository(candidate.get("repository"))
                    != repository
                ):
                    continue
                candidate_number = self._integer(candidate.get("number"))
                if number is not None and candidate_number == number:
                    matches.append(binding)
                    break
                if (
                    number is None
                    and head_commit
                    and self._text(candidate.get("head_commit")) == head_commit
                ):
                    matches.append(binding)
                    break
                if (
                    number is None
                    and not head_commit
                    and head_branch
                    and self._text(candidate.get("head_branch")) == head_branch
                ):
                    matches.append(binding)
                    break
        unique = {str(binding.id): binding for binding in matches}
        if not unique:
            return ChangeRequestResolution(None, "No active task binding was found")
        if len(unique) > 1:
            return ChangeRequestResolution(
                None,
                "Multiple active task bindings matched the change request",
            )
        return ChangeRequestResolution(next(iter(unique.values())))

    @staticmethod
    def change_requests(binding: LoopItemTaskBinding) -> list[dict[str, Any]]:
        metadata = (
            binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
        )
        values = metadata.get("change_requests")
        if not isinstance(values, list):
            return []
        return [dict(item) for item in values if isinstance(item, dict)]

    def identity(self, value: Mapping[str, Any]) -> tuple[str, str, str, int | None]:
        return (
            self._text(value.get("provider")),
            self._normalized_instance(value.get("instance_url")),
            self._normalized_repository(value.get("repository")),
            self._integer(value.get("number")),
        )

    def _identity_from_url(
        self,
        provider: str,
        url: str,
        number: int,
    ) -> tuple[str, str]:
        parsed = urlparse(url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Change request URL must use HTTP or HTTPS",
            )
        parts = [part for part in parsed.path.split("/") if part]
        if provider == "github":
            if len(parts) < 4 or parts[-2] != "pull":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "GitHub pull request URL is invalid",
                )
            repository = "/".join(parts[:-2])
        else:
            marker = parts[-3:-1]
            if len(parts) < 4 or marker != ["-", "merge_requests"]:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "GitLab merge request URL is invalid",
                )
            repository = "/".join(parts[:-3])
        if self._integer(parts[-1]) != number:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Change request number does not match its URL",
            )
        return (
            f"{parsed.scheme.lower()}://{parsed.netloc.lower()}",
            self._normalized_repository(repository),
        )

    @staticmethod
    def _normalized_instance(value: object) -> str:
        return str(value).strip().rstrip("/").lower() if isinstance(value, str) else ""

    @staticmethod
    def _normalized_repository(value: object) -> str:
        if not isinstance(value, str):
            return ""
        normalized = value.strip().strip("/")
        return normalized[:-4] if normalized.endswith(".git") else normalized

    @staticmethod
    def _text(value: object) -> str:
        return value.strip() if isinstance(value, str) else ""

    @staticmethod
    def _integer(value: object) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None


project_change_request_binding_service = ProjectChangeRequestBindingService()
