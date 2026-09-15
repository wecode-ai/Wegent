// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WorkflowCoordinatorConfiguration {
  advancement_policy?: 'manual' | 'ai'
  orchestration_status?: string
  execution_config?: {
    agent_id?: string | null
    execution_device_id?: string | null
    model?: string | null
    workspace_binding?: unknown
  } | null
}

export function coordinatorConfigurationMissing(
  workflow?: WorkflowCoordinatorConfiguration | null,
): boolean {
  const config = workflow?.execution_config
  if (workflow?.advancement_policy !== 'ai' || !config) return false
  if (
    workflow.orchestration_status &&
    !['idle', 'failed'].includes(workflow.orchestration_status)
  )
    return false
  return !(
    (config.agent_id || config.execution_device_id) &&
    config.model &&
    config.workspace_binding
  )
}
