# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

from app.schemas.task import TaskDetail


class ManagedTaskForkTarget(BaseModel):
    """Use the managed backend executor route for the forked task."""

    type: Literal["managed"]


class DeviceTaskForkTarget(BaseModel):
    """Use a concrete local device for the forked task."""

    type: Literal["device"]
    device_id: str = Field(..., min_length=1)


TaskForkTarget = Annotated[
    Union[ManagedTaskForkTarget, DeviceTaskForkTarget],
    Field(discriminator="type"),
]


class TaskForkRequest(BaseModel):
    """Request to create a task fork with a selected execution target."""

    target: TaskForkTarget


class TaskForkResponse(BaseModel):
    """Response returned after creating a task fork."""

    task_id: int
    task: TaskDetail
