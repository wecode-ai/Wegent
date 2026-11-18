// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'

export function workflowErrorMessage(
  cause: unknown,
  translate: CollaborationTranslate,
  stageLabel?: (id: string) => string
): string {
  const source = cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : {}
  const detail =
    source.detail && typeof source.detail === 'object' && !Array.isArray(source.detail)
      ? (source.detail as Record<string, unknown>)
      : {}
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : typeof source.message === 'string'
        ? source.message
        : translate('saveFailed', '保存失败，请重试')
  const parts = [message]
  if (typeof detail.current_stage_id === 'string' && stageLabel) {
    parts.push(
      `${translate('todo.workflow_current_stage', '当前阶段')}：${stageLabel(detail.current_stage_id)}`
    )
  }
  for (const [key, label] of [
    ['missing_deliverables', translate('todo.workflow_missing_deliverables', '缺少交付物')],
    ['missing_dependencies', translate('todo.workflow_dependencies', '前置阶段')],
    ['missing_conditions', translate('todo.strategy_missing', '阻塞与缺失条件')],
    ['permission_reasons', translate('todo.strategy_permission_reason', '权限要求')],
  ]) {
    const values = detail[key]
    if (!Array.isArray(values) || values.length === 0) continue
    const names = values.flatMap(value => {
      if (typeof value === 'string')
        return key === 'missing_dependencies' ? (stageLabel ? [stageLabel(value)] : []) : [value]
      if (!value || typeof value !== 'object') return []
      const entry = value as Record<string, unknown>
      return typeof entry.name === 'string' ? [entry.name] : []
    })
    if (names.length) parts.push(`${label}：${names.join(', ')}`)
  }
  return parts.join(' · ')
}
