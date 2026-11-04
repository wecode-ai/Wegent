# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Publish external Skill assets and expand stored bindings in one transaction.

Catalogs are release data, not an execution-time dependency protocol. Executors
receive ordinary Skill IDs and archives through the existing download API.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.skill_binding_service import skill_binding_service
from app.services.skill_resolution import build_skill_ref_meta, find_skill_by_name
from app.services.skill_service import SkillValidator
from shared.telemetry.decorators import trace_sync


class CatalogAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
    source: str
    path: str
    bind_shells: list[Literal["Chat", "ClaudeCode", "Codex", "Agno", "Dify"]] = Field(
        min_length=1
    )


class SkillCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assets: list[CatalogAsset] = Field(min_length=1)
    expansions: dict[str, list[str]] = Field(default_factory=dict)
    seed_ghosts: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_names(self) -> SkillCatalog:
        names = [asset.name for asset in self.assets]
        if len(names) != len(set(names)):
            raise ValueError("Catalog asset names must be unique")
        for source, targets in self.expansions.items():
            if source not in names or not targets or len(targets) != len(set(targets)):
                raise ValueError("Invalid binding expansion")
            if source in targets or any(target not in names for target in targets):
                raise ValueError("Expansion targets must be other catalog assets")
        return self


def package_asset(asset: CatalogAsset, sources: dict[str, Path]) -> bytes:
    """Keep the full source package, with explicit runtime metadata and stable ZIPs."""
    root = sources[asset.source].resolve(strict=True)
    directory = root / asset.path
    if (
        not directory.resolve(strict=True).is_relative_to(root)
        or not directory.is_dir()
    ):
        raise ValueError(f"Skill source escapes its root: {asset.name}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Skill source contains a symlink: {asset.name}")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError(
                    f"Skill source contains a nonregular file: {asset.name}"
                )
            relative = path.relative_to(directory)
            if "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            content = path.read_bytes()
            if relative.as_posix() == "SKILL.md":
                _, frontmatter, prompt = content.decode().split("---", 2)
                metadata = yaml.safe_load(frontmatter)
                if metadata.get("name", asset.name) != asset.name:
                    raise ValueError(f"Skill source name mismatch: {asset.name}")
                metadata["bindShells"] = asset.bind_shells
                content = f"---\n{yaml.safe_dump(metadata, sort_keys=False)}---{prompt}".encode()
            info = zipfile.ZipInfo(f"{asset.name}/{relative.as_posix()}")
            info.create_system = 3
            info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    result = buffer.getvalue()
    SkillValidator.validate_zip(result, f"{asset.name}.zip")
    return result


def _public_skill(db: Session, name: str) -> Kind | None:
    return (
        db.query(Kind)
        .filter_by(kind="Skill", user_id=0, namespace="default", name=name)
        .first()
    )


def _publish(db: Session, name: str, content: bytes) -> Kind:
    existing = _public_skill(db, name)
    if (
        existing
        and existing.is_active
        and existing.json.get("status", {}).get("fileHash")
        == hashlib.sha256(content).hexdigest()
    ):
        return existing
    arguments = dict(
        db=db, user_id=0, file_content=content, file_name=f"{name}.zip", commit=False
    )
    if existing and existing.is_active:
        skill_kinds_service.update_skill(skill_id=existing.id, **arguments)
    else:
        skill_kinds_service.create_skill(
            name=name, namespace="default", add_to_user_default=False, **arguments
        )
    published = _public_skill(db, name)
    assert published is not None
    return published


def _matches(db: Session, row: Kind, spec: dict[str, Any], source: Kind) -> bool:
    for names_key, refs_key in [
        ("skills", "skill_refs"),
        ("preload_skills", "preload_skill_refs"),
    ]:
        if source.name not in (spec.get(names_key) or []):
            continue
        ref = (spec.get(refs_key) or {}).get(source.name)
        if ref is not None:
            if ref.get("skill_id") == source.id:
                return True
            if ref.get("skill_id") is not None:
                continue
            if ref.get("is_public") and ref.get("namespace", "default") == "default":
                return True
            continue
        resolved = find_skill_by_name(
            db,
            skill_name=source.name,
            owner_user_id=row.user_id,
            team_namespace=row.namespace,
        )
        if resolved and resolved.id == source.id:
            return True
    return False


