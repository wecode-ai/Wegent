# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build and extend the public generation context passed to Skills."""

from typing import Any, Callable, Optional

GENERATION_PARAMETER_KEYS = (
    "resolution",
    "ratio",
    "duration",
    "generation_mode_id",
    "size",
)

SkillGenerationContextEnricher = Callable[
    [
        Optional[dict[str, Any]],
        list[Any],
        list[Any],
        int,
        int,
    ],
    Optional[dict[str, Any]],
]
SkillGenerationInjector = Callable[
    [
        list[dict[str, Any]],
        int,
        Optional[dict[str, Any]],
        Optional[str],
    ],
    None,
]

_context_enrichers: list[SkillGenerationContextEnricher] = []
_skill_injectors: list[SkillGenerationInjector] = []


def register_skill_generation_context_enricher(
    enricher: SkillGenerationContextEnricher,
) -> None:
    """Register a request-scoped generation context enricher."""
    _context_enrichers.append(enricher)


def has_skill_generation_context_enrichers() -> bool:
    """Return whether any generation context enricher is registered."""
    return bool(_context_enrichers)


def enrich_skill_generation_context(
    *,
    generation: Optional[dict[str, Any]],
    current_attachments: list[Any],
    task_attachments: list[Any],
    current_subtask_id: int,
    user_id: int,
) -> Optional[dict[str, Any]]:
    """Apply registered generation context enrichers in registration order."""
    enriched = generation
    for enricher in _context_enrichers:
        enriched = enricher(
            enriched,
            current_attachments,
            task_attachments,
            current_subtask_id,
            user_id,
        )
    return enriched


def register_skill_generation_injector(
    injector: SkillGenerationInjector,
) -> None:
    """Register a Skill configuration injector."""
    _skill_injectors.append(injector)


def apply_skill_generation_to_skills(
    *,
    resolved_skills: list[dict[str, Any]],
    team_user_id: int,
    generation: Optional[dict[str, Any]],
    prompt: Optional[str],
) -> None:
    """Apply registered generation settings to resolved Skills."""
    for injector in _skill_injectors:
        injector(
            resolved_skills=resolved_skills,
            team_user_id=team_user_id,
            generation=generation,
            prompt=prompt,
        )


def build_skill_generation_context(
    generation: dict[str, Any],
) -> dict[str, Any]:
    """Convert request generation settings to the public Skill protocol."""
    model_name = str(generation.get("model") or "").strip()
    model_display_name = str(generation.get("model_display_name") or model_name).strip()
    content = [
        dict(item)
        for item in generation.get("content") or []
        if isinstance(item, dict) and item.get("type") != "generate_params"
    ]
    generate_params = {
        key: generation[key]
        for key in GENERATION_PARAMETER_KEYS
        if generation.get(key) is not None
    }
    if generate_params:
        content.append({"type": "generate_params", "value": generate_params})

    result: dict[str, Any] = {"content": content}
    if model_name:
        result["modelName"] = model_name
        result["modelDisplayName"] = model_display_name or model_name
    return result
