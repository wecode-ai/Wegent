# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Export services for generating task exports in various formats.

Note: docx_generator is lazy-loaded to avoid loading python-docx at startup.
Import directly from app.services.export.docx_generator when needed.
"""

__all__ = ["generate_task_docx"]


def __getattr__(name: str):
    """Lazy load docx_generator to avoid loading python-docx at startup."""
    if name == "generate_task_docx":
        from app.services.export.docx_generator import generate_task_docx

        return generate_task_docx
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
