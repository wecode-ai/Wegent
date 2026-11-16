// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { BatchDeletionResult } from '@/apis/knowledge'

interface BatchDeletionDialogProps {
  result: BatchDeletionResult | null
  error: string | null
  loading: boolean
  onContinue: () => void
  onClose: () => void
}

export function BatchDeletionDialog({
  result,
  error,
  loading,
  onContinue,
  onClose,
}: BatchDeletionDialogProps) {
  const { t } = useTranslation('knowledge')
  const eligible = result?.items.filter(item => !item.content_deleted && item.can_continue) ?? []
  const open = Boolean(error || (result && (result.failed_count || result.unconfirmed_count)))
  const labels: Record<string, string> = {
    document_not_found: 'batchNotFound',
    permission_denied: 'batchRejected',
    deletion_rejected: 'batchRejected',
    cleanup_service_authentication_failed: 'serviceAuthFailed',
    index_cleanup_failed: 'batchCleanupFailed',
    internal_error: 'batchFailed',
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        data-testid="batch-deletion-dialog"
        className="max-h-[90dvh] overflow-y-auto"
        closeButtonProps={{ disabled: loading, 'data-testid': 'close-batch-deletion' }}
      >
        <DialogHeader>
          <DialogTitle>{t('document.deletion.batchTitle')}</DialogTitle>
          <DialogDescription data-testid="batch-deletion-summary">
            {result &&
              t('document.deletion.batchSummary', {
                deleted: result.success_count,
                unconfirmed: result.unconfirmed_count,
                failed: result.failed_count,
              })}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert">{error}</p>}
        {eligible.length > 0 && (
          <p role="alert">
            {t('document.deletion.batchContinueWarning', { count: eligible.length })}
          </p>
        )}
        {!!result?.unconfirmed_count && <p>{t('document.deletion.residualWarning')}</p>}
        <ul className="space-y-2 text-sm">
          {result?.items
            .filter(item => !item.content_deleted || item.index_cleanup === 'unconfirmed')
            .map(item => (
              <li key={item.document_id} data-testid={`batch-deletion-item-${item.document_id}`}>
                #{item.document_id}:{' '}
                {t(
                  `document.deletion.${item.content_deleted ? 'batchResidual' : item.can_continue ? 'batchExternalFailure' : (labels[item.error_code ?? ''] ?? 'batchFailed')}`
                )}
              </li>
            ))}
        </ul>
        <DialogFooter>
          <Button
            data-testid="cancel-batch-deletion"
            className="min-h-11"
            variant="outline"
            disabled={loading}
            onClick={onClose}
          >
            {t(eligible.length ? 'common:actions.cancel' : 'common:actions.close')}
          </Button>
          {eligible.length > 0 && (
            <Button
              data-testid="continue-batch-deletion"
              className="min-h-11"
              variant="primary"
              disabled={loading}
              onClick={onContinue}
            >
              {loading ? t('common:actions.deleting') : t('document.deletion.continue')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
