// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'

import { userApis } from '@/apis/user'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface McpProviderConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  serviceId?: string
}

export function McpProviderConfigDialog({
  open,
  onOpenChange,
  providerId,
  serviceId = 'docs',
}: McpProviderConfigDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [service, setService] = useState<Awaited<
    ReturnType<typeof userApis.getMcpProviderService>
  > | null>(null)
  const [draftUrl, setDraftUrl] = useState('')

  const resolvedServiceName = useMemo(() => {
    const translated = t(`${providerId}.services.${serviceId}.default_name`)
    return translated === `${providerId}.services.${serviceId}.default_name`
      ? serviceId
      : translated
  }, [providerId, serviceId, t])

  const detailUrl = useMemo(
    () => service?.detail_url || 'https://mcp.dingtalk.com/#/',
    [service?.detail_url]
  )

  useEffect(() => {
    if (!open) return

    const loadConfig = async () => {
      try {
        setLoading(true)
        const config = await userApis.getMcpProviderService(providerId, serviceId)
        setService(config)
        setDraftUrl(config.url)
      } catch {
        toast({
          variant: 'destructive',
          title: t(`${providerId}.load_failed`),
        })
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [open, providerId, serviceId, toast, t])

  const handleSave = async () => {
    try {
      setSaving(true)
      await userApis.updateMcpProviderService(providerId, serviceId, {
        enabled: true,
        url: draftUrl,
      })

      toast({
        title: t(`${providerId}.modal.save_success`),
      })
      onOpenChange(false)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.services.${serviceId}.save_failed`),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`${providerId}.modal.title`)}</DialogTitle>
          <DialogDescription>
            {t(`${providerId}.modal.description`, { service: resolvedServiceName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-surface px-4 py-3">
            <p className="text-sm text-text-secondary">{t(`${providerId}.modal.steps_intro`)}</p>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-text-primary">
              <li>{t(`${providerId}.modal.step_open_home`)}</li>
              <li>
                {t(`${providerId}.modal.step_choose_service`, { service: resolvedServiceName })}
              </li>
              <li>{t(`${providerId}.modal.step_get_config`)}</li>
              <li>{t(`${providerId}.modal.step_confirm`)}</li>
              <li>{t(`${providerId}.modal.step_copy_url`)}</li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${providerId}-mcp-dialog-url`}>{t(`${providerId}.url_label`)}</Label>
            <Input
              id={`${providerId}-mcp-dialog-url`}
              value={draftUrl}
              onChange={event => setDraftUrl(event.target.value)}
              placeholder={t(`${providerId}.url_placeholder`)}
              disabled={loading || saving}
              data-testid={`${providerId}-mcp-dialog-url-input`}
            />
            <p className="text-xs text-text-muted">{t(`${providerId}.url_hint`)}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            type="button"
            onClick={() => window.open(detailUrl, '_blank', 'noopener,noreferrer')}
            disabled={loading || saving}
            data-testid={`open-${providerId}-mcp-home-button`}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {t(`${providerId}.modal.open_home`)}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={loading || saving || !draftUrl.trim()}
            data-testid={`save-${providerId}-mcp-dialog-button`}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t(`${providerId}.saving`)}
              </>
            ) : (
              t(`${providerId}.modal.save`)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
