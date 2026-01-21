# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import re


def generate_executor_name(task_id, subtask_id, user_name):
    user_name = _sanitize_k8s_name(user_name)
    digest = hashlib.sha1(f"{user_name}-{task_id}-{subtask_id}".encode()).hexdigest()[
        :15
    ]
    return f"wegent-task-{user_name}-{digest}"


def _sanitize_k8s_name(user_name):
    sanitized_name = user_name.replace(" ", "-").replace("_", "--")
    sanitized_name = re.sub(r"[^a-z0-9-.]", "", sanitized_name.lower())
    if not sanitized_name or not sanitized_name[0].isalnum():
        sanitized_name = "a" + sanitized_name
    if not sanitized_name[-1].isalnum():
        sanitized_name = sanitized_name + "z"
    sanitized_name = sanitized_name[:10]
    return sanitized_name
