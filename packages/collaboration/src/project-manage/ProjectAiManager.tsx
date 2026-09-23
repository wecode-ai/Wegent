// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react'
import type {
  SharedWorkspaceApi,
  WorkspaceProjectManagerConfig,
  WorkspaceProjectManagerRun,
  WorkspaceProjectManagerTrigger,
} from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationProject } from '../types'
import { ProjectSettingsPage } from './ProjectSettingsPage'

const copy = {
  'zh-CN': {
    title: '项目 AI 管理者',
    description:
      '一个项目 AI 管理整个项目的 Issue。Issue 负责人负责执行与交付；需要更换负责人或改动进行中的 Issue 时，由人确认。',
    enabled: '启用项目 AI',
    agent: '管理者智能体',
    instructions: '管理指令',
    triggers: '触发条件',
    addTrigger: '添加触发条件',
    event: '事件',
    schedule: '定时',
    tag: 'Tag（可选，逗号分隔）',
    cron: 'Cron 表达式',
    timezone: '时区',
    save: '保存设置',
    saving: '保存中…',
    conversation: '向项目 AI 提问或下达指令',
    conversationHint: '项目成员可以查询；Owner 和 Maintainer 可以要求 AI 修改 Issue。',
    send: '发送',
    history: '运行记录',
    noRuns: '暂无运行记录',
    approve: '同意',
    reject: '拒绝',
    pending: '待确认',
    created: 'Issue 创建',
    tagAdded: '添加 Tag',
    statusChanged: 'Issue 状态变化',
    conflict: '同一事件不能同时触发项目 AI 与自动处理，请调整触发条件。',
  },
  en: {
    title: 'Project AI manager',
    description:
      'One AI coordinates project Issues. Assignees own execution and delivery; changing an owner or an active Issue needs human confirmation.',
    enabled: 'Enable project AI',
    agent: 'Manager Agent',
    instructions: 'Instructions',
    triggers: 'Triggers',
    addTrigger: 'Add trigger',
    event: 'Event',
    schedule: 'Schedule',
    tag: 'Tags (optional, comma separated)',
    cron: 'Cron expression',
    timezone: 'Timezone',
    save: 'Save settings',
    saving: 'Saving…',
    conversation: 'Ask or instruct project AI',
    conversationHint: 'Members can query. Owners and Maintainers can request Issue changes.',
    send: 'Send',
    history: 'Run history',
    noRuns: 'No runs yet',
    approve: 'Approve',
    reject: 'Reject',
    pending: 'Pending confirmation',
    created: 'Issue created',
    tagAdded: 'Tag added',
    statusChanged: 'Issue status changed',
    conflict:
      'A single event cannot trigger both project AI and automatic processing. Adjust the triggers.',
  },
}

const eventOptions = [
  ['task.created', 'created'],
  ['task.tag_added', 'tagAdded'],
  ['task.status_changed', 'statusChanged'],
] as const

