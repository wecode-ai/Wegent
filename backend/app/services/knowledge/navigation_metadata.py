# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project navigation metadata using the grouped query's batched ACL facts."""

from sqlalchemy.orm import Session

from app.schemas.base_role import get_highest_role
from app.schemas.knowledge import AllGroupedKnowledgeResponse
from app.services.knowledge.knowledge_visibility_query import (
    DirectAccessPermissionContext,
)
from app.services.knowledge.namespace_utils import load_active_namespace_map


def enrich_navigation_metadata(
    db: Session,
    response: AllGroupedKnowledgeResponse,
    context: DirectAccessPermissionContext,
) -> None:
    """Keep source space and effective roles independent of share destinations."""
    items = [
        *response.personal.created_by_me,
        *response.personal.shared_with_me,
        *(kb for group in response.groups for kb in group.knowledge_bases),
        *response.organization.knowledge_bases,
    ]
    names = {item.namespace for item in items if item.namespace != "default"}
    namespaces = load_active_namespace_map(db, names)
    direct_roles = {
        member.resource_id: member.get_effective_role()
        for member in context.direct_members
    }
    organization_roles = {
        item.id: item.my_role for item in response.organization.knowledge_bases
    }
    for item in items:
        namespace = namespaces.get(item.namespace)
        item.namespace_level = (
            "personal"
            if item.namespace == "default"
            else namespace.level if namespace else None
        )
        item.namespace_display_name = (
            namespace.display_name or namespace.name if namespace else None
        )
        roles = list(context.external_member_role_map.get(item.id, ()))
        if item.user_id == context.user.id:
            roles.append("Owner")
        if role := direct_roles.get(item.id):
            roles.append(role)
        if item.namespace in context.organization_names:
            # Organization rows already resolve membership per source namespace.
            if role := organization_roles.get(item.id):
                roles.append(role)
        elif role := context.group_roles.get(item.namespace):
            roles.append(role.value)
        item.my_role = get_highest_role(roles) if roles else None
