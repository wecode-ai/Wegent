# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Built-in template seed data for the Inbox template system.

These templates are created on application startup if they don't already exist.
"""

import logging
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.models.kind import Kind

logger = logging.getLogger(__name__)

TEMPLATE_KIND = "Template"
TEMPLATE_NAMESPACE = "system"
TEMPLATE_USER_ID = 0

BUILT_IN_TEMPLATES: List[Dict[str, Any]] = [
    {
        "name": "daily-standup-summary",
        "spec": {
            "displayName": "Daily Standup Summary",
            "description": (
                "Collect team standup reports and generate a structured summary "
                "with key highlights and blockers."
            ),
            "category": "inbox",
            "tags": ["standup", "summary", "team"],
            "icon": "\U0001f4cb",
            "resources": {
                "ghost": {
                    "systemPrompt": (
                        "You are a daily standup summarizer. When you receive messages, "
                        "extract the following from each: what was done yesterday, "
                        "what is planned today, and any blockers. Compile a structured "
                        "summary with sections for each person, highlight cross-team "
                        "dependencies, and list all blockers at the top."
                    ),
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": (
                        "Please process the following standup report and "
                        "generate a structured summary:\n\n{{inbox_message}}"
                    ),
                    "retryCount": 1,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            },
        },
    },
    {
        "name": "bug-report-handler",
        "spec": {
            "displayName": "Bug Report Handler",
            "description": (
                "Receive bug reports, automatically classify severity and "
                "priority, and output structured issue details."
            ),
            "category": "inbox",
            "tags": ["bug", "triage", "issue"],
            "icon": "\U0001f41b",
            "resources": {
                "ghost": {
                    "systemPrompt": (
                        "You are a bug report analyst. For each incoming bug report, "
                        "identify: severity (critical/major/minor/trivial), "
                        "affected component, steps to reproduce, expected vs actual "
                        "behavior, and suggested priority. Output a structured report "
                        "in markdown format."
                    ),
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": (
                        "Analyze the following bug report and provide a structured "
                        "classification:\n\n{{inbox_message}}"
                    ),
                    "retryCount": 2,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            },
        },
    },
    {
        "name": "customer-feedback-collector",
        "spec": {
            "displayName": "Customer Feedback Collector",
            "description": (
                "Collect customer feedback, extract key requirements, "
                "and produce structured analysis."
            ),
            "category": "inbox",
            "tags": ["customer", "feedback", "requirements"],
            "icon": "\U0001f4dd",
            "resources": {
                "ghost": {
                    "systemPrompt": (
                        "You are a customer feedback analyst. For each piece of "
                        "feedback, extract: sentiment (positive/neutral/negative), "
                        "category (feature request/bug report/improvement/question), "
                        "key requirements, and actionable items. Produce a structured "
                        "analysis with prioritization suggestions."
                    ),
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": (
                        "Analyze the following customer feedback and extract "
                        "key insights:\n\n{{inbox_message}}"
                    ),
                    "retryCount": 1,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            },
        },
    },
    {
        "name": "code-review-assistant",
        "spec": {
            "displayName": "Code Review Assistant",
            "description": (
                "Receive code review requests and provide automated pre-review "
                "with best practice suggestions."
            ),
            "category": "inbox",
            "tags": ["code", "review", "quality"],
            "icon": "\U0001f50d",
            "resources": {
                "ghost": {
                    "systemPrompt": (
                        "You are a code review assistant. For each code submission, "
                        "check for: coding style consistency, potential bugs, "
                        "security issues, performance concerns, and adherence to "
                        "best practices. Provide constructive feedback with specific "
                        "line references when possible."
                    ),
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": (
                        "Review the following code submission and provide "
                        "feedback:\n\n{{inbox_message}}"
                    ),
                    "retryCount": 1,
                    "timeoutSeconds": 600,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            },
        },
    },
    {
        "name": "document-translation-assistant",
        "spec": {
            "displayName": "Document Translation Assistant",
            "description": (
                "Receive documents and automatically translate them while "
                "preserving formatting and technical terms."
            ),
            "category": "inbox",
            "tags": ["translation", "document", "i18n"],
            "icon": "\U0001f310",
            "resources": {
                "ghost": {
                    "systemPrompt": (
                        "You are a professional document translator. Translate "
                        "incoming documents between languages while preserving: "
                        "original formatting, technical terminology, code snippets "
                        "(untranslated), and markdown structure. If the source "
                        "language is Chinese, translate to English. If the source "
                        "language is English, translate to Chinese. For other "
                        "languages, translate to English."
                    ),
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": (
                        "Translate the following document:\n\n{{inbox_message}}"
                    ),
                    "retryCount": 1,
                    "timeoutSeconds": 600,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            },
        },
    },
]


def seed_templates(db: Session) -> int:
    """Seed built-in templates if they don't already exist.

    Returns the number of newly created templates.
    """
    created_count = 0

    for tpl_data in BUILT_IN_TEMPLATES:
        name = tpl_data["name"]

        existing = (
            db.query(Kind)
            .filter(
                Kind.kind == TEMPLATE_KIND,
                Kind.name == name,
                Kind.namespace == TEMPLATE_NAMESPACE,
                Kind.is_active == True,
            )
            .first()
        )

        if existing:
            logger.debug(f"Template '{name}' already exists, skipping")
            continue

        resource_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": TEMPLATE_KIND,
            "metadata": {
                "name": name,
                "namespace": TEMPLATE_NAMESPACE,
            },
            "spec": tpl_data["spec"],
            "status": {"state": "Available"},
        }

        db_template = Kind(
            user_id=TEMPLATE_USER_ID,
            kind=TEMPLATE_KIND,
            name=name,
            namespace=TEMPLATE_NAMESPACE,
            json=resource_json,
            is_active=True,
        )
        db.add(db_template)
        created_count += 1
        logger.info(f"Seeded built-in template: {name}")

    if created_count > 0:
        db.commit()
        logger.info(f"Seeded {created_count} built-in templates")

    return created_count
