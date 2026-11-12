# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Request-local, batched capability reads for execution validation."""

from collections import defaultdict
from typing import Any, Literal, cast

from sqlalchemy import String
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.schemas.namespace import GroupRole
from app.services.capability_reference_service import (
    list_referenced_capabilities_by_namespace,
)
from app.services.execution_permission_scope import is_execution_resource_scope
from app.services.external_entity_resolver import (
    EntityFact,
    EntityMembershipUnavailable,
)
from app.services.resource_lookup_queries import named_kind_rows


class ExecutionCapabilityLookup:
    """Resolve one execution identity without retaining permissions across requests."""

    def __init__(self, db: Session, user_id: int) -> None:
        """
        Keep capability reads and permission results within one execution identity.
        """
        self.db = db
        self.user_id = user_id
        self.names: dict[str, set[str]] = defaultdict(set)
        self._direct: dict[tuple, dict[str, Kind | None]] = {}
        self._references: dict[str, dict[str, dict[str, Kind]]] = defaultdict(dict)
        self._model_reference_sources: dict[str, list[Kind]] = {}
        self._model_reference_names: set[str] = set()
        self._group_names: dict[bool, list[str]] = {}
        self._memberships: dict[
            tuple[bool, str], bool | EntityMembershipUnavailable
        ] = {}
        self._group_rows: dict[str, dict[str, list[Kind]]] = {}
        self._group_refs: dict[str, dict[str, list[tuple[Kind, str]]]] = {}
        self._runtime_models: dict[str, dict[str, Any] | None] = {}

    @property
    def groups(self) -> list[str]:
        """Resolve membership once per permission scope in this request."""
        from app.services.group_permission import get_user_groups

        explicit = is_execution_resource_scope()
        if explicit not in self._group_names:
            self._group_names[explicit] = get_user_groups(self.db, self.user_id)
        return self._group_names[explicit]

    def _preload_memberships(self, namespaces: list[str]) -> None:
        from app.services.group_permission import group_permission_decisions

        explicit = is_execution_resource_scope()
        missing = sorted(
            {name for name in namespaces if (explicit, name) not in self._memberships}
        )
        if not missing:
            return
        active = {
            row[0]
            for row in self.db.query(Namespace.name)
            .filter(Namespace.name.in_(missing), Namespace.is_active.is_(True))
            .all()
        }
        decisions = group_permission_decisions(
            self.db,
            self.user_id,
            sorted(active),
            GroupRole.RestrictedAnalyst,
            include_namespace_entities=True,
        )
        for name in missing:
            self._memberships[(explicit, name)] = decisions.get(name, False)

    def member_namespaces(self, namespaces: list[str]) -> set[str]:
        """Resolve one caller-selected namespace set with a single fact batch."""
        self._preload_memberships(namespaces)
        return {
            name for name in dict.fromkeys(namespaces) if self.is_group_member(name)
        }

    def is_group_member(self, namespace: str) -> bool:
        """Authorize one active namespace, without global membership enumeration."""
        self._preload_memberships([namespace])
        result = self._memberships[(is_execution_resource_scope(), namespace)]
        if isinstance(result, EntityMembershipUnavailable):
            raise result
        return result

    def _load_group_candidates(self, kind: str, name: str) -> None:
        self.names[kind].add(name)
        index = self._group_rows.setdefault(kind, {})
        refs = self._group_refs.setdefault(kind, {})
        missing = self.names[kind] - index.keys()
        if not missing:
            return
        rows = named_kind_rows(self.db, missing, [Kind.kind == kind])
        source_ids = {row.id for _, row in rows if row.user_id != 0}
        targets: dict[int, list[str]] = defaultdict(list)
        if source_ids:
            for source_id, namespace in (
                self.db.query(ResourceMember.resource_id, Namespace.name)
                .join(Namespace, ResourceMember.entity_id == Namespace.id.cast(String))
                .filter(
                    ResourceMember.resource_type == kind,
                    ResourceMember.resource_id.in_(source_ids),
                    ResourceMember.entity_type == "namespace",
                    ResourceMember.status == "approved",
                    Namespace.is_active.is_(True),
                )
                .all()
            ):
                targets[source_id].append(namespace)
        for requested in missing:
            sources = [row for label, row in rows if label == requested]
            index[requested] = [row for row in sources if row.namespace != "default"]
            refs[requested] = sorted(
                [
                    (row, ns)
                    for row in sources
                    if kind == "Model" or row.name == requested
                    for ns in targets.get(cast(int, row.id), [])
                ],
                key=lambda pair: (pair[1], pair[0].id),
            )

    def _choose_group_candidate(
        self,
        candidates: list[tuple[Kind, str]],
        *,
        include_namespace: bool,
    ) -> tuple[Kind, str] | None:
        from app.services.group_permission import group_permission_decisions

        possible: dict[object, tuple[Kind, str] | None] = {}
        absent: frozenset[EntityFact] = frozenset()
        pending = None
        explicit = is_execution_resource_scope()
        names = list(dict.fromkeys(ns for _, ns in candidates))
        for resource, namespace in candidates:
            decision = self._memberships[(explicit, namespace)]
            if absent and decision is not False:
                decision = group_permission_decisions(
                    self.db,
                    self.user_id,
                    names,
                    GroupRole.RestrictedAnalyst,
                    include_namespace_entities=True,
                    absent=absent,
                )[namespace]
            if decision is False:
                continue
            key = (resource.id, namespace) if include_namespace else resource.id
            possible[key] = (resource, namespace)
            if decision is True:
                break
            pending = decision
            absent |= frozenset().union(*decision.dependencies.values())
        else:
            possible[None] = None
        if len(possible) != 1:
            assert pending is not None
            raise pending
        chosen = next(iter(possible.values()))
        if chosen:
            self._include_model_pointers(cast(str, chosen[0].kind), [chosen[0]])
        return chosen

    def _group_source(
        self,
        kind: str,
        name: str,
        mode: Literal["native-first", "references", "namespace", "native"],
        *,
        include_namespace: bool = False,
    ) -> tuple[Kind, str] | None:
        from app.services.external_entity_resolver import entity_resolution_scope

        with entity_resolution_scope(self.db):
            self._load_group_candidates(kind, name)
            native = [
                (row, cast(str, row.namespace)) for row in self._group_rows[kind][name]
            ]
            refs = self._group_refs[kind][name]
            if mode == "native":
                candidates = sorted(native, key=lambda pair: (pair[1], pair[0].id))
            elif mode == "references":
                candidates = refs
            elif mode == "namespace":
                names = sorted({ns for _, ns in native + refs})
                candidates = [
                    pair for ns in names for pair in native + refs if pair[1] == ns
                ]
            else:
                candidates = native + refs
            self._preload_memberships([ns for _, ns in candidates])
            return self._choose_group_candidate(
                candidates, include_namespace=include_namespace
            )

    def group_model(self, name: str) -> Kind | None:
        selected = self._group_source("Model", name, "native-first")
        return selected[0] if selected else None

    def referenced_group_model(self, name: str) -> tuple[Kind, str] | None:
        return self._group_source("Model", name, "references", include_namespace=True)

    def native_group_shell(self, name: str) -> Kind | None:
        selected = self._group_source("Shell", name, "native")
        return selected[0] if selected else None

    def group_shell(self, name: str) -> Kind | None:
        selected = self._group_source("Shell", name, "namespace")
        return selected[0] if selected else None

    def group_shell_scope(self, name: str) -> tuple[Kind, str] | None:
        return self._group_source("Shell", name, "namespace", include_namespace=True)

    def personal(
        self, kind: str, name: str, namespace: str | None = None
    ) -> Kind | None:
        """Read an active personal capability in the requested namespace."""
        filters = [Kind.user_id == self.user_id]
        if namespace is not None:
            filters.append(Kind.namespace == namespace)
        return self._read_direct(kind, name, ("personal", namespace), filters)

    def public(self, kind: str, name: str) -> Kind | None:
        """Read an active public capability from the default namespace."""
        return self._read_direct(
            kind,
            name,
            ("public",),
            [Kind.user_id == 0, Kind.namespace == "default"],
        )

    def runtime_model(self, name: str) -> dict[str, Any] | None:
        """Resolve each runtime model once without caching across requests."""
        from app.services.runtime_codex_model import (
            get_enabled_codex_runtime_model_spec,
        )

        if name not in self._runtime_models:
            self._runtime_models[name] = get_enabled_codex_runtime_model_spec(
                self.db, self.user_id, name
            )
        return self._runtime_models[name]

    def group(self, kind: str, name: str, namespaces: list[str]) -> Kind | None:
        """Read an active capability from the authorized group namespaces."""
        if not namespaces:
            return None
        return self._read_direct(
            kind, name, ("group", *namespaces), [Kind.namespace.in_(namespaces)]
        )

    def referenced(self, kind: str, name: str, namespace: str) -> Kind | None:
        """Index approved references without changing their namespace authority."""
        references = self._references[kind]
        if namespace not in references:
            namespaces = (
                ["default"]
                if namespace == "default"
                else list(
                    dict.fromkeys(
                        [
                            namespace,
                            *self._group_names.get(is_execution_resource_scope(), []),
                        ]
                    )
                )
            )
            namespaces = [ns for ns in namespaces if ns not in references]
            rows = list_referenced_capabilities_by_namespace(
                self.db, kind=kind, user_id=self.user_id, namespaces=namespaces
            )
            for target, sources in rows.items():
                index: dict[str, Kind] = {}
                for source in sources:
                    index.setdefault(cast(str, source.name), source)
                references[target] = {} if kind == "Model" else index
                self._include_model_pointers(kind, sources)
                if kind == "Model":
                    self._model_reference_sources[target] = sources
            if kind == "Model":
                self._model_reference_names.clear()
        if kind == "Model":
            self._match_model_reference_names(name)
        return references[namespace].get(name)

    def _match_model_reference_names(self, name: str) -> None:
        """Match approved model references using the database name collation."""
        self.names["Model"].add(name)
        missing = self.names["Model"] - self._model_reference_names
        if not missing:
            return
        targets: dict[int, list[str]] = defaultdict(list)
        for namespace, sources in self._model_reference_sources.items():
            for source in sources:
                targets[cast(int, source.id)].append(namespace)
        if targets:
            matches = named_kind_rows(
                self.db, missing, [Kind.kind == "Model", Kind.id.in_(targets)]
            )
            for requested, source in matches:
                for namespace in targets[cast(int, source.id)]:
                    self._references["Model"][namespace].setdefault(requested, source)
        self._model_reference_names.update(missing)

    def _read_direct(
        self, kind: str, name: str, scope: tuple, filters: list[ColumnElement[bool]]
    ) -> Kind | None:
        """Batch pending names and retain both found and absent scoped results."""
        self.names[kind].add(name)
        index = self._direct.setdefault((kind, *scope), {})
        missing = self.names[kind] - index.keys()
        if missing:
            rows = named_kind_rows(self.db, missing, [Kind.kind == kind, *filters])
            index.update(dict.fromkeys(missing))
            for requested, row in rows:
                if index[requested] is None:
                    index[requested] = row
            self._include_model_pointers(kind, [row for _, row in rows])
        return index[name]

    def _include_model_pointers(self, kind: str, rows: list[Kind]) -> None:
        """Include bound model targets in subsequent batched model reads."""
        if kind != "Model":
            return
        for row in rows:
            payload: dict[str, Any] = row.json if isinstance(row.json, dict) else {}
            spec = payload.get("spec")
            if not isinstance(spec, dict):
                continue
            config = spec.get("modelConfig")
            if not isinstance(config, dict):
                continue
            pointer = config.get("bind_model")
            if not config.get("env") and isinstance(pointer, str) and pointer.strip():
                self.names[kind].add(pointer.strip())
