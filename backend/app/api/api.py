# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints import (
    admin,
    api_keys,
    auth,
    devices,
    groups,
    health,
    knowledge,
    oidc,
    openapi_responses,
    pet,
    projects,
    quota,
    rag,
    repository,
    subtasks,
    tables,
    users,
    utils,
    web_scraper,
    wiki,
    wizard,
)
from app.api.endpoints.adapter import (
    agents,
    attachments,
    bots,
    chat,
    dify,
    executors,
    models,
    retrievers,
    shells,
    subscription_follows,
    subscription_market,
    subscriptions,
    task_knowledge_bases,
    task_members,
    tasks,
    teams,
)
from app.api.endpoints.internal import bots_router as internal_bots_router
from app.api.endpoints.internal import (
    chat_storage_router,
    rag_router,
    services_router,
    skills_router,
    subscriptions_router,
    tables_router,
)
from app.api.endpoints.kind import k_router
from app.api.router import api_router

# Health check endpoints (no prefix, directly under /api)
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(oidc.router, prefix="/auth/oidc", tags=["auth", "oidc"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(pet.router, prefix="/users/me/pet", tags=["pet"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(groups.router, prefix="/groups", tags=["groups"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(api_keys.router, prefix="/api-keys", tags=["api-keys"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(models.router, prefix="/models", tags=["public-models"])
api_router.include_router(shells.router, prefix="/shells", tags=["shells"])
api_router.include_router(agents.router, prefix="/agents", tags=["public-shell"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(
    subscriptions.router, prefix="/subscriptions", tags=["subscriptions"]
)
# Subscription follow endpoints (follow, unfollow, invitations)
api_router.include_router(
    subscription_follows.router, prefix="/subscriptions", tags=["subscription-follows"]
)
api_router.include_router(
    subscription_follows.user_router, prefix="/users/me", tags=["user-subscriptions"]
)
api_router.include_router(
    subscription_follows.invitation_router,
    prefix="/subscription-invitations",
    tags=["subscription-invitations"],
)
# Subscription market endpoints (browse, rent, rentals)
api_router.include_router(
    subscription_market.router, prefix="/market", tags=["subscription-market"]
)
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(subtasks.router, prefix="/subtasks", tags=["subtasks"])
api_router.include_router(task_members.router, prefix="/tasks", tags=["task-members"])
api_router.include_router(
    task_knowledge_bases.router, prefix="/tasks", tags=["task-knowledge-bases"]
)
api_router.include_router(chat.router, prefix="/chat", tags=["chat"])
api_router.include_router(
    attachments.router, prefix="/attachments", tags=["attachments"]
)
api_router.include_router(repository.router, prefix="/git", tags=["repository"])
api_router.include_router(executors.router, prefix="/executors", tags=["executors"])
api_router.include_router(quota.router, prefix="/quota", tags=["quota"])
api_router.include_router(dify.router, prefix="/dify", tags=["dify"])
api_router.include_router(retrievers.router, prefix="/retrievers", tags=["retrievers"])
api_router.include_router(wiki.router, prefix="/wiki", tags=["wiki"])
api_router.include_router(
    wiki.internal_router, prefix="/internal/wiki", tags=["wiki-internal"]
)
api_router.include_router(wizard.router, prefix="/wizard", tags=["wizard"])
api_router.include_router(
    openapi_responses.router, prefix="/v1/responses", tags=["openapi-responses"]
)
api_router.include_router(
    knowledge.router, prefix="/knowledge-bases", tags=["knowledge"]
)
api_router.include_router(
    knowledge.document_router, prefix="/knowledge-documents", tags=["knowledge"]
)
api_router.include_router(
    knowledge.qa_history_router,
    prefix="/v1/knowledge-base/qa-history",
    tags=["knowledge-qa-history"],
)
api_router.include_router(
    knowledge.summary_router,
    prefix="/knowledge-bases",
    tags=["knowledge-summary"],
)
api_router.include_router(tables.router, prefix="/tables", tags=["tables"])
api_router.include_router(rag.router, prefix="/rag", tags=["rag"])
api_router.include_router(utils.router, prefix="/utils", tags=["utils"])
api_router.include_router(
    web_scraper.router, prefix="/web-scraper", tags=["web-scraper"]
)
api_router.include_router(k_router)

# Internal API endpoints (for service-to-service communication)
api_router.include_router(
    chat_storage_router, prefix="/internal", tags=["internal-chat"]
)
api_router.include_router(rag_router, prefix="/internal", tags=["internal-rag"])
api_router.include_router(skills_router, prefix="/internal", tags=["internal-skills"])
api_router.include_router(tables_router, prefix="/internal", tags=["internal-tables"])
api_router.include_router(
    internal_bots_router, prefix="/internal", tags=["internal-bots"]
)
api_router.include_router(
    services_router, prefix="/internal", tags=["internal-services"]
)
api_router.include_router(
    subscriptions_router, prefix="/internal", tags=["internal-subscriptions"]
)
