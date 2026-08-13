// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { VideoTimestampPromptStatus } from '../utils/videoTimestampPromptGuard'

interface VideoTimestampPromptWarningDialogProps {
  open: boolean
  status: VideoTimestampPromptStatus
  injectionExceedsLimit: boolean
  onInject: () => void
  onSkip: () => void
  onCancel: () => void
}

export function VideoTimestampPromptWarningDialog({
  open,
  status,
  injectionExceedsLimit,
  onInject,
  onSkip,
  onCancel,
}: VideoTimestampPromptWarningDialogProps) {
  const { t } = useTranslation('knowledge')
  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && onCancel()}>
      <DialogContent className="max-w-lg" data-testid="video-timestamp-prompt-warning">
        <DialogHeader>
          <DialogTitle>{t('document.multimodal.timestampGuard.title')}</DialogTitle>
          <DialogDescription>
            {t(
              status === 'conflict'
                ? 'document.multimodal.timestampGuard.conflictDescription'
                : 'document.multimodal.timestampGuard.description'
            )}
          </DialogDescription>
        </DialogHeader>
        {injectionExceedsLimit && (
          <p className="text-sm text-destructive">
            {t('document.multimodal.timestampGuard.injectionTooLong')}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onCancel}
            data-testid="video-timestamp-prompt-return"
          >
            {t('document.multimodal.timestampGuard.returnToEdit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onSkip}
            data-testid="video-timestamp-prompt-skip"
          >
            {t('document.multimodal.timestampGuard.continueAnyway')}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-11"
            onClick={onInject}
            disabled={injectionExceedsLimit}
            data-testid="video-timestamp-prompt-inject"
          >
            {t('document.multimodal.timestampGuard.injectAndContinue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
