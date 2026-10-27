# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Request-local, batched capability reads for execution validation."""

from collections import defaultdict
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.services.capability_reference_service import (
    list_referenced_capabilities_by_namespace,
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
        self._group_names: list[str] | None = None
        self._runtime_models: dict[str, dict[str, Any] | None] = {}

    @property
    def groups(self) -> list[str]:
        """Resolve current group membership once for this request."""
        from app.services.group_permission import get_user_groups

        if self._group_names is None:
            self._group_names = get_user_groups(self.db, self.user_id)
        return self._group_names

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
                else list(dict.fromkeys([namespace, *(self._group_names or [])]))
            )
            namespaces = [ns for ns in namespaces if ns not in references]
            rows = list_referenced_capabilities_by_namespace(
                self.db, kind=kind, user_id=self.user_id, namespaces=namespaces
            )
            for target, sources in rows.items():
                index: dict[str, Kind] = {}
                for source in sources:
                    index.setdefault(source.name, source)
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
                targets[source.id].append(namespace)
        if targets:
            matches = named_kind_rows(
                self.db, missing, [Kind.kind == "Model", Kind.id.in_(targets)]
            )
            for requested, source in matches:
                for namespace in targets[source.id]:
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
            payload = row.json if isinstance(row.json, dict) else {}
            spec = payload.get("spec")
            if not isinstance(spec, dict):
                continue
            config = spec.get("modelConfig")
            if not isinstance(config, dict):
                continue
            pointer = config.get("bind_model")
            if not config.get("env") and isinstance(pointer, str) and pointer.strip():
                self.names[kind].add(pointer.strip())
