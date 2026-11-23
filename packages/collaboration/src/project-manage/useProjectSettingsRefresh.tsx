import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'

// A successful configuration write may also advance its owning Project version.
// Refresh failure must not turn a committed write into a duplicate submission.
export function useProjectSettingsRefresh(
  api: SharedWorkspaceApi,
  projectId: string,
  onProjectChange?: (project: CollaborationProject) => void
) {
  const scope = useMemo(() => ({ api, projectId }), [api, projectId])
  const current = useRef(scope)
  current.current = scope
  const sequence = useRef(0)
  const [state, setState] = useState({ scope, failed: false, refreshing: false })
  const refresh = useCallback(async () => {
    if (!onProjectChange) return
    const request = ++sequence.current
    setState(previous => ({
      scope,
      failed: previous.scope === scope && previous.failed,
      refreshing: true,
    }))
    try {
      const project = await api.projects.get(projectId)
      if (current.current !== scope || request !== sequence.current) return
      onProjectChange(project)
      setState({ scope, failed: false, refreshing: false })
    } catch {
      if (current.current === scope && request === sequence.current)
        setState({ scope, failed: true, refreshing: false })
    }
  }, [api, projectId, onProjectChange, scope])
  return {
    failed: state.scope === scope && state.failed,
    refreshing: state.scope === scope && state.refreshing,
    refresh,
  }
}

export function ProjectSettingsRefreshFeedback({
  failed,
  refreshing,
  refresh,
  testId,
  translate,
}: ReturnType<typeof useProjectSettingsRefresh> & {
  testId: string
  translate: CollaborationTranslate
}) {
  return failed ? (
    <div role="alert" className="collaboration-alert" data-testid={`${testId}-error`}>
      {translate(
        'todo.project_settings_refresh_failed',
        '配置已保存，但项目信息刷新失败。请重试刷新。'
      )}{' '}
      <ControlButton
        variant="unstyled"
        type="button"
        className="collaboration-link-button"
        data-testid={`${testId}-retry`}
        disabled={refreshing}
        onClick={() => void refresh()}
      >
        {refreshing ? translate('common.loading', '加载中…') : translate('common.retry', '重试')}
      </ControlButton>
    </div>
  ) : null
}
