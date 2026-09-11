# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared schema scalar types."""

from typing import Annotated

from pydantic import BeforeValidator

SnowflakeId = Annotated[str, BeforeValidator(str)]
