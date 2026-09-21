# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Initialize internal runtime adapters used by API and worker processes."""

_initialized = False


def initialize_internal_runtime() -> None:
    """Register internal adapters once in the current process."""
    global _initialized
    if _initialized:
        return

    import wecode.service.qia_async_card_adapter  # noqa: F401
    import wecode.video.api.clarification  # noqa: F401
    import wecode.video.api.multi_style  # noqa: F401
    import wecode.video.api.skill_context  # noqa: F401
    import wecode.video.services.generation_extension  # noqa: F401
    import wecode.video.services.image_staging  # noqa: F401

    _initialized = True
