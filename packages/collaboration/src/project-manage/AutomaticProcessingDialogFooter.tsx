import { Checkbox } from '../controls/Checkbox'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'
import type { AutomaticProcessingDraft } from './automaticProcessing'

export function AutomaticProcessingDialogFooter({
  draft,
  saving,
  canManage,
  translate,
  onEnabledChange,
  onClose,
  valid,
}: {
  draft: AutomaticProcessingDraft
  saving: boolean
  canManage: boolean
  translate: CollaborationTranslate
  onEnabledChange(enabled: boolean): void
  onClose(): void
  valid: boolean
}) {
  return (
    <footer className="flex flex-wrap min-h-14 shrink-0 items-center !justify-between gap-4 border-t border-border bg-surface px-5 py-3">
      <label className="!flex min-h-11 md:min-h-0 min-w-0 cursor-pointer items-center gap-2 text-sm text-text-secondary">
        <Checkbox
          checked={draft.enabled}
          data-testid="automatic-processing-enabled"
          disabled={!canManage || saving}
          onCheckedChange={checked => onEnabledChange(checked === true)}
        />
        {draft.id
          ? translate('todo.enable_rule', '启用规则')
          : translate('todo.enable_after_creation', '创建后立即启用')}
      </label>
      <div className="ml-auto flex items-center gap-2">
        <ControlButton
          variant="outline"
          size="sm"
          className="h-11 md:h-8 rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-muted"
          data-testid="automatic-processing-cancel"
          disabled={saving}
          onClick={onClose}
          type="button"
        >
          {translate('common.cancel', '取消')}
        </ControlButton>
        {canManage ? (
          <ControlButton
            variant="unstyled"
            className="collaboration-primary-button"
            data-testid="automatic-processing-save"
            disabled={!valid || saving}
            type="submit"
          >
            {saving
              ? translate('common.saving', '保存中…')
              : draft.id
                ? translate('common.save', '保存')
                : translate('todo.create_automatic_processing', '创建自动处理')}
          </ControlButton>
        ) : null}
      </div>
    </footer>
  )
}
