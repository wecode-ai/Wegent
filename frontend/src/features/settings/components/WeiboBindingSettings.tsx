// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, Loader2, Link2, Unlink } from 'lucide-react'

import { ApiError } from '@/apis/client'
import type { WeiboAccountPreviewResponse } from '@/apis/user'
import { userApis } from '@/apis/user'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUser } from '@/features/common/UserContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export function WeiboBindingSettings() {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const { user, refresh } = useUser()
  const [isBinding, setIsBinding] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const [isUnbinding, setIsUnbinding] = useState(false)
  const [isUnbindDialogOpen, setIsUnbindDialogOpen] = useState(false)
  const [previewAccount, setPreviewAccount] = useState<WeiboAccountPreviewResponse | null>(null)

  const isBound = Boolean(user?.weibo_uid)
  const boundAt = useMemo(() => {
    if (!user?.weibo_bound_at) return null
    const date = new Date(user.weibo_bound_at)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString()
  }, [user?.weibo_bound_at])

  const showBindErrorToast = (error: unknown) => {
    const errorCode = error instanceof ApiError ? error.errorCode : undefined
    const title =
      errorCode === 'weibo_sub_missing'
        ? t('weiboBinding.subMissing')
        : errorCode === 'weibo_uid_changed'
          ? t('weiboBinding.accountChanged')
          : t('weiboBinding.bindFailed')
    toast({ variant: 'destructive', title })
  }

  const handlePreview = async () => {
    setIsBinding(true)
    try {
      const preview = await userApis.previewWeiboAccount()
      setPreviewAccount(preview)
    } catch (error) {
      showBindErrorToast(error)
    } finally {
      setIsBinding(false)
    }
  }

  const handleConfirmBind = async () => {
    if (!previewAccount) return
    setIsConfirming(true)
    try {
      await userApis.bindWeiboAccount(previewAccount.weibo_uid)
      await refresh()
      setPreviewAccount(null)
      toast({ title: t('weiboBinding.bindSuccess') })
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === 'weibo_uid_changed') {
        setPreviewAccount(null)
      }
      showBindErrorToast(error)
    } finally {
      setIsConfirming(false)
    }
  }

  const handleUnbind = async () => {
    setIsUnbinding(true)
    try {
      await userApis.unbindWeiboAccount()
      await refresh()
      setIsUnbindDialogOpen(false)
      toast({ title: t('weiboBinding.unbindSuccess') })
    } catch {
      toast({ variant: 'destructive', title: t('weiboBinding.unbindFailed') })
    } finally {
      setIsUnbinding(false)
    }
  }

  const isBusy = isBinding || isConfirming || isUnbinding

  return (
    <>
      <div className="p-4 bg-base border border-border rounded-lg" data-testid="weibo-binding-card">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-text-primary">{t('weiboBinding.title')}</h3>
            <p className="mt-1 text-xs text-text-muted">
              {isBound ? t('weiboBinding.boundDescription') : t('weiboBinding.description')}
            </p>
            {isBound && (
              <div className="mt-3 flex items-center gap-3 text-xs text-text-secondary">
                {user?.weibo_avatar_url && (
                  <div
                    role="img"
                    aria-label={t('weiboBinding.avatarAlt')}
                    style={{ backgroundImage: `url("${user.weibo_avatar_url}")` }}
                    className="h-10 w-10 shrink-0 rounded-full border border-border bg-cover bg-center"
                    data-testid="weibo-binding-avatar"
                  />
                )}
                <div className="min-w-0 space-y-1">
                  {user?.weibo_screen_name && (
                    <p
                      className="truncate font-medium text-text-primary"
                      data-testid="weibo-binding-name"
                    >
                      {user.weibo_screen_name}
                    </p>
                  )}
                  <p data-testid="weibo-binding-uid">
                    {t('weiboBinding.uidLabel')}: {user?.weibo_uid}
                  </p>
                  {boundAt && (
                    <p data-testid="weibo-binding-bound-at">
                      {t('weiboBinding.boundAtLabel')}: {boundAt}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row md:justify-end">
            <Button
              type="button"
              variant={isBound ? 'outline' : 'primary'}
              className="h-11 min-w-[44px]"
              onClick={handlePreview}
              disabled={isBusy}
              data-testid="bind-weibo-button"
            >
              {isBinding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              {isBound ? t('weiboBinding.rebind') : t('weiboBinding.bind')}
            </Button>
            {isBound && (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[44px]"
                onClick={() => setIsUnbindDialogOpen(true)}
                disabled={isBusy}
                data-testid="unbind-weibo-button"
              >
                {isUnbinding ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Unlink className="mr-2 h-4 w-4" />
                )}
                {t('weiboBinding.unbind')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(previewAccount)}
        onOpenChange={open => !open && setPreviewAccount(null)}
      >
        <DialogContent data-testid="weibo-binding-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t('weiboBinding.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('weiboBinding.confirmDescription')}</DialogDescription>
          </DialogHeader>
          {previewAccount && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
                {previewAccount.weibo_avatar_url ? (
                  <div
                    role="img"
                    aria-label={t('weiboBinding.avatarAlt')}
                    style={{ backgroundImage: `url("${previewAccount.weibo_avatar_url}")` }}
                    className="h-12 w-12 shrink-0 rounded-full border border-border bg-cover bg-center"
                    data-testid="weibo-preview-avatar"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-base text-sm text-text-muted">
                    {t('weiboBinding.avatarFallback')}
                  </div>
                )}
                <div className="min-w-0 text-sm">
                  <p
                    className="truncate font-medium text-text-primary"
                    data-testid="weibo-preview-name"
                  >
                    {previewAccount.weibo_screen_name || t('weiboBinding.unknownName')}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary" data-testid="weibo-preview-uid">
                    {t('weiboBinding.uidLabel')}: {previewAccount.weibo_uid}
                  </p>
                </div>
              </div>
              <a
                href="https://weibo.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 text-sm text-primary hover:underline"
                data-testid="switch-weibo-account-link"
              >
                <ExternalLink className="h-4 w-4" />
                {t('weiboBinding.switchAccount')}
              </a>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11 min-w-[44px]"
              onClick={() => setPreviewAccount(null)}
              disabled={isConfirming}
              data-testid="cancel-weibo-bind-button"
            >
              {t('weiboBinding.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="h-11 min-w-[44px]"
              onClick={handleConfirmBind}
              disabled={isConfirming}
              data-testid="confirm-weibo-bind-button"
            >
              {isConfirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('weiboBinding.confirmBind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isUnbindDialogOpen}
        onOpenChange={open => !isUnbinding && setIsUnbindDialogOpen(open)}
      >
        <AlertDialogContent data-testid="weibo-unbind-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('weiboBinding.unbindConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('weiboBinding.unbindConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnbinding}>{t('weiboBinding.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUnbind}
              disabled={isUnbinding}
              data-testid="confirm-weibo-unbind-button"
            >
              {isUnbinding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('weiboBinding.confirmUnbind')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default WeiboBindingSettings
