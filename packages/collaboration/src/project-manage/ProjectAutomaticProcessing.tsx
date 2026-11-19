// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Pencil, Plus, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'

import { collaborationMessages, type CollaborationTranslate } from '../i18n'
import { projectStatuses } from '../board'
import { Textarea } from '../controls/Textarea'
import { requestFailureMessage } from '../controls/requestFailure'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'
import { DialogForm } from '../controls/DialogForm'
import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationInput,
  WorkspaceAutomationRule,
} from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationMember, CollaborationProject } from '../types'
import { useAutomaticProcessingRules } from './useAutomaticProcessingRules'
import { ProjectSettingsPage } from './ProjectSettingsPage'
import {
  useProjectSettingsRefresh,
  ProjectSettingsRefreshFeedback,
} from './useProjectSettingsRefresh'
import { AutomaticProcessingTargetPicker } from './AutomaticProcessingTargetPicker'
import { AutomaticProcessingDialogFooter } from './AutomaticProcessingDialogFooter'
import { AutomaticProcessingTriggerFields } from './AutomaticProcessingTriggerFields'
import {
  EMPTY_DRAFT,
  automaticProcessingSaveError,
  draftFromRule,
  eventLabel,
  eventTypesForHook,
  scheduleLabel,
  type AutomaticProcessingDraft,
  type TargetKind,
  type TriggerKind,
} from './automaticProcessing'

