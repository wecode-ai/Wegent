export function executionStatusLabel(
  state: string,
  translate: (key: string, fallback?: string) => string,
): string {
  const labels: Record<string, string> = {
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown: '状态待同步',
    waiting_approval: '等待审批',
    waiting_runtime: '等待设备或模型配置',
    waiting_device: '等待执行设备',
    queued: '排队中',
    cancelling: '取消中',
    starting: '启动中',
    running: '执行中',
  }
  return labels[state]
    ? translate(`todo.execution_${state}`, labels[state])
    : state
}
