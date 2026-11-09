// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { taskApis, type BranchDiffResponse } from '@/apis/tasks'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskFileChanges, WorkbenchData } from '@/types/api'
import DiffViewer from '../message/DiffViewer'

interface WorkbenchFilesProps {
  taskKey: string
  repository?: string
  fileChanges?: TaskFileChanges | null
  workbenchData?: WorkbenchData | null
  isCompleted: boolean
}

interface DiffState {
  scope: string
  pending: boolean
  data?: BranchDiffResponse
  error?: string
}

function diffErrorType(message: string): string {
  const error = message.toLowerCase()
  if (/404|not found/.test(error)) return 'branch_not_found'
  if (/401|403|unauthorized|forbidden|access denied/.test(error)) return 'access_denied'
  if (/500|502|503|504|server error|bad gateway|service unavailable/.test(error)) {
    return 'server_error'
  }
  if (/network|timeout|econnrefused|fetch failed/.test(error)) return 'network_error'
  return 'unknown_error'
}

export default function WorkbenchFiles({
  taskKey,
  repository,
  fileChanges,
  workbenchData,
  isCompleted,
}: WorkbenchFilesProps) {
  const { t } = useTranslation('tasks')
  const [state, setState] = useState<DiffState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const source = workbenchData?.git_info?.source_branch
  const target = workbenchData?.git_info?.target_branch
  const gitType = workbenchData?.git_type || 'github'
  const gitDomain = workbenchData?.git_domain || 'github.com'
  const scope = JSON.stringify([taskKey, repository, source, target, gitType, gitDomain])
  const lastUpdated = workbenchData?.lastUpdated

  // The file tab owns historical branch requests. Inline task snapshots need no request.
  useEffect(() => {
    if (fileChanges || !isCompleted || !repository || !source || !target) return
    let current = true
    setState(previous => ({
      scope,
      pending: true,
      data: previous?.scope === scope ? previous.data : undefined,
    }))
    taskApis
      .getBranchDiff({
        git_repo: repository,
        source_branch: source,
        target_branch: target,
        type: gitType,
        git_domain: gitDomain,
      })
      .then(
        data => current && setState({ scope, pending: false, data }),
        error =>
          current &&
          setState(previous => ({
            scope,
            pending: false,
            data: previous?.scope === scope ? previous.data : undefined,
            error: error instanceof Error ? error.message : String(error),
          }))
      )
    return () => {
      current = false
    }
  }, [
    scope,
    repository,
    source,
    target,
    gitType,
    gitDomain,
    lastUpdated,
    fileChanges,
    isCompleted,
    attempt,
  ])

  const current = !fileChanges && state?.scope === scope ? state : null
  const error = fileChanges?.status === 'error' ? 'snapshot_failed' : current?.error
  const hasFiles = Boolean(fileChanges?.files.length || workbenchData?.file_changes?.length)

  return (
    <div data-testid="workbench-files" className="space-y-4">
      {error && (
        <div role="alert" className="rounded-lg border border-border bg-surface p-4">
          <p className="text-text-muted">
            {t(
              error === 'snapshot_failed'
                ? 'tasks:workbench.snapshot_failed'
                : `tasks:workbench.diff_error.${diffErrorType(error)}`
            )}
          </p>
          {error !== 'snapshot_failed' && (
            <>
              <button
                data-testid="workbench-diff-retry"
                onClick={() => setAttempt(value => value + 1)}
                className="mt-2 text-sm text-primary"
              >
                {t('tasks:workbench.retry')}
              </button>
              <details data-testid="workbench-diff-error-details" className="mt-2 text-sm">
                <summary>{t('tasks:workbench.view_error_details')}</summary>
                <pre className="whitespace-pre-wrap break-all">{error}</pre>
              </details>
            </>
          )}
        </div>
      )}
      {fileChanges?.status === 'active' && fileChanges.files.length > 0 ? (
        <>
          <p className="text-xs text-text-muted">
            {t(
              fileChanges.diff_truncated
                ? 'tasks:workbench.diff_truncated'
                : 'tasks:workbench.task_file_changes'
            )}
          </p>
          <DiffViewer diffData={null} gitType={gitType} inlineChanges={fileChanges} />
        </>
      ) : current?.pending && !current.data ? (
        <DiffViewer diffData={null} gitType={gitType} isLoading />
      ) : current?.data ? (
        <DiffViewer diffData={current.data} gitType={gitType} />
      ) : !fileChanges && hasFiles ? (
        <DiffViewer
          diffData={null}
          gitType={gitType}
          fileChanges={workbenchData?.file_changes}
          showDiffContent={false}
        />
      ) : !error ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-text-muted">
            {t(
              !repository && !fileChanges
                ? 'tasks:workbench.no_repository'
                : isCompleted && !fileChanges && !workbenchData
                  ? 'tasks:workbench.file_changes_unavailable'
                  : isCompleted
                    ? 'tasks:workbench.no_changes_found'
                    : 'tasks:workbench.no_file_changes'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
