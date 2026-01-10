# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified form submission service module.

This module provides a pluggable form handling system with:
- Registry pattern for handler registration
- Base handler class for implementing form processors
- Support for different action types (clarification, final_prompt, pipeline_confirmation, etc.)
"""

from app.services.forms.base_handler import BaseFormHandler, FormHandlerResult
from app.services.forms.registry import form_handler, get_handler
from app.services.forms.service import FormSubmissionService

__all__ = [
    "BaseFormHandler",
    "FormHandlerResult",
    "form_handler",
    "get_handler",
    "FormSubmissionService",
]
