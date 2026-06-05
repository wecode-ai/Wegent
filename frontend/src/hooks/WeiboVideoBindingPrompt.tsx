// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExternalLink, Loader2 } from 'lucide-react'

import type { WeiboAccountPreviewResponse } from '@/apis/user'
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

interface WeiboVideoBindingPromptProps {
  open: boolean
  previewAccount: WeiboAccountPreviewResponse | null
  isPreviewing: boolean
  isBinding: boolean
  onOpenChange: (open: boolean) => void
  onContinueWithoutBinding: () => void
  onPreview: () => void
  onConfirmBind: () => void
}

export function WeiboVideoBindingPrompt({
  open,
  previewAccount,
  isPreviewing,
  isBinding,
  onOpenChange,
  onContinueWithoutBinding,
  onPreview,
  onConfirmBind,
}: WeiboVideoBindingPromptProps) {
  const { t } = useTranslation('chat')
  const isBusy = isPreviewing || isBinding

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="weibo-video-binding-prompt">
        <DialogHeader>
          <DialogTitle>{t('weiboVideoBinding.title')}</DialogTitle>
          <DialogDescription>{t('weiboVideoBinding.description')}</DialogDescription>
        </DialogHeader>

        {previewAccount && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
              {previewAccount.weibo_avatar_url ? (
                <div
                  role="img"
                  aria-label={t('settings:weiboBinding.avatarAlt')}
                  style={{ backgroundImage: `url("${previewAccount.weibo_avatar_url}")` }}
                  className="h-12 w-12 shrink-0 rounded-full border border-border bg-cover bg-center"
                  data-testid="weibo-video-preview-avatar"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-base text-sm text-text-muted">
                  {t('settings:weiboBinding.avatarFallback')}
                </div>
              )}
              <div className="min-w-0 text-sm">
                <p
                  className="truncate font-medium text-text-primary"
                  data-testid="weibo-video-preview-name"
                >
                  {previewAccount.weibo_screen_name || t('settings:weiboBinding.unknownName')}
                </p>
                <p
                  className="mt-1 text-xs text-text-secondary"
                  data-testid="weibo-video-preview-uid"
                >
                  {t('settings:weiboBinding.uidLabel')}: {previewAccount.weibo_uid}
                </p>
              </div>
            </div>
            <a
              href="https://weibo.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-2 text-sm text-primary hover:underline"
              data-testid="weibo-video-switch-account-link"
            >
              <ExternalLink className="h-4 w-4" />
              {t('settings:weiboBinding.switchAccount')}
            </a>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[44px]"
            onClick={onContinueWithoutBinding}
            disabled={isBusy}
            data-testid="continue-video-upload-without-weibo-button"
          >
            {t('weiboVideoBinding.continueWithoutBinding')}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-11 min-w-[44px]"
            onClick={previewAccount ? onConfirmBind : onPreview}
            disabled={isBusy}
            data-testid={
              previewAccount ? 'confirm-video-weibo-bind-button' : 'preview-video-weibo-bind-button'
            }
          >
            {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {previewAccount ? t('weiboVideoBinding.confirmBind') : t('settings:weiboBinding.bind')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
