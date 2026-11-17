// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectSnapshotSyncState } from './projectSnapshotRefresh'

export function ProjectSnapshotSyncNotice({
  state,
  retry,
}: {
  state: ProjectSnapshotSyncState
  retry(): Promise<void>
}) {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      data-testid="project-snapshot-sync-state"
      data-sync-state={state}
      className="flex shrink-0 items-center justify-between gap-2 px-4 py-1 text-xs text-text-muted"
    >
      <span>{t(`todo.project_snapshot_${state}`)}</span>
      {state === 'stale' || state === 'offline' ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid="project-snapshot-retry"
          onClick={() => void retry()}
        >
          {t('workbench.retry')}
        </Button>
      ) : null}
    </div>
  )
}
