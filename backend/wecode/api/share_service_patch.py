# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch UnifiedShareService to resolve display names with ERP priority
(wecode_erp_user.erp_name > users.user_name) for both approved members and
pending requests.
"""

try:
    from app.services.share.base_service import UnifiedShareService
except Exception:
    UnifiedShareService = None


def _resolve_erp_names(db, items, name_field: str = "user_id") -> dict:
    """Batch resolve ERP names (erp_name + optional employee_id) for a list of items."""
    all_user_ids = set()
    for item in items:
        uid = getattr(item, name_field, None)
        if uid:
            all_user_ids.add(uid)
    return _batch_resolve_erp(db, all_user_ids)


def _batch_resolve_erp(db, user_ids: set) -> dict:
    """Batch resolve ERP names from a set of user_ids."""
    if not user_ids:
        return {}

    from wecode.models.erp_user import WecodeErpUser

    erp_map = {}
    for erp in (
        db.query(WecodeErpUser).filter(WecodeErpUser.user_id.in_(user_ids)).all()
    ):
        if erp.erp_name:
            display_name = erp.erp_name
            if erp.employee_id:
                display_name = f"{erp.erp_name} ({erp.employee_id})"
            erp_map[erp.user_id] = display_name
    return erp_map


def _collect_user_ids(items, name_field: str) -> set:
    """Extract unique user_ids from a list of objects."""
    return {uid for item in items if (uid := getattr(item, name_field, None))}


def apply_patch() -> None:
    if UnifiedShareService is None:
        return

    # --- Patch get_members ---
    _orig_get_members = UnifiedShareService.get_members

    def patched_get_members(self, db, resource_id, user_id):
        result = _orig_get_members(self, db, resource_id, user_id)

        # Collect user_ids: collaborators + inviters, batch resolve once
        all_user_ids = _collect_user_ids(result.members, "user_id")
        all_user_ids |= _collect_user_ids(result.members, "invited_by_user_id")
        erp_map = _batch_resolve_erp(db, all_user_ids)

        # Replace names in-place
        for m in result.members:
            if m.entity_type == "user" and m.user_id in erp_map:
                m.display_name = erp_map[m.user_id]
            if m.invited_by_user_id in erp_map:
                m.invited_by_user_name = erp_map[m.invited_by_user_id]

        return result

    UnifiedShareService.get_members = patched_get_members

    # --- Patch get_pending_requests ---
    _orig_get_pending_requests = UnifiedShareService.get_pending_requests

    def patched_get_pending_requests(self, db, resource_id, user_id):
        result = _orig_get_pending_requests(self, db, resource_id, user_id)

        # Batch resolve ERP names for pending request users
        erp_map = _resolve_erp_names(db, result.requests, "user_id")
        for req in result.requests:
            if req.user_id in erp_map:
                req.user_name = erp_map[req.user_id]

        return result

    UnifiedShareService.get_pending_requests = patched_get_pending_requests


# Auto apply on import (consistent with all other wecode patches)
apply_patch()
