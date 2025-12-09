# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from string import Template
from typing import List, Optional

"""
Wiki Generation Prompts Configuration

This file contains the task prompt template for wiki documentation generation.
The wiki bot system prompt is defined in backend/init_data/01-default-resources.yaml
as the 'wiki-ghost' Ghost resource.

Optimization Notes:
- Task prompt focuses on WHAT to do (project-specific parameters)
- Ghost system prompt focuses on HOW to do it (tool usage, format rules)
- This separation reduces redundancy and improves maintainability
"""

# Simplified task prompt template for wiki generation
WIKI_TASK_PROMPT_TEMPLATE = Template(
    """Generate comprehensive technical documentation for the repository: **${project_name}**

## Task Configuration

- `WIKI_GENERATION_ID`: ${generation_id}
- **Target Language**: ${language}
- **Section Types**: ${section_types}

Begin by analyzing the repository structure and generating documentation."""
)


# Additional notes for different generation types
GENERATION_TYPE_NOTES = {
    "full": "",
    "incremental": "\n\nNote: This is an incremental update task, please focus on recent code changes.",
    "custom": "\n\nNote: This is a custom scope documentation generation task.",
}


def get_wiki_task_prompt(
    project_name: str,
    generation_type: str = "full",
    generation_id: Optional[int] = None,
    section_types: Optional[List[str]] = None,
    language: Optional[str] = None,
) -> str:
    """
    Generate wiki task prompt

    Args:
        project_name: Project name
        generation_type: Generation type (full/incremental/custom)
        generation_id: Wiki generation identifier for the current run
        section_types: Section types to cover in documentation
        language: Target language for documentation generation

    Returns:
        Complete task prompt
    """
    context = {
        "project_name": project_name,
        "generation_id": (
            generation_id if generation_id is not None else "UNKNOWN_GENERATION_ID"
        ),
        "section_types": ", ".join(
            section_types
            or ["overview", "architecture", "module", "api", "guide", "deep"]
        ),
        "language": language or "en",
    }

    base_prompt = WIKI_TASK_PROMPT_TEMPLATE.safe_substitute(**context)
    additional_note = GENERATION_TYPE_NOTES.get(generation_type, "")

    return base_prompt + additional_note
