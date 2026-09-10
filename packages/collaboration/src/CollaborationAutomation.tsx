// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { CollaborationApi } from './api'
import { collaborationTestIds } from './testIds'
import type {
  CollaborationAgent,
  CollaborationAutomationEventType,
  CollaborationAutomationInput,
  CollaborationAutomationRule,
  CollaborationAutomationRun,
  CollaborationEventSourceType,
  CollaborationIncomingHook,
  CollaborationProject,
} from './types'

interface CollaborationAutomationProps {
  api: CollaborationApi
  project: CollaborationProject
  agents: CollaborationAgent[]
  labels: {
    automation: string
    loading: string
    empty: string
    create: string
    name: string
    prompt: string
    trigger: string
    schedule: string
    event: string
    cron: string
    eventType: string
    agent: string
    subscription: string
    subscriptionHint: string
    manageSubscriptions: string
    subscriptionName: string
    subscriptionSource: string
    subscriptionResourceUrl: string
    emptySubscriptions: string
    edit: string
    enabled: string
    runNow: string
    runs: string
    delete: string
    cancel: string
    retry: string
  }
  onError(): void
}

const EVENT_TYPES: CollaborationAutomationEventType[] = [
  'task.created',
  'task.status_changed',
  'change_request.checks_failed',
  'change_request.merge_conflict',
  'change_request.review_submitted',
  'change_request.comment_created',
  'document.changed',
]

const ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'queued',
  'waiting_runtime',
  'waiting_device',
  'running',
])

function subscriptionFromRule(rule: CollaborationAutomationRule): string {
  const value = rule.eventConfig.subscription_id ?? rule.eventConfig.subscriptionId
  return typeof value === 'string' ? value : ''
}

