# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_engine.splitter import (
    SentenceSplitterConfig,
    SmartSplitterConfig,
    parse_splitter_config,
)


def test_parse_splitter_config_supports_smart_type() -> None:
    splitter = parse_splitter_config({"type": "smart"})

    assert isinstance(splitter, SmartSplitterConfig)
    assert splitter.type == "smart"


def test_parse_splitter_config_defaults_to_sentence_type() -> None:
    splitter = parse_splitter_config({})

    assert isinstance(splitter, SentenceSplitterConfig)
    assert splitter.type == "sentence"
