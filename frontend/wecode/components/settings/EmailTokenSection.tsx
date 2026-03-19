// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckCircleIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { mailTokenApis } from '@wecode/apis'

/**
 * Get browser client information for KMS API
 */
function getClientData(): string {
  const info = {
    source: 'wegent-web',
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
  }
  return JSON.stringify(info)
}

/**
 * Email token configuration section for the integrations settings page.
 * Allows users to configure a company mail token via automatic application or manual input.
 */
export function EmailTokenSection() {
  const { t } = useTranslation('wecode')
  const { toast } = useToast()

  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [applying, setApplying] = useState(false)
  const [clientToken, setClientToken] = useState('')
  const [showInput, setShowInput] = useState(false)

  // Load status on mount
  useEffect(() => {
    async function loadStatus() {
      try {
        const res = await mailTokenApis.getStatus()
        setConfigured(res.configured)
      } catch {
        // Silently fail - user will see unconfigured state
      } finally {
        setLoading(false)
      }
    }
    loadStatus()
  }, [])

  const handleSave = async () => {
    if (!clientToken.trim()) return
    setSaving(true)
    try {
      await mailTokenApis.save(clientToken.trim())
      setConfigured(true)
      setClientToken('')
      setShowInput(false)
      toast({ title: t('mail_token.save_success') })
    } catch {
      toast({
        variant: 'destructive',
        title: t('mail_token.save_error'),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await mailTokenApis.delete()
      setConfigured(false)
      toast({ title: t('mail_token.delete_success') })
    } catch {
      toast({
        variant: 'destructive',
        title: t('mail_token.delete_error'),
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleApply = async () => {
    setApplying(true)
    try {
      // Get client data (browser info)
      const clientData = getClientData()
      console.log('[MailToken] Client data:', clientData)

      // Call backend to apply token (backend handles JWT and KMS communication)
      const result = await mailTokenApis.applyToken(clientData)

      // Check if KMS returned success=false (whitelist failure - expected case)
      if (!result.success) {
        toast({
          variant: 'destructive',
          title: t('mail_token.apply_failed_title'),
          description: t('mail_token.apply_failed_contact_admin'),
        })
        return
      }

      if (!result.token_a) {
        throw new Error('Response missing token_a')
      }

      const token = result.token_a

      // Auto-fill the token and show input
      setClientToken(token)
      setShowInput(true)

      toast({ title: t('mail_token.apply_success') })
    } catch (error) {
      console.error('[MailToken] Apply failed:', error)
      toast({
        variant: 'destructive',
        title: t('mail_token.apply_error'),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return null
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-medium text-text-primary mb-1">{t('mail_token.title')}</h3>
        <p className="text-xs text-text-muted mb-1">{t('mail_token.description')}</p>
      </div>

      <div className="bg-base border border-border rounded-md p-4 space-y-3">
        {configured && !showInput ? (
          // Configured state
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="w-5 h-5 text-primary" />
              <span className="text-sm text-text-primary">{t('mail_token.configured')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowInput(true)}
                data-testid="reconfigure-mail-token-button"
              >
                {t('mail_token.reconfigure')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 w-8 hover:text-error"
                data-testid="delete-mail-token-button"
              >
                <TrashIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ) : showInput ? (
          // Input state (after apply or manual reconfigure)
          <div className="space-y-3">
            <div>
              <Input
                value={clientToken}
                onChange={e => setClientToken(e.target.value)}
                placeholder={t('mail_token.input_placeholder')}
                data-testid="mail-token-input"
              />
              <p className="text-xs text-text-muted mt-1">{t('mail_token.input_hint')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving || !clientToken.trim()}
                data-testid="save-mail-token-button"
              >
                {saving ? t('mail_token.saving') : t('mail_token.save')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowInput(false)
                  setClientToken('')
                }}
                data-testid="cancel-mail-token-button"
              >
                {t('mail_token.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          // Unconfigured state - show apply button
          <div className="space-y-3">
            <Button
              variant="primary"
              onClick={handleApply}
              disabled={applying}
              data-testid="apply-mail-token-button"
            >
              {applying ? t('mail_token.applying') : t('mail_token.apply')}
            </Button>
            <p className="text-xs text-text-muted">{t('mail_token.apply_hint')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