export function CollaborationAutomation({
  api,
  project,
  agents,
  labels,
  onError,
}: CollaborationAutomationProps) {
  const [rules, setRules] = useState<CollaborationAutomationRule[]>([])
  const [hooks, setHooks] = useState<CollaborationIncomingHook[]>([])
  const [runs, setRuns] = useState<Record<string, CollaborationAutomationRun[]>>({})
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<CollaborationAutomationRule | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [triggerType, setTriggerType] = useState<'schedule' | 'event'>('schedule')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [eventType, setEventType] = useState<CollaborationAutomationEventType>('task.created')
  const [agentId, setAgentId] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('')
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false)
  const [subscriptionName, setSubscriptionName] = useState('')
  const [subscriptionSource, setSubscriptionSource] =
    useState<CollaborationEventSourceType>('github')
  const [subscriptionResourceUrl, setSubscriptionResourceUrl] = useState('')
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    let active = true
    setLoading(true)
    void Promise.all([api.listAutomations(project.id), api.listIncomingHooks(project.id)])
      .then(([nextRules, nextHooks]) => {
        if (!active) return
        setRules(nextRules)
        setHooks(nextHooks)
      })
      .catch(() => onErrorRef.current())
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, project.id])

  const resetEditor = () => {
    setEditorOpen(false)
    setEditingRule(null)
    setName('')
    setPrompt('')
    setTriggerType('schedule')
    setCronExpression('0 9 * * *')
    setEventType('task.created')
    setAgentId('')
    setSubscriptionId('')
    setSubscriptionsOpen(false)
  }

  const editRule = (rule: CollaborationAutomationRule) => {
    setEditingRule(rule)
    setEditorOpen(true)
    setName(rule.name)
    setPrompt(rule.prompt)
    setTriggerType(rule.triggerType === 'event' ? 'event' : 'schedule')
    setCronExpression(rule.cronExpression ?? '0 9 * * *')
    setEventType(rule.eventType ?? 'task.created')
    setAgentId(rule.agentId ?? '')
    setSubscriptionId(subscriptionFromRule(rule))
  }

  const externalEvent = triggerType === 'event' && !eventType.startsWith('task.')
  const editorValid =
    Boolean(name.trim() && prompt.trim() && agentId) &&
    (triggerType !== 'schedule' || Boolean(cronExpression.trim())) &&
    (!externalEvent || Boolean(subscriptionId))

  const saveRule = async (event: FormEvent) => {
    event.preventDefault()
    if (!editorValid) return
    const hook = hooks.find(item => item.id === subscriptionId)
    const input: CollaborationAutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      triggerType,
      eventType: triggerType === 'event' ? eventType : null,
      eventConfig:
        triggerType !== 'event'
          ? {}
          : eventType.startsWith('task.')
            ? { execution_target: 'existing_issue' }
            : {
                source_type: hook?.sourceType,
                subscription_id: subscriptionId,
                execution_target: 'create_issue',
                target_branches: [],
              },
      cronExpression: triggerType === 'schedule' ? cronExpression.trim() : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      enabled: editingRule?.enabled ?? true,
      assignmentMode: 'manual',
      managerType: null,
      agentId,
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
      roleSource: 'agent',
      runtimeSource: 'agent_default',
    }
    try {
      const saved = editingRule
        ? await api.updateAutomation(project.id, editingRule.id, {
            ...input,
            version: editingRule.version,
          })
        : await api.createAutomation(project.id, input)
      setRules(current =>
        editingRule
          ? current.map(item => (item.id === saved.id ? saved : item))
          : [saved, ...current]
      )
      resetEditor()
    } catch {
      onError()
    }
  }

  const createHook = async () => {
    if (!subscriptionName.trim() || !subscriptionResourceUrl.trim()) return
    try {
      const hook = await api.createIncomingHook(project.id, {
        name: subscriptionName.trim(),
        sourceType: subscriptionSource,
        collectionMode: 'webhook',
        resource: {
          url: subscriptionResourceUrl.trim(),
          displayName: subscriptionResourceUrl.trim(),
        },
      })
      setHooks(current => [...current, hook])
      setSubscriptionId(hook.id)
      setSubscriptionName('')
      setSubscriptionResourceUrl('')
    } catch {
      onError()
    }
  }

  return (
    <section className="collaboration-panel" data-testid={collaborationTestIds.automation}>
      <header>
        <h2>{labels.automation}</h2>
        <button
          type="button"
          data-testid={collaborationTestIds.automationCreate}
          onClick={() => {
            if (editorOpen) resetEditor()
            else setEditorOpen(true)
          }}
        >
          {labels.create}
        </button>
      </header>
      {editorOpen && (
        <form
          className="collaboration-automation-form"
          data-testid={collaborationTestIds.automationEditor}
          onSubmit={saveRule}
        >
          <label>
            {labels.name}
            <input
              data-testid={collaborationTestIds.automationName}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label>
            {labels.prompt}
            <textarea
              data-testid={collaborationTestIds.automationPrompt}
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
            />
          </label>
          <label>
            {labels.trigger}
            <select
              data-testid={collaborationTestIds.automationTrigger}
              value={triggerType}
              onChange={event => setTriggerType(event.target.value as 'schedule' | 'event')}
            >
              <option value="schedule">{labels.schedule}</option>
              <option value="event">{labels.event}</option>
            </select>
          </label>
          {triggerType === 'schedule' ? (
            <label>
              {labels.cron}
              <input
                data-testid="automation-cron-expression"
                value={cronExpression}
                onChange={event => setCronExpression(event.target.value)}
              />
            </label>
          ) : (
            <label>
              {labels.eventType}
              <select
                data-testid={collaborationTestIds.automationEventType}
                value={eventType}
                onChange={event =>
                  setEventType(event.target.value as CollaborationAutomationEventType)
                }
              >
                {EVENT_TYPES.map(type => (
                  <option value={type} key={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          )}
          {externalEvent && (
            <section
              className="collaboration-subscription-manager"
              data-testid={collaborationTestIds.incomingHookManager}
            >
              <label>
                {labels.subscription}
                <select
                  data-testid={collaborationTestIds.automationSubscription}
                  value={subscriptionId}
                  onChange={event => setSubscriptionId(event.target.value)}
                >
                  <option value="">{labels.emptySubscriptions}</option>
                  {hooks
                    .filter(hook => hook.status === 'active')
                    .map(hook => (
                      <option value={hook.id} key={hook.id}>
                        {hook.name}
                      </option>
                    ))}
                </select>
              </label>
              <small>{labels.subscriptionHint}</small>
              <button
                type="button"
                data-testid={collaborationTestIds.incomingHookAdd}
                onClick={() => setSubscriptionsOpen(open => !open)}
              >
                {labels.manageSubscriptions}
              </button>
              {subscriptionsOpen && (
                <div className="collaboration-subscription-editor">
                  <label>
                    {labels.subscriptionName}
                    <input
                      data-testid={collaborationTestIds.incomingHookName}
                      value={subscriptionName}
                      onChange={event => setSubscriptionName(event.target.value)}
                    />
                  </label>
                  <label>
                    {labels.subscriptionSource}
                    <select
                      data-testid="event-subscription-source"
                      value={subscriptionSource}
                      onChange={event =>
                        setSubscriptionSource(event.target.value as CollaborationEventSourceType)
                      }
                    >
                      <option value="github">GitHub</option>
                      <option value="gitlab">GitLab</option>
                    </select>
                  </label>
                  <label>
                    {labels.subscriptionResourceUrl}
                    <input
                      data-testid={collaborationTestIds.incomingHookResourceUrl}
                      value={subscriptionResourceUrl}
                      onChange={event => setSubscriptionResourceUrl(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    data-testid={collaborationTestIds.incomingHookSave}
                    disabled={!subscriptionName.trim() || !subscriptionResourceUrl.trim()}
                    onClick={createHook}
                  >
                    {labels.create}
                  </button>
                  {hooks.map(hook => (
                    <article key={hook.id} data-testid={`event-subscription-card-${hook.id}`}>
                      <span>{hook.name}</span>
                      <small>{hook.webhookUrl ?? hook.resource.url}</small>
                      <button
                        type="button"
                        data-testid={`event-subscription-delete-${hook.id}`}
                        onClick={async () => {
                          try {
                            await api.deleteIncomingHook(project.id, hook.id)
                            setHooks(current => current.filter(item => item.id !== hook.id))
                            if (subscriptionId === hook.id) setSubscriptionId('')
                          } catch {
                            onError()
                          }
                        }}
                      >
                        {labels.delete}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          <label>
            {labels.agent}
            <select
              data-testid="automation-agent"
              value={agentId}
              onChange={event => setAgentId(event.target.value)}
            >
              <option value="" />
              {agents.map(agent => (
                <option value={agent.agent_id ?? agent.id} key={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="collaboration-primary-button"
            data-testid={collaborationTestIds.automationSave}
            disabled={!editorValid}
          >
            {labels.create}
          </button>
        </form>
      )}
      {loading ? (
        <p>{labels.loading}</p>
      ) : rules.length === 0 ? (
        <p>{labels.empty}</p>
      ) : (
        <ul className="collaboration-automation-list">
          {rules.map(rule => (
            <li key={rule.id} data-testid={`automation-rule-${rule.id}`}>
              <header>
                <span>
                  <strong>{rule.name}</strong>
                  <small>
                    {rule.triggerType === 'schedule' ? rule.cronExpression : rule.eventType}
                  </small>
                </span>
                <label className="collaboration-checkbox">
                  <input
                    type="checkbox"
                    data-testid={`automation-enabled-${rule.id}`}
                    checked={rule.enabled}
                    onChange={async event => {
                      try {
                        const updated = await api.updateAutomation(project.id, rule.id, {
                          version: rule.version,
                          enabled: event.target.checked,
                        })
                        setRules(current =>
                          current.map(item => (item.id === updated.id ? updated : item))
                        )
                      } catch {
                        onError()
                      }
                    }}
                  />
                  {labels.enabled}
                </label>
              </header>
              <p>{rule.prompt}</p>
              <div className="collaboration-automation-actions">
                <button
                  type="button"
                  data-testid={`automation-edit-${rule.id}`}
                  onClick={() => editRule(rule)}
                >
                  {labels.edit}
                </button>
                <button
                  type="button"
                  data-testid={`automation-run-${rule.id}`}
                  onClick={async () => {
                    try {
                      const run = await api.runAutomation(project.id, rule.id)
                      setRuns(current => ({
                        ...current,
                        [rule.id]: [run, ...(current[rule.id] ?? [])],
                      }))
                    } catch {
                      onError()
                    }
                  }}
                >
                  {labels.runNow}
                </button>
                <button
                  type="button"
                  data-testid={`automation-runs-${rule.id}`}
                  onClick={async () => {
                    try {
                      const nextRuns = await api.listAutomationRuns(project.id, rule.id)
                      setRuns(current => ({ ...current, [rule.id]: nextRuns }))
                    } catch {
                      onError()
                    }
                  }}
                >
                  {labels.runs}
                </button>
                <button
                  type="button"
                  data-testid={`automation-delete-${rule.id}`}
                  onClick={async () => {
                    try {
                      await api.deleteAutomation(project.id, rule.id)
                      setRules(current => current.filter(item => item.id !== rule.id))
                    } catch {
                      onError()
                    }
                  }}
                >
                  {labels.delete}
                </button>
              </div>
              {(runs[rule.id] ?? []).map(run => (
                <div
                  className="collaboration-automation-run"
                  data-testid={`current-run-${run.id}`}
                  key={run.id}
                >
                  <span>{run.taskTitle || run.scheduledFor}</span>
                  <strong>{run.status}</strong>
                  {ACTIVE_RUN_STATUSES.has(run.status) && (
                    <button
                      type="button"
                      data-testid={`automation-run-cancel-${run.id}`}
                      onClick={async () => {
                        try {
                          const updated = await api.cancelAutomationRun(project.id, run.id)
                          setRuns(current => ({
                            ...current,
                            [rule.id]: current[rule.id].map(item =>
                              item.id === updated.id ? updated : item
                            ),
                          }))
                        } catch {
                          onError()
                        }
                      }}
                    >
                      {labels.cancel}
                    </button>
                  )}
                  {run.retryable && (
                    <button
                      type="button"
                      data-testid={`automation-run-retry-${run.id}`}
                      onClick={async () => {
                        try {
                          const updated = await api.retryAutomationRun(project.id, run.id)
                          setRuns(current => ({
                            ...current,
                            [rule.id]: [updated, ...current[rule.id]],
                          }))
                        } catch {
                          onError()
                        }
                      }}
                    >
                      {labels.retry}
                    </button>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