def _expand_ghost(db: Session, row: Kind, source: Kind, targets: list[Kind]) -> bool:
    data = deepcopy(row.json)
    spec = data.setdefault("spec", {})
    if not _matches(db, row, spec, source):
        return False
    preload_spec = {
        "preload_skills": spec.get("preload_skills"),
        "preload_skill_refs": spec.get("preload_skill_refs"),
    }
    if _matches(db, row, preload_spec, source):
        replacements = _preload_replacements(db, row, source, targets)
        if replacements:
            names = []
            for name in spec["preload_skills"]:
                for expanded in (
                    [target.name for target in replacements]
                    if name == source.name
                    else [name]
                ):
                    if expanded not in names:
                        names.append(expanded)
            spec["preload_skills"] = names
            refs = dict(spec.get("preload_skill_refs") or {})
            refs.pop(source.name, None)
            for target in replacements:
                refs.setdefault(
                    target.name,
                    (spec.get("skill_refs") or {}).get(
                        target.name, build_skill_ref_meta(target)
                    ),
                )
            spec["preload_skill_refs"] = refs
    names = list(spec.get("skills") or [])
    refs = dict(spec.get("skill_refs") or {})
    spec["skills"] = names
    spec["skill_refs"] = refs
    # Pin a legacy name to the resource it actually resolved to before expansion.
    regular_spec = {"skills": spec.get("skills"), "skill_refs": spec.get("skill_refs")}
    if _matches(db, row, regular_spec, source):
        refs[source.name] = build_skill_ref_meta(source)
    for target in targets:
        if target.name in names:
            continue
        names.append(target.name)
        refs[target.name] = build_skill_ref_meta(target)
    changed = row.json != data
    if changed:
        row.json = data
        flag_modified(row, "json")
    return changed


def _preload_replacements(
    db: Session, ghost: Kind, source: Kind, targets: list[Kind]
) -> list[Kind]:
    from app.services.adapters.shell_utils import get_shell_by_name
    from app.services.readers import KindType, kindReader

    for child in db.query(Kind).filter_by(kind="Ghost", is_active=True).all():
        base = child.json.get("spec", {}).get("baseGhostRef") or {}
        if (
            base.get("name") == ghost.name
            and base.get("namespace", "default") == ghost.namespace
            and base.get("user_id") == ghost.user_id
        ):
            raise ValueError(
                f"Ghost {ghost.id} preloads {source.name} through inheritance; split its explicit preload first"
            )
    shells = set()
    for bot in db.query(Kind).filter_by(kind="Bot", is_active=True).all():
        spec = bot.json.get("spec", {})
        ref = spec.get("ghostRef") or {}
        if (
            ref.get("name") != ghost.name
            or ref.get("namespace", "default") != ghost.namespace
        ):
            continue
        resolved = kindReader.get_by_name_and_namespace(
            db, bot.user_id, KindType.GHOST, ghost.namespace, ghost.name
        )
        if not resolved or resolved.id != ghost.id:
            continue
        shell_ref = spec.get("shellRef") or {}
        shell = get_shell_by_name(
            db,
            shell_ref.get("name", "Chat"),
            bot.user_id,
            shell_ref.get("namespace", "default"),
        )
        if not shell:
            raise ValueError(f"Bot {bot.id} has an unresolved Shell")
        shells.add(shell.json["spec"]["shellType"])
    # Orphaned and Chat-only Ghost preloads keep their original meaning.
    source_shells = set(source.json["spec"]["bindShells"])
    if not shells or shells <= source_shells:
        return []
    if shells & source_shells:
        raise ValueError(
            f"Ghost {ghost.id} preloads {source.name} across incompatible Shells; split its explicit preload first"
        )
    replacements = [
        target for target in targets if shells <= set(target.json["spec"]["bindShells"])
    ]
    if not replacements:
        raise ValueError(f"Ghost {ghost.id} has no compatible preload replacements")
    return replacements


