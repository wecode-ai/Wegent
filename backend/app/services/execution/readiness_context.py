# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Batch Team dependencies without changing the execution resolver policies."""

from pydantic import ValidationError
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Team
from app.services.capability_lookup import ExecutionCapabilityLookup
from app.services.chat.config.model_lookup import _bound_model_names
from app.services.readers.kinds import KindReader, KindType
from app.services.resource_lookup_queries import lookup_batches

DependencyRef = tuple[int, KindType, str, str]


class _DependencyReader(KindReader):
    """Use the standard personal/public/group selection on prefetched rows."""

    def __init__(self, db: Session) -> None:
        """
        Initialize request-local dependency state without persisting authorization.
        """
        self.db = db
        self._owned: dict[DependencyRef, Kind] = {}
        self._groups: dict[tuple[KindType, str, str], Kind] = {}

    def load(self, references: set[DependencyRef]) -> None:
        """Load active dependency references under the standard ownership rules."""
        requests = [
            {
                "owner": owner,
                "kind": kind.value,
                "namespace": namespace,
                "name": name,
                "personal": int(namespace == "default"),
            }
            for owner, kind, namespace, name in sorted(references)
        ]
        for requested in lookup_batches(requests):
            rows = (
                self.db.query(
                    requested.c.kind, requested.c.namespace, requested.c.name, Kind
                )
                .join(
                    Kind,
                    and_(
                        Kind.kind == requested.c.kind,
                        Kind.namespace == requested.c.namespace,
                        Kind.name == requested.c.name,
                        or_(
                            requested.c.personal == 0,
                            Kind.user_id == requested.c.owner,
                            Kind.user_id == 0,
                        ),
                    ),
                )
                .filter(Kind.is_active.is_(True))
                .order_by(Kind.id)
                .all()
            )
            for kind_name, namespace, name, row in rows:
                kind = KindType(kind_name)
                self._owned.setdefault((row.user_id, kind, namespace, name), row)
                self._groups.setdefault((kind, namespace, name), row)

    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Kind | None:
        """Return the prefetched dependency for the exact personal identity."""
        return self._owned.get((user_id, kind, namespace, name))

    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Kind | None:
        """Return the prefetched dependency owned by the public identity."""
        return self._owned.get((0, kind, namespace, name))

    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Kind | None:
        """Return the prefetched dependency from the requested group namespace."""
        return self._groups.get((kind, namespace, name))


class TeamReadinessContext:
    """Own dependency and permission results for exactly one catalog read."""

    def __init__(self, db: Session, teams: list[Kind], execution_user_id: int) -> None:
        """
        Initialize request-local dependency state without persisting authorization.
        """
        self.db = db
        self.execution_user_id = execution_user_id
        self.reader = _DependencyReader(db)
        self._capabilities: dict[int, ExecutionCapabilityLookup] = {}
        bot_refs: set[DependencyRef] = set()
        for team in teams:
            try:
                crd = Team.model_validate(team.json)
            except ValidationError:
                continue
            for member in crd.spec.members:
                bot_refs.add(
                    (
                        team.user_id,
                        KindType.BOT,
                        member.botRef.namespace,
                        member.botRef.name,
                    )
                )
        self.reader.load(bot_refs)
        self._load_bot_dependencies(bot_refs)

    def capabilities(self, user_id: int) -> ExecutionCapabilityLookup:
        """Keep capability caches separate for each execution identity."""
        if user_id not in self._capabilities:
            self._capabilities[user_id] = ExecutionCapabilityLookup(self.db, user_id)
        return self._capabilities[user_id]

    def _load_bot_dependencies(self, references: set[DependencyRef]) -> None:
        """Collect Ghosts, Shells and model names from resolved member Bots."""
        ghosts: set[DependencyRef] = set()
        for owner, kind, namespace, name in references:
            bot = self.reader.get_by_name_and_namespace(
                self.db, owner, kind, namespace, name
            )
            if bot is None:
                continue
            try:
                crd = Bot.model_validate(bot.json)
            except ValidationError:
                continue
            ghosts.add(
                (
                    owner,
                    KindType.GHOST,
                    crd.spec.ghostRef.namespace,
                    crd.spec.ghostRef.name,
                )
            )
            self.capabilities(owner).names["Shell"].add(crd.spec.shellRef.name)
            if crd.spec.execution_policy is None:
                raw_config = bot.json.get("spec", {}).get("agent_config")
                self.capabilities(self.execution_user_id).names["Model"].update(
                    _bound_model_names(
                        crd, raw_config if isinstance(raw_config, dict) else {}
                    )
                )
        self.reader.load(ghosts)
