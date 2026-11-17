// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup } from '../types'
import { templateFailureMessage } from './messages'
import { restartProjectTemplateImport, resumeProjectTemplateImport } from './projectConfiguration'
import { TemplateImportRetryError } from './projectTemplateImport'
import {
  readProjectTemplateImportIntent,
  templateImportStateError,
  type ProjectTemplateImportIntent,
} from './projectTemplateImportIntent'
import type { TemplateImportOperation } from './projectTemplateImportTypes'

const messages = {
  'zh-CN': {
    title: '未完成的模板导入',
    open: '查看未完成导入',
    hide: '收起未完成导入',
    loading: '正在读取导入进度…',
    select: '选择要继续的导入',
    choose: '请选择导入记录',
    record: '导入记录 {number} · 已保存 {done}/{total} 步',
    saved: '以下配置来自已保存的导入，只会补齐尚未完成的步骤。',
    members: '{count} 名成员',
    retry: '重新读取',
    refresh: '刷新导入进度',
    resume: '继续导入',
    resuming: '正在继续导入…',
    completedTitle: '模板导入记录',
    completedOpen: '查看导入记录',
    completedHide: '收起导入记录',
    completed: '上次导入已完成。开始新的导入会根据以上配置创建新的小组和所需智能体。',
    restart: '开始新的导入',
    restarting: '正在开始新的导入…',
    review: '核对导入结果',
  },
  en: {
    title: 'Unfinished template imports',
    open: 'View unfinished imports',
    hide: 'Hide unfinished imports',
    loading: 'Reading import progress…',
    select: 'Choose an import to continue',
    choose: 'Choose an import',
    record: 'Import {number} · {done}/{total} steps saved',
    saved: 'This is the saved configuration. Only unfinished steps will be applied.',
    members: '{count} members',
    retry: 'Read again',
    refresh: 'Refresh import progress',
    resume: 'Continue import',
    resuming: 'Continuing import…',
    completedTitle: 'Template import records',
    completedOpen: 'View import records',
    completedHide: 'Hide import records',
    completed:
      'The previous import is complete. Starting a new import creates new groups and any agents required by the saved configuration.',
    restart: 'Start a new import',
    restarting: 'Starting a new import…',
    review: 'Check import results',
  },
}