def _expand_installation(
    db: Session, row: Kind, source: Kind, targets: list[Kind]
) -> int:
    spec = row.json.get("spec", {})
    ref = spec.get("skillRef") or {}
    expected = {
        "name": source.name,
        "namespace": source.namespace,
        "user_id": source.user_id,
    }
    if row.kind == "SkillBinding":
        if ref.get("skillId", ref.get("skill_id")) != source.id:
            return 0
    elif any(ref.get(key) != value for key, value in expected.items()):
        return 0
    # SessionLocal disables autoflush: earlier source bindings must be visible
    # before checking whether they already published this shared destination.
    db.flush()
    count = 0
    siblings_query = db.query(Kind).filter_by(kind=row.kind, namespace=row.namespace)
    group_binding = (
        row.kind == "SkillBinding"
        and skill_binding_service._is_group_binding(row, row.namespace)
    )
    if not group_binding:
        siblings_query = siblings_query.filter_by(user_id=row.user_id)
    siblings = siblings_query.all()
    for target in targets:
        name = _installation_name(row, target)
        existing = next((item for item in siblings if item.name == name), None)
        legacy_name = f"catalog-{row.id}-skill-{target.id}"
        legacy = next((item for item in siblings if item.name == legacy_name), None)
        if existing and not _same_destination(existing, row, target):
            raise ValueError(f"Binding name {name} belongs to another destination")
        if legacy and legacy is not existing:
            if not _same_destination(legacy, row, target):
                raise ValueError(
                    f"Binding name {legacy_name} belongs to another destination"
                )
            if existing:
                # The destination's explicit settings win over an obsolete alias.
                if legacy.is_active:
                    legacy.is_active = False
                    count += 1
            else:
                data = deepcopy(legacy.json)
                data["metadata"]["name"] = name
                legacy.name = name
                legacy.json = data
                flag_modified(legacy, "json")
                count += 1
            continue
        # Do not reactivate a binding the user has subsequently disabled/deleted.
        if existing:
            continue
        # Preserve an existing destination's exceptions, enablement and ownership.
        if any(_same_destination(candidate, row, target) for candidate in siblings):
            continue
        data = deepcopy(row.json)
        data["metadata"]["name"] = name
        if row.kind == "SkillBinding":
            data["spec"]["skillRef"] = {
                "skillId": target.id,
                "name": target.name,
                "namespace": target.namespace,
                "isPublic": True,
            }
        else:
            data["spec"].update(
                skillRef={
                    "kind": "Skill",
                    "name": target.name,
                    "namespace": target.namespace,
                    "user_id": 0,
                },
                source={"type": "personal", "skillKey": target.name},
                displayName=target.name,
                description=target.json["spec"]["description"],
                version=target.json["spec"].get("version"),
            )
        db.add(
            Kind(
                kind=row.kind,
                user_id=row.user_id,
                namespace=row.namespace,
                name=name,
                json=data,
                is_active=row.is_active,
            )
        )
        count += 1
    return count


def _installation_name(row: Kind, target: Kind) -> str:
    """Use the identity that the existing binding management APIs address."""
    if row.kind == "SkillBinding":
        target_id = skill_binding_service.get_user_default_target_id(row.user_id)
        if (
            row.namespace == "default"
            and skill_binding_service._is_user_default_binding(row, target_id)
        ):
            return skill_binding_service.build_user_default_name(row.user_id, target.id)
        if skill_binding_service._is_group_binding(row, row.namespace):
            return skill_binding_service.build_group_name(row.namespace, target.id)
    return f"catalog-{row.id}-skill-{target.id}"


def _same_destination(candidate: Kind, source: Kind, target: Kind) -> bool:
    spec = candidate.json.get("spec", {})
    ref = spec.get("skillRef") or {}
    if candidate.kind == "SkillBinding":
        old_spec = source.json.get("spec", {})
        return (
            ref.get("skillId", ref.get("skill_id")) == target.id
            and spec.get("targetType") == old_spec.get("targetType")
            and spec.get("targetId") == old_spec.get("targetId")
        )
    return (
        ref.get("name") == target.name
        and ref.get("namespace") == target.namespace
        and ref.get("user_id") == target.user_id
    )


