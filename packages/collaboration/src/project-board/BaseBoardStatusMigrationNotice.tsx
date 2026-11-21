import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'

export function BaseBoardStatusMigrationNotice({
  error,
  retry,
  translate: t,
}: {
  error: Error | null
  retry(): void
  translate: CollaborationTranslate
}) {
  if (!error) return null
  return (
    <div role="alert" className="mx-6 mb-2 flex items-center gap-3 text-sm text-destructive">
      <span>{t('todo.board_base_migration_failed')}</span>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="board-base-migration-retry"
        onClick={retry}
        className="min-h-11 rounded-lg px-3 text-text-primary hover:bg-muted md:min-h-8"
      >
        {t('todo.board_base_migration_retry')}
      </ControlButton>
    </div>
  )
}
