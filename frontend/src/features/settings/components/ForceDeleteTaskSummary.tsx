// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { RunningTaskInfo } from '@/apis/common'

interface ForceDeleteTaskSummaryProps {
  runningTasks: RunningTaskInfo[]
  runningTasksTitle: string
  warning: string
  andMoreLabel?: string
}

export function ForceDeleteTaskSummary({
  runningTasks,
  runningTasksTitle,
  warning,
  andMoreLabel,
}: ForceDeleteTaskSummaryProps) {
  return (
    <div className="space-y-3">
      {runningTasks.length > 0 && (
        <div className="bg-muted p-3 rounded-md">
          <p className="font-medium text-sm mb-2">{runningTasksTitle}</p>
          <ul className="text-sm space-y-1">
            {runningTasks.slice(0, 5).map(task => (
              <li key={task.task_id} className="text-text-muted">
                • {task.task_title || task.task_name} ({task.status})
              </li>
            ))}
            {runningTasks.length > 5 && andMoreLabel ? (
              <li className="text-text-muted">{andMoreLabel}</li>
            ) : null}
          </ul>
        </div>
      )}
      <p className="text-error text-sm">{warning}</p>
    </div>
  )
}
