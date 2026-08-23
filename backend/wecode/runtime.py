# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Initialize internal runtime adapters used by API and worker processes."""

from pathlib import Path

_initialized = False


def initialize_internal_runtime() -> None:
    """Register internal adapters once in the current process."""
    global _initialized
    if _initialized:
        return

    from app.core.yaml_init import register_additional_init_data_directory

    register_additional_init_data_directory(Path(__file__).parent / "init_data")

    import wecode.service.qia_minute_video  # noqa: F401
    import wecode.service.video_generation_extension  # noqa: F401
    import wecode.service.video_image_staging  # noqa: F401

    _initialized = True
