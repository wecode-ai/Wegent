type Translate = (key: string, fallback: string) => string

/** Describe the actual predicate, rather than a separate model-authored promise. */
export function connectionEventCondition(match: unknown, t: Translate): string {
  if (!match || typeof match !== 'object' || Array.isArray(match))
    return t('workbench.event_condition_unknown', '未提供等待条件')
  const labels: Record<string, string> = {
    statusCheckRollup: t('workbench.event_condition_checks', '检查结果'),
    headRefOid: t('workbench.event_condition_commit', '提交'),
    head_sha: t('workbench.event_condition_commit', '提交'),
    headSha: t('workbench.event_condition_commit', '提交'),
    topicId: t('workbench.event_condition_resource', '目标'),
    eventType: t('workbench.event_condition_event', '事件'),
    status: t('workbench.event_condition_status', '状态'),
    state: t('workbench.event_condition_status', '状态'),
    id: t('workbench.event_condition_id', '编号'),
    run_attempt: t('workbench.event_condition_attempt', '运行次数'),
    conclusion: t('workbench.event_condition_result', '结果'),
  }
  const values: Record<string, string> = {
    SUCCESS: t('workbench.event_condition_success', '通过'),
    FAILURE: t('workbench.event_condition_failure', '失败'),
    success: t('workbench.event_condition_success', '通过'),
    failure: t('workbench.event_condition_failure', '失败'),
    completed: t('workbench.event_condition_completed', '已完成'),
    cancelled: t('workbench.event_condition_cancelled', '已取消'),
    'tracked.status': t('workbench.event_condition_change', '资源状态变化'),
    'tracked.workflow_run': t('workbench.event_condition_workflow', '工作流状态变化'),
  }
  const describe = (fields: Record<string, unknown>): string =>
    Object.entries(fields)
      .filter(([key]) => key.startsWith('/'))
      .map(([pointer, value]) => {
        const parts = pointer
          .split('/')
          .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
        const name = pointer.includes('/statusCheckRollup/')
          ? labels.statusCheckRollup
          : (labels[parts.at(-1) ?? ''] ?? parts.at(-1))
        const text =
          typeof value === 'string'
            ? ['state', 'status', 'conclusion', 'eventType'].includes(parts.at(-1) ?? '')
              ? (values[value] ?? value)
              : value
            : JSON.stringify(value)
        return `${name}: ${text}`
      })
      .join(t('workbench.event_condition_and', ' 且 '))
  const fields = match as Record<string, unknown>
  const alternatives = Array.isArray(fields.$any)
    ? fields.$any.filter(
        (branch): branch is Record<string, unknown> =>
          Boolean(branch) && typeof branch === 'object' && !Array.isArray(branch)
      )
    : []
  const any = alternatives
    .map(branch => {
      const text = describe(branch)
      return Object.keys(branch).length > 1 ? `(${text})` : text
    })
    .filter(Boolean)
    .join(t('workbench.event_condition_or', ' 或 '))
  const common = describe(fields)
  return (
    [any && `(${any})`, common].filter(Boolean).join(t('workbench.event_condition_and', ' 且 ')) ||
    t('workbench.event_condition_any', '来源中的任意新事件')
  )
}
