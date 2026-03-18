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
 * Email token configuration section for the integrations settings page.
 * Allows users to configure a company mail token via DingTalk bot client_token exchange.
 */
export function EmailTokenSection() {
  const { t } = useTranslation('wecode')
  const { toast } = useToast()

  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
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

  if (loading) {
    return null
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('mail_token.title')}</h2>
        <p className="text-sm text-text-muted mb-1">{t('mail_token.description')}</p>
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
        ) : (
          // Input state
          <div className="space-y-3">
            <div>
              <Input
                value={clientToken}
                onChange={e => setClientToken(e.target.value)}
                placeholder={t('mail_token.input_placeholder')}
                type="password"
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
              {configured && (
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
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
