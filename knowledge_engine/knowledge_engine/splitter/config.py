# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator


class SemanticSplitterConfig(BaseModel):
    type: Literal["semantic"] = "semantic"
    buffer_size: int = Field(1, ge=1, le=10)
    breakpoint_percentile_threshold: int = Field(95, ge=50, le=100)


class SentenceSplitterConfig(BaseModel):
    type: Literal["sentence"] = "sentence"
    chunk_size: int = Field(1024, ge=128, le=8192)
    chunk_overlap: int = Field(200, ge=0, le=2048)
    separator: str = "\n\n"

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info) -> int:
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class SmartSplitterConfig(BaseModel):
    type: Literal["smart"] = "smart"
    chunk_size: int = Field(1024, ge=128, le=8192)
    chunk_overlap: int = Field(50, ge=0, le=2048)
    file_extension: Optional[str] = None
    subtype: Optional[str] = None

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info) -> int:
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


SplitterConfig = Union[
    SemanticSplitterConfig, SentenceSplitterConfig, SmartSplitterConfig
]


def parse_splitter_config(
    config: dict | SplitterConfig | None,
) -> SplitterConfig | None:
    if config is None:
        return None

    if isinstance(
        config,
        (SemanticSplitterConfig, SentenceSplitterConfig, SmartSplitterConfig),
    ):
        return config

    splitter_type = config.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config)
    if splitter_type == "smart":
        return SmartSplitterConfig(**config)
    return SentenceSplitterConfig(**config)
