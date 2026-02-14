#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

# Avoid circular import by not importing task_processor at module level
# Import TaskReader which doesn't have circular dependencies
from .reader import TaskReader

__all__ = [
    "TaskReader",
    "read_task_data",
    "execute_task",
    "process",
    "process_async",
    "run_task",
    "run_task_async",
]


# Lazy imports to avoid circular dependencies
def __getattr__(name):
    if name in [
        "read_task_data",
        "execute_task",
        "process",
        "process_async",
        "run_task",
        "run_task_async",
    ]:
        from .task_processor import (
            execute_task,
            process,
            process_async,
            read_task_data,
            run_task,
            run_task_async,
        )

        return locals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
