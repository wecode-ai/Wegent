# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.prompt_draft.generation import safe_model_config_for_logging
from app.services.prompt_draft.validation import looks_like_meta_title


def test_safe_model_config_for_logging_masks_secrets():
    rendered = safe_model_config_for_logging(
        {
            "model_id": "gpt-test",
            "api_key": "sk-secret",
            "default_headers": {"Authorization": "Bearer secret-token"},
        }
    )

    assert "sk-secret" not in rendered
    assert "secret-token" not in rendered
    assert '"model_id": "gpt-test"' in rendered


def test_looks_like_meta_title_detects_repeated_meta_output():
    assert looks_like_meta_title("会话提炼协作规则生成提示词会话提炼协")
    assert not looks_like_meta_title("流程图协作提示词")