def _expand_template(db: Session, row: Kind, source: Kind, targets: list[Kind]) -> bool:
    from app.services.adapters.shell_utils import get_shell_by_name

    data = deepcopy(row.json)
    resources = data.get("spec", {}).get("resources") or {}
    ghost = resources.get("ghost") or {}
    expected = {
        "name": source.name,
        "namespace": source.namespace,
        "user_id": source.user_id,
    }
    if not any(
        all(ref.get(key) == value for key, value in expected.items())
        for field in ["skillRefs", "preloadSkillRefs"]
        for ref in (ghost.get(field) or [])
    ):
        return False
    shell_name = (resources.get("bot") or {}).get("shellName", "Chat")
    shell = get_shell_by_name(db, shell_name, row.user_id)
    if not shell:
        raise ValueError(f"Template {row.id} has an unresolved Shell: {shell_name}")
    shell_type = shell.json["spec"]["shellType"]
    compatible = [
        target for target in targets if shell_type in target.json["spec"]["bindShells"]
    ]
    for key in ["skillRefs", "preloadSkillRefs"]:
        refs = ghost.get(key) or []
        if not any(
            all(ref.get(k) == value for k, value in expected.items()) for ref in refs
        ):
            continue
        if shell_type not in source.json["spec"]["bindShells"]:
            refs = [
                ref
                for ref in refs
                if not all(ref.get(k) == value for k, value in expected.items())
            ]
        for target in compatible:
            if not any(ref.get("name") == target.name for ref in refs):
                refs.append(
                    {
                        "name": target.name,
                        "namespace": target.namespace,
                        "user_id": target.user_id,
                    }
                )
        ghost[key] = refs
    changed = row.json != data
    if changed:
        row.json = data
        flag_modified(row, "json")
    return changed


@trace_sync(span_name="skill_catalog.publish", tracer_name="backend")
def publish_catalog(
    db: Session, catalog: SkillCatalog, sources: dict[str, Path]
) -> dict[str, Any]:
    """Stage a catalog and exact binding expansions; caller commits or rolls back.

    Run under the release maintenance lock. All source packages are validated
    before the first database write. Existing public IDs and private assets survive.
    """
    packages = {asset.name: package_asset(asset, sources) for asset in catalog.assets}
    # Lock existing publication identities and consumers for this transaction.
    rows = (
        db.query(Kind)
        .filter(
            or_(
                Kind.kind.in_(["Ghost", "SkillBinding", "InstalledSkill", "Template"]),
                and_(
                    Kind.kind == "Skill",
                    Kind.user_id == 0,
                    Kind.namespace == "default",
                    Kind.name.in_(packages),
                ),
            )
        )
        .order_by(Kind.id)
        .with_for_update()
        .all()
    )
    assets = {name: _publish(db, name, content) for name, content in packages.items()}
    changes = []
    for row in rows:
        if row.kind == "Ghost" and not row.is_active:
            continue
        if (
            row.kind == "Ghost"
            and row.user_id == 0
            and row.namespace == "default"
            and row.name in catalog.seed_ghosts
        ):
            data = deepcopy(row.json)
            spec = data.setdefault("spec", {})
            spec["skills"] = list(spec.get("skills") or [])
            spec["skill_refs"] = dict(spec.get("skill_refs") or {})
            for name, asset in assets.items():
                if name not in spec["skills"]:
                    spec["skills"].append(name)
                    spec.setdefault("skill_refs", {})[name] = build_skill_ref_meta(
                        asset
                    )
            if row.json != data:
                row.json = data
                flag_modified(row, "json")
                changes.append({"kind": row.kind, "id": row.id})
        for name, target_names in catalog.expansions.items():
            targets = [assets[target] for target in target_names]
            changed = False
            if row.kind == "Ghost":
                changed = _expand_ghost(db, row, assets[name], targets)
            elif row.kind == "Template":
                # Templates without an exact source binding need no Shell lookup.
                resources = row.json.get("spec", {}).get("resources") or {}
                ghost = resources.get("ghost") or {}
                if any(
                    ref.get("name") == name
                    for key in ["skillRefs", "preloadSkillRefs"]
                    for ref in (ghost.get(key) or [])
                ):
                    changed = _expand_template(db, row, assets[name], targets)
            elif row.kind in {"SkillBinding", "InstalledSkill"}:
                changed = _expand_installation(db, row, assets[name], targets)
            if changed:
                changes.append({"kind": row.kind, "id": row.id})
    db.flush()
    return {
        "assets": {name: asset.id for name, asset in assets.items()},
        "bindings": list(
            {(item["kind"], item["id"]): item for item in changes}.values()
        ),
    }
