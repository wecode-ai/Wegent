import type { SharedWorkspaceApi, WorkspaceAutomationRule } from '@wegent/collaboration'
import type { createLocalProjectAutomationApi } from '@/api/local/localProjectAutomations'

export function createLocalAutomationConfiguration(ports: {
  read(ownerId: string): Promise<{ rules: WorkspaceAutomationRule[]; version: number }>
  save(ownerId: string, rules: WorkspaceAutomationRule[], version: number): Promise<number>
  targetName(
    ownerId: string,
    kind: WorkspaceAutomationRule['targetKind'],
    id: string
  ): Promise<string>
  runtime?: ReturnType<typeof createLocalProjectAutomationApi>
  locale: 'zh-CN' | 'en'
}): NonNullable<SharedWorkspaceApi['automations']> {
  return {
    list: async id => (await ports.read(id)).rules,
    async create(projectId, input) {
      const now = new Date().toISOString()
      const rule: WorkspaceAutomationRule = {
        ...input,
        id: crypto.randomUUID(),
        projectId,
        name: String(input.name ?? ''),
        enabled: input.enabled !== false,
        targetName: await ports.targetName(projectId, input.targetKind, input.targetId),
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const { rules, version } = await ports.read(projectId)
      await ports.save(projectId, [...rules, rule], version)
      return rule
    },
    migrateWorkflow: () => Promise.reject(new Error('Workflow migration is unavailable')),
    async update(projectId, automationId, input) {
      const { rules, version } = await ports.read(projectId)
      const current = rules.find(rule => rule.id === automationId)
      if (!current) {
        throw new Error(
          ports.locale === 'zh-CN'
            ? '未找到自动处理规则'
            : 'Automatic processing rule was not found'
        )
      }
      if (current.version !== input.version) {
        throw new Error(
          ports.locale === 'zh-CN'
            ? '自动处理规则已被更新，请刷新后重试'
            : 'The automatic processing rule changed. Refresh and try again.'
        )
      }
      const updated: WorkspaceAutomationRule = {
        ...current,
        ...input,
        id: current.id,
        projectId,
        name: String(input.name ?? current.name),
        enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      await ports.save(
        projectId,
        rules.map(rule => (rule.id === automationId ? updated : rule)),
        version
      )
      return updated
    },
    async remove(projectId, automationId) {
      const { rules, version } = await ports.read(projectId)
      const nextRules = rules.filter(rule => rule.id !== automationId)
      if (nextRules.length === rules.length) {
        throw new Error(
          ports.locale === 'zh-CN'
            ? '未找到自动处理规则'
            : 'Automatic processing rule was not found'
        )
      }
      const projectVersion = await ports.save(projectId, nextRules, version)
      return { projectVersion, workflowAutomationId: null }
    },
    async runNow(projectId, automationId) {
      if (!ports.runtime)
        return Promise.reject(new Error('Local automation runtime is unavailable'))
      const runs = await ports.runtime.run(projectId, automationId)
      if (!runs.length)
        throw new Error(
          ports.locale === 'zh-CN' ? '没有可处理的事项' : 'No open threads to process'
        )
      return runs[0]
    },
    listRuns: (projectId, automationId) =>
      ports.runtime?.listRuns(projectId, automationId) ??
      Promise.reject(new Error('Local automation runtime is unavailable')),
    cancelRun: (projectId, runId) =>
      ports.runtime?.cancelRun(projectId, runId) ??
      Promise.reject(new Error('Local automation runtime is unavailable')),
    retryRun: (projectId, runId) =>
      ports.runtime?.retryRun(projectId, runId) ??
      Promise.reject(new Error('Local automation runtime is unavailable')),
  }
}