export function ProjectTemplateImportRecovery({
  api,
  projectId,
  locale,
  disabled = false,
  refreshKey = 0,
  operation,
  isActive,
  onBusyChange,
  onGroupsRefreshed,
  onResumed,
}: {
  api: SharedWorkspaceApi
  projectId: string
  locale: CollaborationLocale
  disabled?: boolean
  refreshKey?: number
  operation?: TemplateImportOperation
  isActive?(): boolean
  onBusyChange?(busy: boolean): void
  onGroupsRefreshed?(groups: CollaborationGroup[]): void
  onResumed(groups: CollaborationGroup[]): Promise<void>
}) {
  const m = messages[locale]
  const scope = useMemo(() => ({ api, projectId, locale, active: false }), [api, projectId, locale])
  const current = useRef(scope)
  current.current = scope
  const active = useRef(isActive)
  active.current = isActive
  const isCurrent = useCallback(
    () => scope.active && current.current === scope && (active.current?.() ?? true),
    [scope]
  )
  const [revision, setRevision] = useState(0)
  const [detailRevision, setDetailRevision] = useState(0)
  const [opened, setOpened] = useState(false)
  const [selection, setSelection] = useState<{ scope: typeof scope; id: string } | null>(null)
  const selectedId = selection?.scope === scope ? selection.id : ''
  const [list, setList] = useState<{
    scope: typeof scope
    supported: boolean
    loading: boolean
    operations: TemplateImportOperation[]
    error?: unknown
  } | null>(null)
  const [detail, setDetail] = useState<{
    scope: typeof scope
    id: string
    status?: TemplateImportOperation['status']
    intent?: ProjectTemplateImportIntent
    error?: unknown
  } | null>(null)
  const [execution, setExecution] = useState<'resume' | 'restart' | null>(null)
  const [resumeError, setResumeError] = useState<unknown>(null)
  const [failedImport, setFailedImport] = useState<{
    scope: typeof scope
    operation: TemplateImportOperation
  } | null>(null)

  useEffect(() => {
    scope.active = true
    setOpened(false)
    setSelection(null)
    setDetail(null)
    setExecution(null)
    setResumeError(null)
    setFailedImport(null)
    return () => {
      scope.active = false
    }
  }, [scope])

  useEffect(() => {
    const { api, projectId } = scope
    if (!api.templateImports) return
    let active = true
    setList(previous => ({
      scope,
      supported: true,
      loading: true,
      operations: previous?.scope === scope ? previous.operations : [],
    }))
    void (async () => {
      const supported = (await api.templateImports!.supports?.(projectId)) ?? true
      if (!active || !isCurrent()) return
      const operations = supported ? await api.templateImports!.list(projectId) : []
      if (!active || !isCurrent()) return
      setList({
        scope,
        supported,
        loading: false,
        operations: operations.filter(
          item =>
            item.projectId === projectId && item.protocolVersion === 1 && item.status === 'pending'
        ),
      })
    })().catch(error => {
      if (active && isCurrent())
        setList(previous => ({
          scope,
          supported: true,
          loading: false,
          operations: previous?.scope === scope ? previous.operations : [],
          error,
        }))
    })
    return () => {
      active = false
    }
  }, [scope, isCurrent, revision, refreshKey])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    setDetail(null)
    setResumeError(null)
    void scope.api.templateImports!.get(scope.projectId, selectedId).then(
      selected => {
        if (!active || !isCurrent()) return
        try {
          if (
            selected.id !== selectedId ||
            selected.projectId !== scope.projectId ||
            selected.protocolVersion !== 1 ||
            !['pending', 'completed'].includes(selected.status)
          )
            throw templateImportStateError(scope.locale)
          const intent = readProjectTemplateImportIntent(selected, scope.locale)
          setDetail({ scope, id: selectedId, intent, status: selected.status })
        } catch (error) {
          setDetail({ scope, id: selectedId, error })
        }
      },
      error => {
        if (active && isCurrent()) setDetail({ scope, id: selectedId, error })
      }
    )
    return () => {
      active = false
    }
  }, [scope, isCurrent, selectedId, detailRevision])

  const state = list?.scope === scope ? list : null
  const selected = detail?.scope === scope && detail.id === selectedId ? detail : null
  const operations = [...(state?.operations ?? [])]
  const failedOperations = [
    operation,
    failedImport?.scope === scope ? failedImport.operation : undefined,
  ].filter(
    (item): item is TemplateImportOperation =>
      !!item && item.projectId === projectId && item.protocolVersion === 1
  )
  for (const failed of failedOperations) {
    if (!operations.some(item => item.id === failed.id)) operations.push(failed)
  }
  if (!api.templateImports || state?.supported === false) return null
  if (!state?.loading && !state?.error && !operations.length && !selectedId) return null
  const busy = disabled || !!execution
  const completed = failedOperations.some(item => item.status === 'completed')
  const canRestart =
    selected?.status === 'completed' &&
    failedOperations.some(item => item.id === selectedId && item.status === 'completed')
  const runImport = async (restart: boolean) => {
    if (!isCurrent() || !selectedId || execution || (restart && !canRestart)) return
    setExecution(restart ? 'restart' : 'resume')
    setResumeError(null)
    onBusyChange?.(true)
    try {
      const apply = restart ? restartProjectTemplateImport : resumeProjectTemplateImport
      const groups = await apply(api, projectId, selectedId, locale, groups => {
        if (isCurrent()) onGroupsRefreshed?.(groups)
      })
      if (!isCurrent()) return
      await onResumed(groups)
      if (isCurrent()) setSelection(null)
    } catch (error) {
      if (isCurrent()) {
        setResumeError(error)
        if (error instanceof TemplateImportRetryError && error.operation)
          setFailedImport({ scope, operation: error.operation })
      }
    } finally {
      if (isCurrent()) {
        setExecution(null)
        onBusyChange?.(false)
        setRevision(value => value + 1)
      }
    }
  }

  return (
    <section
      aria-label={completed ? m.completedTitle : m.title}
      data-testid="template-import-recovery"
    >
      {state?.loading && (
        <p role="status" className="collaboration-template-muted">
          {m.loading}
        </p>
      )}
      {!!state?.error && (
        <p
          role="alert"
          className="collaboration-template-error"
          data-testid="template-import-recovery-error"
        >
          {templateFailureMessage(state.error, locale)}
        </p>
      )}
      {(operations.length > 0 || selectedId) && (
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="template-import-recovery-open"
          disabled={busy}
          aria-expanded={opened}
          onClick={() => setOpened(value => !value)}
        >
          {completed ? (opened ? m.completedHide : m.completedOpen) : opened ? m.hide : m.open}
        </button>
      )}
      {(!!state?.error || opened) && (
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="template-import-recovery-refresh"
          disabled={busy || state?.loading}
          onClick={() => setRevision(value => value + 1)}
        >
          {m.refresh}
        </button>
      )}
      {opened && (
        <>
          <label>
            <span>{m.select}</span>
            <select
              data-testid="template-import-recovery-select"
              value={selectedId}
              disabled={busy}
              onChange={event => setSelection({ scope, id: event.target.value })}
            >
              <option value="">{m.choose}</option>
              {operations.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {m.record
                    .replace('{number}', String(index + 1))
                    .replace('{done}', String(item.steps.filter(step => step.resourceId).length))
                    .replace('{total}', String(item.steps.length))}
                </option>
              ))}
            </select>
          </label>
          {selectedId && !selected && <p role="status">{m.loading}</p>}
          {!!selected?.error && (
            <p role="alert" className="collaboration-template-error">
              {templateFailureMessage(selected.error, locale)}{' '}
              <button
                type="button"
                data-testid="template-import-recovery-detail-retry"
                disabled={busy}
                onClick={() => setDetailRevision(value => value + 1)}
              >
                {m.retry}
              </button>
            </p>
          )}
          {selected?.intent && (
            <div data-testid="template-import-recovery-preview">
              <p className="collaboration-template-muted">
                {selected.status === 'completed' ? m.completed : m.saved}
              </p>
              <ul>
                {selected.intent.drafts.map((draft, index) => (
                  <li key={index}>
                    {draft.name} ·{' '}
                    {m.members.replace(
                      '{count}',
                      String(
                        new Set(
                          [draft.leader, ...draft.members].map(
                            member => `${member.kind}:${member.id}`
                          )
                        ).size
                      )
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="collaboration-template-choice"
                data-testid="template-import-recovery-resume"
                disabled={busy}
                onClick={() => runImport(false)}
              >
                {execution === 'resume'
                  ? m.resuming
                  : selected.status === 'completed'
                    ? m.review
                    : m.resume}
              </button>
              {canRestart && (
                <button
                  type="button"
                  className="collaboration-template-choice"
                  data-testid="template-import-recovery-restart"
                  disabled={busy}
                  onClick={() => runImport(true)}
                >
                  {execution === 'restart' ? m.restarting : m.restart}
                </button>
              )}
            </div>
          )}
          {!!resumeError && (
            <p role="alert" className="collaboration-template-error">
              {templateFailureMessage(resumeError, locale)}
            </p>
          )}
        </>
      )}
    </section>
  )
}
