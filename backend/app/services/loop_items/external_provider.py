# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitHub and GitLab Issue providers for backend-owned project spaces."""

from __future__ import annotations

import base64
import hashlib
import re
import tempfile
from datetime import datetime, timezone
from typing import Any, BinaryIO
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.provider_credentials import decrypt_provider_token
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.delivery.storage import delivery_storage

PRIORITY_PREFIX = "wegent:priority:"
STATUS_PREFIX = "wegent:status:"
CREATOR_PREFIX = "wegent:creator:"
PARENT_MARKER = "Wegent-Parent:"
GITLAB_PROVIDER_UPLOAD_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\((?P<url>[^)]*/uploads/[^)]+)\)"
)
WEGENT_ATTACHMENT_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\((?P<url>[^)]+)\)"
    r"\s*<!--\s*wegent-attachment:(?P<id>gitlab-[A-Za-z0-9_-]+)\s*-->"
)
LEGACY_WEGENT_ATTACHMENT_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\(wegent://attachments/(?P<id>gitlab-[^)]+)\)"
)


class ExternalLoopItemProvider:
    def is_external_item(self, db: Session, item_id: str) -> bool:
        return self._find_project(db, item_id) is not None

    def list(
        self, db: Session, project_id: int, user_id: int
    ) -> list[dict[str, object]]:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        project = access.project
        self._require_external(project)
        issues = self._list_issues(project)
        return [self._response(project, issue, access, user_id) for issue in issues]

    def get(self, db: Session, item_id: str, user_id: int) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        response = self._response(project, issue, access, user_id)
        if not response["can_view_detail"]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return response

    def create(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        user_name: str,
        values: LoopItemCreate,
    ) -> dict[str, object]:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        project = access.project
        self._require_external(project)
        if not access.is_public_visitor and not has_permission(
            access.role, BaseRole.Reporter
        ):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        labels = self._labels_for_write(
            values.tags + [f"{CREATOR_PREFIX}{user_id}:{self._safe_name(user_name)}"],
            values.priority,
            values.status,
        )
        issue = self._create_issue(
            project,
            values.title,
            self._with_parent(values.description, values.parent_id),
            labels,
        )
        if values.status == "completed":
            issue = self._update_issue(
                project, self._number(issue), {"state": "closed"}
            )
        return self._response(project, issue, access, user_id)

    def attach_gitlab_upload(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> dict[str, object] | None:
        project, number = self._resolve_project(db, item_id)
        if project.task_provider != "gitlab":
            return None
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        issue = self._get_issue(project, number)
        description = str(issue.get("description") or "")
        if filename in description:
            attachment = next(
                (
                    attachment
                    for attachment in self._gitlab_attachments(project, item_id, issue)
                    if attachment["display_name"] == filename
                ),
                None,
            )
            if attachment is not None and "wegent://attachments/" in description:
                native_markdown = (
                    f"[{filename}]({self._decode_attachment_id(str(attachment['id']))[1]})\n"
                    f"<!-- wegent-attachment:{attachment['id']} -->"
                )
                description = LEGACY_WEGENT_ATTACHMENT_PATTERN.sub(
                    lambda match: (
                        native_markdown
                        if match.group("id") == attachment["id"]
                        else match.group(0)
                    ),
                    description,
                )
                self._update_issue(project, number, {"description": description})
                attachment["markdown"] = native_markdown
            if attachment is not None:
                self._store_external_attachment(
                    str(attachment["id"]), source, max_size_bytes
                )
            return attachment

        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                length += len(chunk)
                if length > max_size_bytes:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "Feedback bundle is too large",
                    )
                staged.write(chunk)
            staged.seek(0)
            uploaded = self._request(
                project,
                "POST",
                f"/projects/{quote(self._repository(project), safe='')}/uploads",
                files={"file": (filename, staged, content_type)},
            )
            provider_markdown = str(uploaded.get("markdown") or "").strip()
            if not provider_markdown:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "GitLab upload did not return an attachment link",
                )
            url = str(uploaded.get("full_path") or uploaded.get("url") or "")
            if not url:
                match = GITLAB_PROVIDER_UPLOAD_PATTERN.search(provider_markdown)
                url = match.group("url") if match else ""
            attachment = self._gitlab_attachment_values(
                project,
                item_id,
                filename,
                url,
                content_type,
                length,
                user_id,
                str(issue.get("updated_at") or self._now()),
            )
            markdown = (
                f"{provider_markdown}\n"
                f"<!-- wegent-attachment:{attachment['id']} -->"
            )
            attachment["markdown"] = markdown
            self._update_issue(
                project,
                number,
                {"description": f"{description.rstrip()}\n\n{markdown}".strip()},
            )
            staged.seek(0)
            self._store_external_attachment(
                str(attachment["id"]), staged, max_size_bytes
            )
        return attachment

    def list_attachments(
        self, db: Session, item_id: str, user_id: int
    ) -> list[dict[str, object]]:
        project, number = self._resolve_project(db, item_id)
        if project.task_provider != "gitlab":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Attachments are not supported by this Issue provider",
            )
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        return self._gitlab_attachments(
            project, item_id, self._get_issue(project, number)
        )

    def add_attachment(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> dict[str, object]:
        attachment = self.attach_gitlab_upload(
            db,
            item_id,
            user_id,
            filename,
            content_type,
            source,
            max_size_bytes,
        )
        if attachment is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Attachments are not supported by this Issue provider",
            )
        return attachment

    def attachment_access_url(
        self, db: Session, attachment_id: str, user_id: int
    ) -> str:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, _ = self._resolve_project(db, item_id)
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        if project.task_provider != "gitlab":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        return self._absolute_gitlab_url(project, url)

    def attachment_content(
        self, db: Session, attachment_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, _ = self._resolve_project(db, item_id)
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        try:
            content = delivery_storage.get_bytes(
                self._external_attachment_key(attachment_id)
            )
        except Exception as exc:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Provider attachment is not available in unified storage",
            ) from exc
        filename = url.rstrip("/").rsplit("/", 1)[-1] or "attachment"
        return content, "application/octet-stream", filename

    def delete_attachment(self, db: Session, attachment_id: str, user_id: int) -> None:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        response = self._response(project, issue, access, user_id)
        if not response["can_edit"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        description = str(issue.get("description") or "")
        updated = description
        for pattern in (WEGENT_ATTACHMENT_PATTERN, LEGACY_WEGENT_ATTACHMENT_PATTERN):
            updated = pattern.sub(
                lambda match: (
                    "" if match.group("id") == attachment_id else match.group(0)
                ),
                updated,
            )
        updated = updated.strip()
        self._update_issue(project, number, {"description": updated})
        delivery_storage.remove_objects([self._external_attachment_key(attachment_id)])

    @staticmethod
    def _external_attachment_key(attachment_id: str) -> str:
        digest = hashlib.sha256(attachment_id.encode()).hexdigest()
        return f"loop-items/external-attachments/{digest}"

    def _store_external_attachment(
        self, attachment_id: str, source: BinaryIO, max_size_bytes: int
    ) -> None:
        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                length += len(chunk)
                if length > max_size_bytes:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "TODO attachment is too large",
                    )
                staged.write(chunk)
            staged.seek(0)
            delivery_storage.put_stream(
                self._external_attachment_key(attachment_id),
                staged,
                length,
                "application/octet-stream",
            )

    def _gitlab_attachments(
        self, project: CloudProject, item_id: str, issue: dict[str, Any]
    ) -> list[dict[str, object]]:
        description = str(issue.get("description") or "")
        created_at = str(
            issue.get("updated_at") or issue.get("created_at") or self._now()
        )
        creator_id = self._creator_id(self._labels(issue))
        attachments = []
        matches = list(WEGENT_ATTACHMENT_PATTERN.finditer(description))
        matches.extend(LEGACY_WEGENT_ATTACHMENT_PATTERN.finditer(description))
        for match in matches:
            attachment_id = match.group("id")
            encoded_item_id, url = self._decode_attachment_id(attachment_id)
            if encoded_item_id != item_id:
                continue
            values = self._gitlab_attachment_values(
                project,
                item_id,
                match.group("name"),
                url,
                "image/*" if match.group("image") else None,
                0,
                creator_id,
                created_at,
            )
            values["markdown"] = match.group(0)
            attachments.append(values)
        return attachments

    def _gitlab_attachment_values(
        self,
        project: CloudProject,
        item_id: str,
        filename: str,
        url: str,
        content_type: str | None,
        size_bytes: int,
        user_id: int,
        created_at: str,
    ) -> dict[str, object]:
        raw_id = (
            base64.urlsafe_b64encode(f"{item_id}\n{url}".encode()).decode().rstrip("=")
        )
        return {
            "id": f"gitlab-{raw_id}",
            "loop_item_id": item_id,
            "display_name": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "sha256": hashlib.sha256(url.encode()).hexdigest(),
            "created_by_user_id": user_id,
            "created_at": created_at,
        }

    @staticmethod
    def _decode_attachment_id(attachment_id: str) -> tuple[str, str]:
        if not attachment_id.startswith("gitlab-"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        encoded = attachment_id.removeprefix("gitlab-")
        try:
            value = base64.urlsafe_b64decode(
                encoded + "=" * (-len(encoded) % 4)
            ).decode()
            item_id, url = value.split("\n", 1)
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "TODO attachment not found"
            ) from exc
        return item_id, url

    def _absolute_gitlab_url(self, project: CloudProject, url: str) -> str:
        if url.startswith(("https://", "http://")):
            return url
        config, _ = self._config(project)
        domain = str(config.get("domain") or "gitlab.com").rstrip("/")
        return f"https://{domain}/{url.lstrip('/')}"

    def update(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: LoopItemUpdate,
    ) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        current = self._get_issue(project, number)
        current_response = self._response(project, current, access, user_id)
        if not current_response["can_edit"]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        payload: dict[str, object] = {}
        dumped = values.model_dump(exclude_unset=True)
        if "title" in dumped:
            payload["title"] = values.title
        if "description" in dumped or "parent_id" in dumped:
            description = (
                values.description
                if "description" in dumped
                else str(current_response["description"])
            )
            parent_id = (
                values.parent_id
                if "parent_id" in dumped
                else current_response["parent_id"]
            )
            payload[self._body_key(project)] = self._with_parent(
                description or "", parent_id
            )
        if {"tags", "priority", "status"} & dumped.keys():
            tags = (
                list(values.tags)
                if values.tags is not None
                else list(current_response["tags"])
            )
            creator = self._creator_label(self._labels(current))
            if creator:
                tags.append(creator)
            payload["labels"] = self._labels_for_write(
                tags,
                values.priority or str(current_response["priority"]),
                values.status or str(current_response["status"]),
            )
        if "status" in dumped:
            payload["state"] = (
                "closed" if values.status == "completed" else self._open_state(project)
            )
        issue = self._update_issue(project, number, payload)
        return self._response(project, issue, access, user_id)

    def add_comment(
        self, db: Session, item_id: str, user_id: int, body: str
    ) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        if not self._permissions(
            access, self._creator_id(self._labels(issue)), user_id
        )[1]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return self._create_comment(project, number, body)

    def ensure_shadow(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        if not self.is_external_item(db, item_id):
            existing = db.get(LoopItem, item_id)
            if existing is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
            return existing
        values = self.get(db, item_id, user_id)
        existing = db.get(LoopItem, item_id)
        if existing is not None:
            return existing
        item = LoopItem(
            id=str(values["id"]),
            cloud_project_id=str(values["cloud_project_id"]),
            parent_id=values["parent_id"],
            title=str(values["title"]),
            description=str(values["description"]),
            sequence_number=int(values["sequence_number"]),
            created_by_user_id=int(values["created_by_user_id"]),
            assignee_user_id=values["assignee_user_id"],
            status=str(values["status"]),
            priority=str(values["priority"]),
            sort_order=int(values["sort_order"]),
            metadata_json={"tags": values["tags"], "external_shadow": True},
            version=int(values["version"]),
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def _response(
        self,
        project: CloudProject,
        issue: dict[str, Any],
        access: CloudProjectAccess,
        user_id: int,
    ) -> dict[str, object]:
        labels = self._labels(issue)
        creator_id = self._creator_id(labels)
        creator_name = self._creator_name(labels)
        can_view, can_edit = self._permissions(access, creator_id, user_id)
        number = self._number(issue)
        description = str(issue.get(self._body_key(project)) or "")
        parent_id = self._parent_id(project, description)
        description = "\n".join(
            line
            for line in description.splitlines()
            if not line.strip().startswith(PARENT_MARKER)
        ).strip()
        state = str(issue.get("state") or "")
        item_status = self._status(labels, state)
        created_at = str(issue.get("created_at") or self._now())
        updated_at = str(issue.get("updated_at") or created_at)
        return {
            "id": f"{project.project_key}-{number}",
            "cloud_project_id": str(project.id),
            "sequence_number": number,
            "parent_id": parent_id,
            "title": str(issue.get("title") or ""),
            "description": description if can_view else "",
            "status": item_status,
            "assignee_user_id": None,
            "priority": self._priority(labels),
            "due_at": None,
            "sort_order": number,
            "tags": self._public_tags(labels),
            "created_by_user_id": creator_id,
            "created_by_user_name": creator_name,
            "can_view_detail": can_view,
            "can_edit": can_edit,
            "current_delivery_id": None,
            "version": 1,
            "created_at": created_at,
            "updated_at": updated_at,
            "completed_at": (
                str(issue.get("closed_at") or updated_at)
                if item_status == "completed"
                else None
            ),
        }

    @staticmethod
    def _permissions(
        access: CloudProjectAccess, creator_id: int, user_id: int
    ) -> tuple[bool, bool]:
        if access.is_public_visitor:
            owns = creator_id > 0 and creator_id == user_id
            return owns, owns
        return True, has_permission(access.role, BaseRole.Developer)

    def _resolve_project(self, db: Session, item_id: str) -> tuple[CloudProject, int]:
        resolved = self._find_project(db, item_id)
        if resolved is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return resolved

    @staticmethod
    def _find_project(db: Session, item_id: str) -> tuple[CloudProject, int] | None:
        key, separator, raw_number = item_id.rpartition("-")
        if not separator or not raw_number.isdigit():
            return None
        project = db.query(CloudProject).filter(CloudProject.project_key == key).first()
        if project is None or project.task_provider not in {"github", "gitlab"}:
            return None
        return project, int(raw_number)

    @staticmethod
    def _require_external(project: CloudProject) -> None:
        if project.task_provider not in {"github", "gitlab"}:
            raise HTTPException(status.HTTP_409_CONFLICT, "Project is not external")

    def _config(self, project: CloudProject) -> tuple[dict[str, object], str]:
        metadata = (
            project.metadata_json if isinstance(project.metadata_json, dict) else {}
        )
        config = metadata.get("provider_config")
        config = config if isinstance(config, dict) else {}
        try:
            token = decrypt_provider_token(project.task_provider, config)
        except ValueError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        if not token:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Provider credential is not configured"
            )
        return config, token

    def _request(
        self,
        project: CloudProject,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
    ) -> Any:
        config, token = self._config(project)
        domain = str(
            config.get("domain")
            or ("github.com" if project.task_provider == "github" else "gitlab.com")
        )
        api_base = str(
            config.get("api_base")
            or (
                "https://api.github.com"
                if project.task_provider == "github"
                else f"https://{domain}/api/v4"
            )
        ).rstrip("/")
        headers = (
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            }
            if project.task_provider == "github"
            else {"PRIVATE-TOKEN": token}
        )
        try:
            response = httpx.request(
                method,
                f"{api_base}{path}",
                headers=headers,
                json=json,
                params=params,
                files=files,
                timeout=30,
            )
            response.raise_for_status()
            return response.json() if response.content else {}
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "TODO not found"
                ) from exc
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
            ) from exc

    def _repository(self, project: CloudProject) -> str:
        config, _ = self._config(project)
        repository = str(config.get("repository") or "").strip().strip("/")
        if not repository:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Provider repository is required"
            )
        return repository

    def _list_issues(self, project: CloudProject) -> list[dict[str, Any]]:
        repository = self._repository(project)
        results: list[dict[str, Any]] = []
        for page in range(1, 101):
            path = (
                f"/repos/{repository}/issues"
                if project.task_provider == "github"
                else f"/projects/{quote(repository, safe='')}/issues"
            )
            batch = self._request(
                project,
                "GET",
                path,
                params={"state": "all", "per_page": 100, "page": page},
            )
            if project.task_provider == "github":
                batch = [issue for issue in batch if "pull_request" not in issue]
            results.extend(batch)
            if len(batch) < 100:
                break
        return results

    def _get_issue(self, project: CloudProject, number: int) -> dict[str, Any]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues/{number}"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}"
        )
        return self._request(project, "GET", path)

    def _create_issue(
        self, project: CloudProject, title: str, body: str, labels: list[str]
    ) -> dict[str, Any]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues"
        )
        payload: dict[str, object] = {
            "title": title,
            self._body_key(project): body,
            "labels": labels if project.task_provider == "github" else ",".join(labels),
        }
        return self._request(project, "POST", path, json=payload)

    def _update_issue(
        self, project: CloudProject, number: int, payload: dict[str, object]
    ) -> dict[str, Any]:
        repository = self._repository(project)
        if project.task_provider == "gitlab":
            if isinstance(payload.get("labels"), list):
                payload["labels"] = ",".join(payload["labels"])
            if "state" in payload:
                payload["state_event"] = (
                    "close" if payload.pop("state") == "closed" else "reopen"
                )
        path = (
            f"/repos/{repository}/issues/{number}"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}"
        )
        return self._request(
            project,
            "PATCH" if project.task_provider == "github" else "PUT",
            path,
            json=payload,
        )

    def _create_comment(
        self, project: CloudProject, number: int, body: str
    ) -> dict[str, object]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues/{number}/comments"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}/notes"
        )
        response = self._request(
            project,
            "POST",
            path,
            json={"body": body},
        )
        return {
            "id": str(response.get("id") or ""),
            "body": str(response.get("body") or ""),
            "author": str(
                (response.get("user") or response.get("author") or {}).get(
                    "login" if project.task_provider == "github" else "username"
                )
                or ""
            ),
            "web_url": response.get("html_url") or response.get("web_url"),
            "created_at": str(response.get("created_at") or self._now()),
            "updated_at": str(
                response.get("updated_at") or response.get("created_at") or self._now()
            ),
        }

    @staticmethod
    def _number(issue: dict[str, Any]) -> int:
        return int(issue.get("number") or issue.get("iid") or 0)

    @staticmethod
    def _labels(issue: dict[str, Any]) -> list[str]:
        labels = issue.get("labels") or []
        return [
            str(label.get("name") if isinstance(label, dict) else label)
            for label in labels
        ]

    @staticmethod
    def _creator_label(labels: list[str]) -> str | None:
        return next(
            (label for label in labels if label.startswith(CREATOR_PREFIX)), None
        )

    @classmethod
    def _creator_id(cls, labels: list[str]) -> int:
        label = cls._creator_label(labels)
        if not label:
            return 0
        try:
            return int(label.removeprefix(CREATOR_PREFIX).split(":", 1)[0])
        except ValueError:
            return 0

    @classmethod
    def _creator_name(cls, labels: list[str]) -> str | None:
        label = cls._creator_label(labels)
        if not label:
            return None
        parts = label.removeprefix(CREATOR_PREFIX).split(":", 1)
        return parts[1].strip() if len(parts) == 2 and parts[1].strip() else None

    @staticmethod
    def _public_tags(labels: list[str]) -> list[str]:
        return [
            label
            for label in labels
            if not label.startswith((PRIORITY_PREFIX, STATUS_PREFIX, CREATOR_PREFIX))
        ]

    @staticmethod
    def _labels_for_write(
        tags: list[str], priority: str, item_status: str
    ) -> list[str]:
        labels = [
            tag for tag in tags if not tag.startswith((PRIORITY_PREFIX, STATUS_PREFIX))
        ]
        if priority != "none":
            labels.append(f"{PRIORITY_PREFIX}{priority}")
        labels.append(f"{STATUS_PREFIX}{item_status}")
        return list(dict.fromkeys(labels))

    @staticmethod
    def _status(labels: list[str], provider_state: str) -> str:
        if provider_state in {"closed"}:
            return "completed"
        value = next(
            (
                label.removeprefix(STATUS_PREFIX)
                for label in labels
                if label.startswith(STATUS_PREFIX)
            ),
            "pending",
        )
        return (
            value
            if value in {"inbox", "pending", "in_progress", "in_review"}
            else "pending"
        )

    @staticmethod
    def _priority(labels: list[str]) -> str:
        value = next(
            (
                label.removeprefix(PRIORITY_PREFIX)
                for label in labels
                if label.startswith(PRIORITY_PREFIX)
            ),
            "none",
        )
        return value if value in {"low", "medium", "high", "urgent"} else "none"

    @staticmethod
    def _body_key(project: CloudProject) -> str:
        return "body" if project.task_provider == "github" else "description"

    @staticmethod
    def _open_state(project: CloudProject) -> str:
        return "open" if project.task_provider == "github" else "opened"

    @staticmethod
    def _with_parent(description: str, parent_id: str | None) -> str:
        content = "\n".join(
            line
            for line in description.splitlines()
            if not line.strip().startswith(PARENT_MARKER)
        ).rstrip()
        return (
            f"{content}\n\n{PARENT_MARKER} {parent_id}".strip()
            if parent_id
            else content
        )

    @staticmethod
    def _parent_id(project: CloudProject, description: str) -> str | None:
        for line in description.splitlines():
            if line.strip().startswith(PARENT_MARKER):
                raw = line.strip().removeprefix(PARENT_MARKER).strip()
                if raw.isdigit():
                    return f"{project.project_key}-{raw}"
                if raw:
                    return raw
        return None

    @staticmethod
    def _safe_name(name: str) -> str:
        return name.replace(":", " ").replace(",", " ").strip()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()


external_loop_item_provider = ExternalLoopItemProvider()