function AutomaticProcessingSwitch({
  checked,
  disabled,
  label,
  onChange,
  testId,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange(checked: boolean): void
  testId: string
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="inline-flex h-11 w-11 items-center justify-center shrink-0 rounded-full md:h-8 md:w-9 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={`relative inline-flex h-5 w-8 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-500' : 'bg-text-muted/30'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full border border-white bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[14px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}

export function ProjectAutomaticProcessing({
  api,
  project,
  agents,
  locale,
  translate,
  onProjectChange,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  locale: 'zh-CN' | 'en'
  translate: CollaborationTranslate
  onProjectChange?(project: CollaborationProject): void
}) {
  const {
    rules,
    loading,
    error: rulesError,
    load,
  } = useAutomaticProcessingRules(api.automations, project.id)
  const projectId = project.id
  const optionsResource = useMemo(
    () =>
      createAsyncResource('automatic-processing-options', async () => {
        const [groups, agents, members] = await Promise.all([
          api.projects.listCollaborationGroups?.(projectId) ?? [],
          api.agents.list(projectId),
          api.members.list(projectId),
        ])
        return { groups, agents, members }
      }),
    [api, projectId]
  )
  const optionsSnapshot = useSyncExternalStore(
    optionsResource.subscribe,
    optionsResource.getSnapshot,
    optionsResource.getSnapshot
  )
  const optionsLoading = optionsSnapshot.status === 'idle' || optionsSnapshot.status === 'loading'
  const [agentSnapshot, setAgentSnapshot] = useState(() => ({
    resource: optionsResource,
    catalog: optionsSnapshot.data,
    source: agents,
    value: agents,
  }))
  if (
    agentSnapshot.resource !== optionsResource ||
    agentSnapshot.catalog !== optionsSnapshot.data
  ) {
    setAgentSnapshot({
      resource: optionsResource,
      catalog: optionsSnapshot.data,
      source: agents,
      value: optionsSnapshot.data?.agents ?? agents,
    })
  } else if (agentSnapshot.source !== agents) {
    setAgentSnapshot({ ...agentSnapshot, source: agents, value: agents })
  }
  const availableAgents = agentSnapshot.value
  const [draft, setDraft] = useState<AutomaticProcessingDraft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceAutomationRule | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setError] = useState('')
  const [cronError, setCronError] = useState('')
  const [hooksRevision, setHooksRevision] = useState(0)
  const needsHooks = editing && draft.trigger === 'external'
  const incomingHooksApi = api.incomingHooks
  const hookScope = useMemo(
    () => ({ api, incomingHooksApi, projectId }),
    [api, incomingHooksApi, projectId]
  )
  const hooksResource = useMemo(
    () =>
      createAsyncResource(
        'automatic-processing-hooks',
        async () => ({
          hooks: await hookScope.incomingHooksApi!.list(hookScope.projectId),
          readId: Symbol('incoming-hooks-read'),
        }),
        { refreshOnSubscribe: true }
      ),
    [hookScope]
  )
  const subscribeHooks = useCallback(
    (listener: () => void) => hooksResource.subscribe(listener, hooksRevision),
    [hooksResource, hooksRevision]
  )
  const hooksEnabled = needsHooks && Boolean(incomingHooksApi)
  const hooksSnapshot = useSyncExternalStore(
    hooksEnabled ? subscribeHooks : subscribeIdleResource,
    hooksResource.getSnapshot,
    hooksResource.getSnapshot
  )
  const hooks = hooksSnapshot.data?.hooks ?? []
  const hooksLoading =
    hooksEnabled && (hooksSnapshot.status === 'idle' || hooksSnapshot.status === 'loading')
  const dataError = (cause: unknown) =>
    cause instanceof Error
      ? cause.message
      : translate('todo.automatic_processing_load_failed', '加载自动处理失败')
  const optionsError = optionsSnapshot.status === 'error' ? dataError(optionsSnapshot.error) : ''
  const hooksError =
    hooksEnabled && hooksSnapshot.status === 'error' ? dataError(hooksSnapshot.error) : ''
  const [formScope, setFormScope] = useState(optionsResource)
  if (formScope !== optionsResource) {
    setFormScope(optionsResource)
    setDraft(EMPTY_DRAFT)
    setEditing(false)
    setPendingRemoval(null)
    setError('')
    setCronError('')
  }
  const [handledHooksRead, setHandledHooksRead] = useState<symbol>()
  if (
    hooksEnabled &&
    hooksSnapshot.status === 'ready' &&
    hooksSnapshot.data &&
    handledHooksRead !== hooksSnapshot.data.readId
  ) {
    setHandledHooksRead(hooksSnapshot.data.readId)
    const hook = hooks[0]
    if (hook && !draft.hookId)
      setDraft({ ...draft, hookId: hook.id, eventType: eventTypesForHook(hook)[0] ?? '' })
  }
  const error =
    actionError ||
    optionsError ||
    (rulesError
      ? rulesError instanceof Error
        ? rulesError.message
        : translate('todo.automatic_processing_load_failed', '加载自动处理失败')
      : !api.automations
        ? translate('todo.automatic_processing_unavailable', '当前项目暂不支持自动处理。')
        : '')
  const canManage = project.access_role === 'Owner' || project.access_role === 'Maintainer'
  const closeEditor = () => {
    if (saving) return
    setCronError('')
    setEditing(false)
    setDraft(EMPTY_DRAFT)
  }
  const editorRef = useDialogKeyboard<HTMLFormElement>(closeEditor, editing)

  const projectRefresh = useProjectSettingsRefresh(api, project.id, onProjectChange)

  async function reloadAfterMutation() {
    if (!optionsResource.hasSubscribers()) return
    await projectRefresh.refresh()
    if (optionsResource.hasSubscribers()) await load()
  }

  const targetOptions = useMemo(
    () => ({
      human: (optionsSnapshot.data?.members ?? []).map(member => ({
        id: String(member.user_id),
        name: member.user_name,
      })),
      agent: availableAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
      })),
      collaboration_group: (optionsSnapshot.data?.groups ?? []).map(group => ({
        id: group.id,
        name: group.name,
      })),
    }),
    [availableAgents, optionsSnapshot.data]
  )
  const targetAvailable = targetOptions[draft.targetKind].some(
    option => option.id === draft.targetId
  )
  const targetKindLabel = {
    agent: translate('todo.target_agent', '智能体'),
    human: translate('todo.project_members', '项目成员'),
    collaboration_group: translate('todo.target_collaboration_group', '协作小组'),
  } satisfies Record<TargetKind, string>
  const selectedTargetName =
    targetOptions[draft.targetKind].find(option => option.id === draft.targetId)?.name ??
    translate('common.select', '请选择')
  const targetKinds = [
    {
      kind: 'human',
      label: targetKindLabel.human,
      icon: UserRound,
      options: targetOptions.human,
    },
    {
      kind: 'agent',
      label: targetKindLabel.agent,
      icon: Bot,
      options: targetOptions.agent,
    },
    {
      kind: 'collaboration_group',
      label: targetKindLabel.collaboration_group,
      icon: UsersRound,
      options: targetOptions.collaboration_group,
    },
  ] as const
  const SelectedTargetIcon =
    draft.targetKind === 'agent' ? Bot : draft.targetKind === 'human' ? UserRound : UsersRound
  const statuses = projectStatuses(project, collaborationMessages[locale], translate)
  function statusTriggerLabel(value: AutomaticProcessingDraft): string {
    const label =
      value.statusTransition === 'entered_processing'
        ? translate('todo.trigger_entered_processing', '进入处理阶段后')
        : translate('todo.trigger_status_changed', '进入指定状态后')
    const names = value.statuses.map(id => statuses.find(status => status.id === id)?.name ?? id)
    return names.length ? `${label} · ${names.join(locale === 'zh-CN' ? '、' : ', ')}` : label
  }
  const triggerPreview =
    draft.trigger === 'created'
      ? translate('todo.trigger_issue_created', 'Issue 创建后')
      : draft.trigger === 'tag_added'
        ? draft.tag.trim()
          ? `${translate('todo.trigger_tag_added', '添加标签后')} · ${draft.tag.trim()}`
          : translate('todo.trigger_tag_added', '添加指定标签后')
        : draft.trigger === 'status_changed'
          ? statusTriggerLabel(draft)
          : draft.trigger === 'schedule'
            ? draft.cronExpression.trim()
              ? `${translate('todo.trigger_schedule', '按时间定期处理')} · ${scheduleLabel(draft.cronExpression, locale, draft.workdayOnly)}`
              : translate('todo.trigger_schedule', '按时间定期处理')
            : draft.eventType
              ? eventLabel(draft.eventType, locale)
              : translate('todo.trigger_external_event', '外部事件发生后')
  const valid = Boolean(
    targetAvailable &&
    (draft.trigger !== 'external' || (!hooksLoading && !hooksError)) &&
    (draft.trigger !== 'tag_added' || draft.tag.trim()) &&
    (draft.trigger !== 'status_changed' ||
      ((draft.statuses.length > 0 || draft.statusTransition === 'entered_processing') &&
        draft.statuses.every(id => statuses.some(status => status.id === id)))) &&
    (draft.trigger !== 'schedule' || draft.cronExpression.trim()) &&
    (draft.trigger !== 'external' || (draft.hookId && draft.eventType))
  )

  function updateDraft(patch: Partial<AutomaticProcessingDraft>) {
    if (patch.cronExpression !== undefined || patch.trigger !== undefined) setCronError('')
    setDraft(current => ({
      ...current,
      ...patch,
      ...((patch.targetKind && patch.targetKind !== current.targetKind) ||
      (patch.targetId && patch.targetId !== current.targetId)
        ? { runnerSelection: undefined }
        : {}),
    }))
  }

  function openCreate() {
    const firstAgent = targetOptions.agent[0]
    const firstHuman = targetOptions.human[0]
    const firstGroup = targetOptions.collaboration_group[0]
    const targetKind: TargetKind = firstAgent
      ? 'agent'
      : firstHuman
        ? 'human'
        : 'collaboration_group'
    const target = firstAgent ?? firstHuman ?? firstGroup ?? { id: '', name: '' }
    setDraft({
      ...EMPTY_DRAFT,
      targetKind,
      targetId: target.id,
    })
    setEditing(true)
    setError('')
  }

  function selectTrigger(trigger: TriggerKind) {
    const hook = hooks[0]
    const eventType = hook ? (eventTypesForHook(hook)[0] ?? '') : ''
    updateDraft({
      trigger,
      ...(trigger === 'external'
        ? {
            hookId: draft.hookId || hook?.id || '',
            eventType: draft.eventType || eventType,
          }
        : {}),
    })
  }

  function inputFromDraft(value: AutomaticProcessingDraft): WorkspaceAutomationInput {
    const isSchedule = value.trigger === 'schedule'
    const eventType =
      value.trigger === 'created'
        ? 'task.created'
        : value.trigger === 'tag_added'
          ? 'task.tag_added'
          : value.trigger === 'status_changed'
            ? 'task.status_changed'
            : value.trigger === 'external'
              ? value.eventType || null
              : null
    const eventConfig =
      value.trigger === 'tag_added'
        ? { executionTarget: 'existing_issue', tags: [value.tag.trim()] }
        : value.trigger === 'status_changed'
          ? {
              executionTarget: 'existing_issue',
              transition: value.statusTransition,
              ...(value.statuses.length ? { statuses: value.statuses } : {}),
            }
          : value.trigger === 'external'
            ? {
                executionTarget: 'create_issue',
                subscriptionId: value.hookId,
              }
            : { executionTarget: 'existing_issue' }
    const targetName =
      targetOptions[value.targetKind].find(option => option.id === value.targetId)?.name ??
      translate('todo.unavailable_target', '目标不可用')
    const triggerName =
      value.trigger === 'created'
        ? translate('todo.trigger_issue_created', 'Issue 创建后')
        : value.trigger === 'tag_added'
          ? `${translate('todo.trigger_tag_added', '添加 Tag 后')} · ${value.tag}`
          : value.trigger === 'status_changed'
            ? statusTriggerLabel(value)
            : value.trigger === 'schedule'
              ? translate('todo.trigger_schedule', '按时间定期处理')
              : eventLabel(value.eventType, locale)
    return {
      name: value.name.trim() || `${triggerName} → ${targetName}`,
      prompt: value.prompt.trim()
        ? value.prompt
        : translate(
            'todo.automatic_processing_default_instruction',
            '按照目标职责和 Issue 内容完成处理，并记录清晰的执行结果。'
          ),
      triggerType: isSchedule ? 'schedule' : 'event',
      eventType,
      eventConfig,
      cronExpression: isSchedule ? value.cronExpression.trim() : null,
      workdayOnly: isSchedule && value.workdayOnly,
      timezone: value.timezone,
      targetKind: value.targetKind,
      targetId: value.targetId,
      executionDeviceId: null,
      enabled: value.enabled,
      runnerSelection: value.runnerSelection,
    }
  }

  async function save() {
    if (!canManage) return
    if (!valid || !api.automations) return
    setSaving(true)
    setError('')
    const input = inputFromDraft(draft)
    try {
      if (draft.id && draft.version) {
        await api.automations.update(project.id, draft.id, {
          ...input,
          version: draft.version,
        })
      } else {
        await api.automations.create(project.id, input)
      }
      await reloadAfterMutation()
      if (!optionsResource.hasSubscribers()) return
      setEditing(false)
      setDraft(EMPTY_DRAFT)
    } catch (saveError) {
      if (!optionsResource.hasSubscribers()) return
      const failure = automaticProcessingSaveError(saveError, translate)
      if (draft.trigger === 'schedule' && failure.cronInvalid) {
        setCronError(failure.message)
        setError('')
      } else setError(failure.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggle(rule: WorkspaceAutomationRule) {
    if (!api.automations || !canManage) return
    const ruleDraft = draftFromRule(rule)
    setSaving(true)
    setError('')
    try {
      await api.automations.update(project.id, rule.id, {
        ...inputFromDraft({ ...ruleDraft, enabled: !ruleDraft.enabled }),
        version: rule.version,
      })
      await reloadAfterMutation()
    } catch (toggleError) {
      if (!optionsResource.hasSubscribers()) return
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : translate('todo.automatic_processing_save_failed', '保存自动处理失败')
      )
    } finally {
      setSaving(false)
    }
  }

  async function remove(rule: WorkspaceAutomationRule) {
    if (!api.automations || !canManage) return
    setSaving(true)
    setError('')
    try {
      await api.automations.remove(project.id, rule.id)
      if (!optionsResource.hasSubscribers()) return
      if (draft.id === rule.id) {
        setEditing(false)
        setDraft(EMPTY_DRAFT)
      }
      await reloadAfterMutation()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ProjectSettingsPage
      actions={
        canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="collaboration-primary-button inline-flex shrink-0 items-center gap-1.5"
              data-testid="automatic-processing-create"
              disabled={optionsLoading || Boolean(optionsError)}
              onClick={openCreate}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {translate('todo.create_automatic_processing', '新建规则')}
            </button>
          </div>
        ) : undefined
      }
      description={translate(
        'todo.automatic_processing_description',
        '统一管理 Issue 自动处理和项目管理者的触发规则。'
      )}
      testId="collaboration-project-automatic-processing-page"
      title={translate('todo.automatic_processing', '自动处理')}
    >
      {pendingRemoval ? (
        <ConfirmationDialog
          title={translate('todo.delete_automatic_rule', '删除自动处理规则')}
          subject={pendingRemoval.name}
          description={translate(
            'todo.delete_automatic_rule_description',
            '删除后将停止此规则的后续自动处理，且无法恢复。'
          )}
          labels={{
            cancel: translate('common.cancel', '取消'),
            confirm: translate('common.delete', '删除'),
            pending: translate('common.deleting', '删除中…'),
            failed: translate('todo.automatic_processing_delete_failed', '删除自动处理失败'),
          }}
          testIdPrefix="automatic-processing-delete"
          onClose={() => setPendingRemoval(null)}
          onConfirm={() => remove(pendingRemoval)}
        />
      ) : null}
      <div className="space-y-4" data-testid="automatic-processing">
        <ProjectSettingsRefreshFeedback
          {...projectRefresh}
          testId="automatic-processing-project-refresh"
          translate={translate}
        />
        {loading ? (
          <p
            className="py-8 text-center text-sm text-text-muted"
            data-testid="automatic-processing-loading"
          >
            {translate('common.loading', '加载中…')}
          </p>
        ) : (
          <>
            {error ? (
              <div className="collaboration-alert" role="alert">
                {requestFailureMessage(
                  error,
                  translate('todo.settings_connection_failed', '无法连接服务，请检查连接后重试。')
                )}
              </div>
            ) : null}

            {rules.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background">
                {rules.map(rule => {
                  const ruleDraft = draftFromRule(rule)
                  const triggerLabel =
                    ruleDraft.trigger === 'created'
                      ? translate('todo.trigger_issue_created', 'Issue 创建后')
                      : ruleDraft.trigger === 'tag_added'
                        ? `${translate('todo.trigger_tag_added', '添加 Tag 后')} · ${ruleDraft.tag}`
                        : ruleDraft.trigger === 'status_changed'
                          ? statusTriggerLabel(ruleDraft)
                          : ruleDraft.trigger === 'schedule'
                            ? `${translate('todo.trigger_schedule', '按时间定期处理')} · ${scheduleLabel(ruleDraft.cronExpression, locale, ruleDraft.workdayOnly)}`
                            : eventLabel(ruleDraft.eventType, locale)
                  const targetName = rule.targetName
                  return (
                    <article
                      className="flex min-h-14 items-center gap-4 px-4 py-3"
                      data-testid={`automatic-processing-rule-${rule.id}`}
                      key={rule.id}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setDraft(ruleDraft)
                          setEditing(true)
                          setError('')
                        }}
                        type="button"
                      >
                        <strong className="block truncate text-sm font-medium text-text-primary">
                          {rule.name}
                        </strong>
                        <span className="mt-0.5 block truncate text-xs text-text-secondary">
                          {triggerLabel} · {targetKindLabel[rule.targetKind]} · {targetName}
                        </span>
                      </button>
                      {canManage ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <AutomaticProcessingSwitch
                            checked={ruleDraft.enabled}
                            disabled={saving}
                            label={translate('todo.enable_rule', '启用规则')}
                            onChange={() => void toggle(rule)}
                            testId={`automatic-processing-enabled-${rule.id}`}
                          />
                          <button
                            aria-label={translate('common.edit', '编辑')}
                            className="flex h-11 w-11 items-center justify-center rounded-lg md:h-8 md:w-8 text-text-secondary hover:bg-muted"
                            data-testid={`automatic-processing-edit-${rule.id}`}
                            onClick={() => {
                              setDraft(ruleDraft)
                              setEditing(true)
                              setError('')
                            }}
                            type="button"
                          >
                            <Pencil aria-hidden="true" className="h-4 w-4" />
                          </button>
                          <button
                            aria-label={translate('common.delete', '删除')}
                            className="flex h-11 w-11 items-center justify-center rounded-lg md:h-8 md:w-8 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                            data-testid={`automatic-processing-delete-${rule.id}`}
                            disabled={saving}
                            onClick={() => setPendingRemoval(rule)}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            ) : !editing && !error ? (
              <div className="py-12 text-center text-sm text-text-secondary">
                {translate('todo.no_automatic_processing', '暂无自动处理规则')}
              </div>
            ) : null}
          </>
        )}
      </div>

      {editing ? (
        <div className="collaboration-dialog-backdrop !bg-black/20">
          <DialogForm
            ref={editorRef}
            tabIndex={-1}
            aria-labelledby="automatic-processing-dialog-title"
            aria-modal="true"
            className="collaboration-dialog flex max-h-[calc(100vh-48px)] w-full max-w-[600px] flex-col overflow-hidden !rounded-2xl !p-0 !shadow-lg"
            data-testid="automatic-processing-form"
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}
            role="dialog"
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <h2 className="heading-small !m-0" id="automatic-processing-dialog-title">
                {!canManage
                  ? translate('todo.view_automatic_processing', '查看自动处理')
                  : draft.id
                    ? translate('todo.edit_automatic_processing', '编辑自动处理')
                    : translate('todo.create_automatic_processing', '新建自动处理')}
              </h2>
              <button
                data-testid="automatic-processing-close"
                aria-label={translate('common.close', '关闭')}
                className="flex h-11 w-11 items-center justify-center rounded-lg md:h-8 md:w-8 text-text-secondary hover:bg-muted"
                disabled={saving}
                onClick={closeEditor}
                type="button"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </header>

            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto"
              data-testid="automatic-processing-body"
            >
              <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-5 border-0 px-5 py-5">
                {!canManage ? (
                  <p className="text-sm text-text-secondary">
                    {translate(
                      'todo.automatic_rule_read_only',
                      '只读：你可以查看规则，只有项目管理者可以修改。'
                    )}
                  </p>
                ) : null}
                <div
                  className="rounded-xl border border-border bg-muted/40 px-4 py-3"
                  data-testid="automatic-processing-preview"
                >
                  <p className="text-xs font-medium text-text-secondary">
                    {translate('todo.rule_preview', '规则预览')}
                  </p>
                  <p className="mt-1 text-sm font-medium text-text-primary">
                    {triggerPreview}
                    <span className="mx-2 text-text-muted">→</span>
                    {selectedTargetName}
                    <span className="ml-1 font-normal text-text-secondary">
                      · {targetKindLabel[draft.targetKind]}
                    </span>
                  </p>
                </div>

                <AutomaticProcessingTriggerFields
                  cronError={cronError}
                  draft={draft}
                  updateDraft={updateDraft}
                  selectTrigger={selectTrigger}
                  refreshHooks={() => setHooksRevision(value => value + 1)}
                  locale={locale}
                  translate={translate}
                  hooks={hooks}
                  hooksLoading={hooksLoading}
                  hooksError={hooksError}
                  hasIncomingHooks={Boolean(api.incomingHooks)}
                  statuses={statuses}
                />

                <section className="space-y-2">
                  <h3 className="text-sm font-medium text-text-primary">
                    {translate('todo.assign_to', '交给')}
                  </h3>
                  <div
                    className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2"
                    data-testid="automatic-processing-target-kinds"
                  >
                    {targetKinds.map(targetKind => {
                      const selected = draft.targetKind === targetKind.kind
                      const available = targetKind.options.length > 0
                      const Icon = targetKind.icon
                      return (
                        <button
                          aria-pressed={selected}
                          className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                            selected
                              ? 'automatic-processing-selected-soft'
                              : available
                                ? 'border-border hover:bg-muted/60'
                                : 'cursor-not-allowed border-border/60'
                          }`}
                          data-testid={`automatic-processing-target-kind-${targetKind.kind}`}
                          disabled={!available}
                          key={targetKind.kind}
                          onClick={() => {
                            const firstTarget = targetKind.options[0]
                            updateDraft({
                              targetKind: targetKind.kind,
                              targetId: firstTarget?.id ?? '',
                            })
                          }}
                          type="button"
                        >
                          <Icon
                            aria-hidden="true"
                            className={`h-4 w-4 shrink-0 ${
                              selected
                                ? 'automatic-processing-selected-icon'
                                : 'text-text-secondary'
                            }`}
                          />
                          <span className="min-w-0">
                            <strong
                              className={`block break-words text-sm font-medium ${
                                available ? 'text-text-primary' : 'text-text-muted'
                              }`}
                            >
                              {targetKind.label}
                            </strong>
                            <span
                              className={`block text-xs ${
                                available ? 'text-text-secondary' : 'text-text-muted'
                              }`}
                            >
                              {available
                                ? locale === 'zh-CN'
                                  ? `${targetKind.options.length} 个可用`
                                  : `${targetKind.options.length} available`
                                : translate('common.not_configured', '未配置')}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <AutomaticProcessingTargetPicker
                    key={draft.targetKind}
                    kind={draft.targetKind}
                    kindLabel={targetKindLabel[draft.targetKind]}
                    icon={SelectedTargetIcon}
                    options={targetOptions[draft.targetKind]}
                    selectedId={draft.targetId}
                    onSelect={targetId => updateDraft({ targetId })}
                    translate={translate}
                  />
                </section>

                {draft.targetKind !== 'human' ||
                draft.trigger === 'schedule' ||
                draft.trigger === 'external' ? (
                  <div className="space-y-2">
                    <label
                      className="block text-sm font-medium text-text-primary"
                      htmlFor="automatic-processing-prompt"
                    >
                      {translate(
                        draft.targetKind === 'human'
                          ? 'todo.automatic_processing_issue_description'
                          : 'todo.automatic_processing_prompt',
                        draft.targetKind === 'human' ? '新 Issue 说明（可选）' : '提示词（可选）'
                      )}
                    </label>
                    <Textarea
                      aria-describedby="automatic-processing-prompt-hint"
                      data-testid="automatic-processing-prompt"
                      disabled={saving}
                      id="automatic-processing-prompt"
                      maxLength={100000}
                      onChange={event => updateDraft({ prompt: event.target.value })}
                      rows={4}
                      value={draft.prompt}
                    />
                    <p
                      className="text-xs leading-5 text-text-secondary"
                      id="automatic-processing-prompt-hint"
                    >
                      {draft.targetKind === 'human'
                        ? translate(
                            'todo.automatic_processing_human_description_hint',
                            '触发后创建新 Issue，并将此内容写入事项说明，再指派给所选成员。'
                          )
                        : draft.targetKind === 'collaboration_group'
                          ? translate(
                              'todo.automatic_processing_group_prompt_hint',
                              '新建 Issue 时写入事项说明。已有 Issue 的处理要求请写在 Issue 内容或小组协作规则中。'
                            )
                          : translate(
                              'todo.automatic_processing_prompt_hint',
                              '触发时发送给 AI，用于处理当前 Issue；留空按目标职责处理。'
                            )}
                    </p>
                  </div>
                ) : null}
                <p
                  className="text-xs leading-5 text-text-secondary"
                  data-testid="automatic-processing-routing-hint"
                >
                  {draft.targetKind === 'human'
                    ? translate(
                        'todo.automatic_processing_human_hint',
                        '触发后将 Issue 指派给所选成员。成员按 Issue 内容处理，此规则不会启动 AI 执行。'
                      )
                    : draft.targetKind === 'collaboration_group'
                      ? translate(
                          'todo.automatic_processing_group_runner_hint',
                          '由小组负责人协调处理；AI 执行时使用小组与成员已配置的运行方式。'
                        )
                      : translate(
                          'todo.automatic_processing_agent_runner_hint',
                          'AI 按智能体已保存的执行环境与模型策略运行，同一 Issue 的后续执行会沿用其绑定关系。'
                        )}
                </p>

                {error ? (
                  <div className="collaboration-alert" role="alert">
                    {requestFailureMessage(
                      error,
                      translate(
                        'todo.settings_connection_failed',
                        '无法连接服务，请检查连接后重试。'
                      )
                    )}
                  </div>
                ) : null}
              </fieldset>
            </div>

            <AutomaticProcessingDialogFooter
              draft={draft}
              saving={saving}
              canManage={canManage}
              translate={translate}
              onEnabledChange={enabled => updateDraft({ enabled })}
              onClose={closeEditor}
              valid={valid}
            />
          </DialogForm>
        </div>
      ) : null}
    </ProjectSettingsPage>
  )
}
