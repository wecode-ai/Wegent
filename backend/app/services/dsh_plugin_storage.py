# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generic DSH plugin KV storage backed by the existing Kind table."""

import re
from copy import deepcopy
from typing import Any, Dict, List

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.dsh_plugin_storage import DshStorageDescriptor

DSH_PLUGIN_DATA_KIND = "DshPluginData"
UNIT_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
PACKAGE_NAME_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


class DshPluginStorageService:
    """Store plugin-owned KV units without introducing plugin-specific tables."""

    def load_unit(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
        descriptor: DshStorageDescriptor,
    ) -> Dict[str, Any]:
        self.validate_identity(package_name, unit)
        self.validate_descriptor(descriptor)
        resource = self._resource(db, user_id, package_name, unit)
        if resource is None:
            return self._empty_snapshot(descriptor)
        document = self._document(resource)
        self._require_compatible(document, descriptor)
        return self._public_snapshot(document)

    def put_record(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
        table: str,
        key: str,
        descriptor: DshStorageDescriptor,
        value: Any,
        shared: bool,
    ) -> None:
        self._validate_record_target(package_name, unit, table, key, descriptor)
        resource = self._locked_resource(db, user_id, package_name, unit)
        document = (
            self._new_document(descriptor)
            if resource is None
            else deepcopy(self._document(resource))
        )
        self._require_compatible(document, descriptor)
        document["tables"][table][key] = {"value": value, "shared": shared}
        self._save(db, resource, user_id, package_name, unit, document)

    def delete_record(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
        table: str,
        key: str,
        descriptor: DshStorageDescriptor,
    ) -> None:
        self._validate_record_target(package_name, unit, table, key, descriptor)
        resource = self._locked_resource(db, user_id, package_name, unit)
        if resource is None:
            return
        document = deepcopy(self._document(resource))
        self._require_compatible(document, descriptor)
        document["tables"][table].pop(key, None)
        resource.json = document
        db.commit()

    def set_global(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
        descriptor: DshStorageDescriptor,
        value: Any,
    ) -> None:
        self.validate_identity(package_name, unit)
        self.validate_descriptor(descriptor)
        if not descriptor.has_global:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Storage unit does not declare a global value",
            )
        resource = self._locked_resource(db, user_id, package_name, unit)
        document = (
            self._new_document(descriptor)
            if resource is None
            else deepcopy(self._document(resource))
        )
        self._require_compatible(document, descriptor)
        document["global"] = value
        self._save(db, resource, user_id, package_name, unit, document)

    def scan_shared(
        self,
        db: Session,
        package_name: str,
        unit: str,
        table: str,
        limit: int,
    ) -> List[Dict[str, Any]]:
        self.validate_identity(package_name, unit)
        self._validate_name(table, "table")
        rows = (
            db.query(Kind, User)
            .join(User, User.id == Kind.user_id)
            .filter(
                Kind.kind == DSH_PLUGIN_DATA_KIND,
                Kind.namespace == package_name,
                Kind.name == unit,
                Kind.is_active == True,
                User.is_active == True,
            )
            .order_by(Kind.updated_at.desc(), Kind.id.desc())
            .all()
        )
        records: List[Dict[str, Any]] = []
        for resource, owner in rows:
            entries = self._document(resource).get("tables", {}).get(table, {})
            if not isinstance(entries, dict):
                continue
            for key, entry in entries.items():
                if not isinstance(entry, dict) or entry.get("shared") is not True:
                    continue
                records.append(
                    {
                        "owner_id": owner.id,
                        "owner_name": owner.user_name,
                        "key": key,
                        "value": entry.get("value"),
                    }
                )
                if len(records) >= limit:
                    return records
        return records

    def validate_identity(self, package_name: str, unit: str) -> None:
        if len(package_name) > 100 or not PACKAGE_NAME_RE.fullmatch(package_name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid DSH package name",
            )
        self._validate_name(unit, "unit")

    def validate_descriptor(self, descriptor: DshStorageDescriptor) -> None:
        if len(set(descriptor.tables)) != len(descriptor.tables):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Storage descriptor contains duplicate tables",
            )
        for table in descriptor.tables:
            self._validate_name(table, "table")

    def _validate_record_target(
        self,
        package_name: str,
        unit: str,
        table: str,
        key: str,
        descriptor: DshStorageDescriptor,
    ) -> None:
        self.validate_identity(package_name, unit)
        self.validate_descriptor(descriptor)
        if table not in descriptor.tables:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Table '{table}' is not declared by the storage unit",
            )
        if not key or len(key) > 512:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Storage record key must contain 1 to 512 characters",
            )

    def _validate_name(self, value: str, label: str) -> None:
        if len(value) > 100 or not UNIT_NAME_RE.fullmatch(value):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid storage {label} name",
            )

    def _resource(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
    ) -> Kind | None:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == DSH_PLUGIN_DATA_KIND,
                Kind.namespace == package_name,
                Kind.name == unit,
                Kind.is_active == True,
            )
            .order_by(Kind.id.desc())
            .first()
        )

    def _locked_resource(
        self,
        db: Session,
        user_id: int,
        package_name: str,
        unit: str,
    ) -> Kind | None:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == DSH_PLUGIN_DATA_KIND,
                Kind.namespace == package_name,
                Kind.name == unit,
                Kind.is_active == True,
            )
            .order_by(Kind.id.desc())
            .with_for_update()
            .first()
        )

    def _save(
        self,
        db: Session,
        resource: Kind | None,
        user_id: int,
        package_name: str,
        unit: str,
        document: Dict[str, Any],
    ) -> None:
        if resource is None:
            resource = Kind(
                user_id=user_id,
                kind=DSH_PLUGIN_DATA_KIND,
                namespace=package_name,
                name=unit,
                json=document,
            )
            db.add(resource)
        else:
            resource.json = document
        db.commit()

    def _document(self, resource: Kind) -> Dict[str, Any]:
        if not isinstance(resource.json, dict):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stored DSH plugin data is malformed",
            )
        return resource.json

    def _require_compatible(
        self,
        document: Dict[str, Any],
        descriptor: DshStorageDescriptor,
    ) -> None:
        if document.get("version") != descriptor.version:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Storage unit version does not match",
            )
        if document.get("table_names") != descriptor.tables:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Storage unit tables do not match",
            )
        if document.get("has_global") is not descriptor.has_global:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Storage unit global declaration does not match",
            )

    def _new_document(self, descriptor: DshStorageDescriptor) -> Dict[str, Any]:
        return {
            "version": descriptor.version,
            "table_names": list(descriptor.tables),
            "has_global": descriptor.has_global,
            "tables": {table: {} for table in descriptor.tables},
            "global": None,
        }

    def _empty_snapshot(self, descriptor: DshStorageDescriptor) -> Dict[str, Any]:
        return self._public_snapshot(self._new_document(descriptor))

    def _public_snapshot(self, document: Dict[str, Any]) -> Dict[str, Any]:
        tables = {
            table: {
                key: entry.get("value")
                for key, entry in entries.items()
                if isinstance(entry, dict)
            }
            for table, entries in document.get("tables", {}).items()
            if isinstance(entries, dict)
        }
        return {
            "version": document["version"],
            "tables": tables,
            "global": document.get("global"),
        }


dsh_plugin_storage_service = DshPluginStorageService()