export function ProjectAiManager({
  api,
  project,
  agents,
  locale,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  agents: CollaborationAgent[]
  locale: 'zh-CN' | 'en'
}) {
  const manager = api.projectManager
  const labels = copy[locale]
  const canManage = project.access_role === 'Owner' || project.access_role === 'Maintainer'
  const [config, setConfig] = useState<WorkspaceProjectManagerConfig | null>(null)
  const [runs, setRuns] = useState<WorkspaceProjectManagerRun[]>([])
  const [selectedRun, setSelectedRun] = useState<WorkspaceProjectManagerRun | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!manager) return
    const nextRuns = await manager.listRuns(project.id)
    setRuns(nextRuns)
    if (selectedRun) {
      const detail = await manager.getRun(project.id, selectedRun.id)
      setSelectedRun(detail)
    }
  }, [manager, project.id, selectedRun?.id])

  useEffect(() => {
    if (manager) {
      void manager
        .get(project.id)
        .then(setConfig)
        .catch(cause => setError(String(cause)))
    }
  }, [manager, project.id])

  useEffect(() => {
    void refresh().catch(cause => setError(String(cause)))
    const timer = window.setInterval(() => {
      void refresh().catch(cause => setError(String(cause)))
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const patch = (values: Partial<WorkspaceProjectManagerConfig>) => {
    setConfig(previous => (previous ? { ...previous, ...values } : previous))
  }
  const patchTrigger = (id: string, values: Partial<WorkspaceProjectManagerTrigger>) => {
    patch({
      triggers: (config?.triggers ?? []).map(trigger =>
        trigger.id === id ? { ...trigger, ...values } : trigger
      ),
    })
  }
  const execute = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      await refresh()
    } catch (cause) {
      setError(String(cause).includes('409') ? labels.conflict : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!manager) return null
  return (
    <ProjectSettingsPage
      testId="project-ai-settings"
      title={labels.title}
      description={labels.description}
    >
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-border px-3 py-2 text-text-primary"
          data-testid="project-ai-error"
        >
          {error}
        </p>
      )}
      {config && (
        <div className="space-y-5">
          <label className="flex items-center gap-3 text-text-primary">
            <input
              type="checkbox"
              data-testid="project-ai-enabled"
              checked={config.enabled}
              disabled={!canManage || busy}
              onChange={event => patch({ enabled: event.target.checked })}
            />
            {labels.enabled}
          </label>
          <label className="block space-y-2 text-text-primary">
            <span>{labels.agent}</span>
            <select
              data-testid="project-ai-agent"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2"
              value={config.agentId}
              disabled={!canManage || busy}
              onChange={event => patch({ agentId: event.target.value })}
            >
              <option value="">—</option>
              {agents
                .filter(
                  agent =>
                    agent.status !== 'archived' &&
                    (project.project_store === 'local' || agent.runtime === 'wegent')
                )
                .map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block space-y-2 text-text-primary">
            <span>{labels.instructions}</span>
            <textarea
              data-testid="project-ai-instructions"
              className="min-h-28 w-full rounded-lg border border-border bg-surface px-3 py-2"
              value={config.prompt}
              disabled={!canManage || busy}
              onChange={event => patch({ prompt: event.target.value })}
            />
          </label>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="heading-sm">{labels.triggers}</h2>
              <button
                type="button"
                data-testid="project-ai-add-trigger"
                disabled={!canManage || busy}
                onClick={() =>
                  patch({
                    triggers: [
                      ...config.triggers,
                      {
                        id: crypto.randomUUID(),
                        kind: 'event',
                        eventType: 'task.created',
                        tags: [],
                        timezone: 'Asia/Shanghai',
                        enabled: true,
                      },
                    ],
                  })
                }
              >
                {labels.addTrigger}
              </button>
            </div>
            {config.triggers.map(trigger => (
              <div
                key={trigger.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                data-testid={`project-ai-trigger-${trigger.id}`}
              >
                <input
                  type="checkbox"
                  data-testid={`project-ai-trigger-enabled-${trigger.id}`}
                  aria-label={labels.enabled}
                  checked={trigger.enabled}
                  disabled={!canManage || busy}
                  onChange={event => patchTrigger(trigger.id, { enabled: event.target.checked })}
                />
                <select
                  data-testid={`project-ai-trigger-kind-${trigger.id}`}
                  aria-label={labels.triggers}
                  value={trigger.kind}
                  disabled={!canManage || busy}
                  onChange={event =>
                    patchTrigger(trigger.id, {
                      kind: event.target.value as 'event' | 'schedule',
                      eventType: event.target.value === 'event' ? 'task.created' : null,
                      cronExpression: event.target.value === 'schedule' ? '0 9 * * *' : null,
                    })
                  }
                >
                  <option value="event">{labels.event}</option>
                  <option value="schedule">{labels.schedule}</option>
                </select>
                {trigger.kind === 'event' ? (
                  <>
                    <select
                      data-testid={`project-ai-trigger-event-${trigger.id}`}
                      aria-label={labels.event}
                      value={trigger.eventType ?? 'task.created'}
                      disabled={!canManage || busy}
                      onChange={event =>
                        patchTrigger(trigger.id, {
                          eventType: event.target
                            .value as WorkspaceProjectManagerTrigger['eventType'],
                        })
                      }
                    >
                      {eventOptions.map(([value, key]) => (
                        <option key={value} value={value}>
                          {labels[key]}
                        </option>
                      ))}
                    </select>
                    <input
                      data-testid={`project-ai-trigger-tags-${trigger.id}`}
                      aria-label={labels.tag}
                      placeholder={labels.tag}
                      value={trigger.tags.join(', ')}
                      disabled={!canManage || busy}
                      onChange={event =>
                        patchTrigger(trigger.id, {
                          tags: event.target.value
                            .split(',')
                            .map(tag => tag.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </>
                ) : (
                  <>
                    <input
                      data-testid={`project-ai-trigger-cron-${trigger.id}`}
                      aria-label={labels.cron}
                      placeholder={labels.cron}
                      value={trigger.cronExpression ?? ''}
                      disabled={!canManage || busy}
                      onChange={event =>
                        patchTrigger(trigger.id, {
                          cronExpression: event.target.value,
                        })
                      }
                    />
                    <input
                      data-testid={`project-ai-trigger-timezone-${trigger.id}`}
                      aria-label={labels.timezone}
                      value={trigger.timezone}
                      disabled={!canManage || busy}
                      onChange={event =>
                        patchTrigger(trigger.id, {
                          timezone: event.target.value,
                        })
                      }
                    />
                  </>
                )}
                {canManage && (
                  <button
                    type="button"
                    data-testid={`project-ai-trigger-remove-${trigger.id}`}
                    aria-label="Remove trigger"
                    onClick={() =>
                      patch({
                        triggers: config.triggers.filter(item => item.id !== trigger.id),
                      })
                    }
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </section>
          {canManage && (
            <button
              type="button"
              data-testid="project-ai-save"
              disabled={busy}
              className="rounded-lg bg-text-primary px-4 py-2 text-surface"
              onClick={() =>
                void execute(async () => {
                  const saved = await manager.save(project.id, {
                    version: config.version,
                    enabled: config.enabled,
                    agentId: config.agentId,
                    prompt: config.prompt,
                    triggers: config.triggers,
                  })
                  setConfig(saved)
                })
              }
            >
              {busy ? labels.saving : labels.save}
            </button>
          )}
        </div>
      )}
      <section className="mt-9 space-y-3 border-t border-border pt-6">
        <h2 className="heading-sm">{labels.conversation}</h2>
        <p className="text-text-secondary">{labels.conversationHint}</p>
        <textarea
          data-testid="project-ai-message"
          className="min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2"
          value={message}
          onChange={event => setMessage(event.target.value)}
        />
        <button
          type="button"
          data-testid="project-ai-send"
          disabled={busy || !config?.enabled || !message.trim()}
          className="rounded-lg bg-text-primary px-4 py-2 text-surface"
          onClick={() =>
            void execute(async () => {
              const run = await manager.run(project.id, message.trim())
              setSelectedRun(run)
              setMessage('')
            })
          }
        >
          {labels.send}
        </button>
      </section>
      <section className="mt-9 space-y-3 border-t border-border pt-6">
        <h2 className="heading-sm">{labels.history}</h2>
        {runs.length === 0 && <p className="text-text-secondary">{labels.noRuns}</p>}
        {runs.map(run => (
          <button
            type="button"
            key={run.id}
            data-testid={`project-ai-run-${run.id}`}
            className="block w-full rounded-lg border border-border px-3 py-2 text-left"
            onClick={() =>
              void manager
                .getRun(project.id, run.id)
                .then(setSelectedRun)
                .catch(cause => setError(String(cause)))
            }
          >
            {run.trigger} · {run.status} · {run.createdAt}
          </button>
        ))}
        {selectedRun && (
          <div
            data-testid="project-ai-run-detail"
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <p>
              {selectedRun.status} · {selectedRun.error ?? ''}
            </p>
            {selectedRun.actions?.map(action => (
              <div key={action.id} className="rounded border border-border p-3">
                <p>
                  {action.kind} · {action.itemId} · {action.status}
                </p>
                {action.status === 'pending_confirmation' &&
                  (action.approverUserId != null
                    ? action.approverUserId === project.current_user_id
                    : canManage) && (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        data-testid={`project-ai-approve-${action.id}`}
                        disabled={busy}
                        onClick={() =>
                          void execute(() =>
                            manager.decide(
                              project.id,
                              selectedRun.id,
                              action.id,
                              true,
                              action.itemVersion ?? 0
                            )
                          )
                        }
                      >
                        {labels.approve}
                      </button>
                      <button
                        type="button"
                        data-testid={`project-ai-reject-${action.id}`}
                        disabled={busy}
                        onClick={() =>
                          void execute(() =>
                            manager.decide(
                              project.id,
                              selectedRun.id,
                              action.id,
                              false,
                              action.itemVersion ?? 0
                            )
                          )
                        }
                      >
                        {labels.reject}
                      </button>
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </section>
    </ProjectSettingsPage>
  )
}
