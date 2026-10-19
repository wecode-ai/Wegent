// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'

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

type McpAuthMode = 'url' | 'oauth'

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
  const [draftOAuthUrl, setDraftOAuthUrl] = useState('')
  const [authMode, setAuthMode] = useState<McpAuthMode>('oauth')
  const [connecting, setConnecting] = useState(false)
  const [saved, setSaved] = useState(false)
  const oauthRunRef = useRef<{ id: number; active: boolean } | null>(null)
  const oauthRunIdRef = useRef(0)
  const oauthWindowRef = useRef<Window | null>(null)

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
        setSaved(false)
        const config = await userApis.getMcpProviderService(providerId, serviceId)
        setService(config)
        setDraftUrl(config.auth_mode === 'oauth' ? '' : config.url)
        setDraftOAuthUrl(config.auth_mode === 'oauth' ? config.url : '')
        setAuthMode(
          config.oauth_supported && !config.enabled ? 'oauth' : (config.auth_mode ?? 'url')
        )
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

  useEffect(() => {
    if (open) return

    if (oauthRunRef.current) oauthRunRef.current.active = false
    oauthWindowRef.current?.close()
    oauthWindowRef.current = null
  }, [open])

  useEffect(
    () => () => {
      if (oauthRunRef.current) oauthRunRef.current.active = false
      oauthWindowRef.current?.close()
      oauthWindowRef.current = null
    },
    []
  )

  const handleSave = async () => {
    try {
      setSaving(true)
      setSaved(false)
      const updated = await userApis.updateMcpProviderService(providerId, serviceId, {
        enabled: true,
        url: authMode === 'oauth' ? draftOAuthUrl : draftUrl,
        auth_mode: authMode,
      })
      setService(updated)
      setSaved(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.services.${serviceId}.save_failed`),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleConnect = async () => {
    if (!service?.oauth_supported) return

    if (oauthRunRef.current) oauthRunRef.current.active = false
    const run = { id: ++oauthRunIdRef.current, active: true }
    oauthRunRef.current = run
    const isCurrentRun = () => oauthRunRef.current?.id === run.id
    const isActiveRun = () => isCurrentRun() && run.active
    const previous = { ...service }
    let authorizationSucceeded = false
    let session: Awaited<ReturnType<typeof userApis.createMcpProviderOAuthSession>> | null = null

    const restorePreviousConfiguration = async () => {
      if (authorizationSucceeded || !isCurrentRun()) return
      await userApis
        .updateMcpProviderService(providerId, serviceId, {
          enabled: previous.enabled,
          url: previous.url,
          auth_mode: previous.auth_mode,
        })
        .then(restored => {
          if (!isCurrentRun()) return
          setService(restored)
        })
        .catch(() => {
          toast({
            variant: 'destructive',
            title: t(`${providerId}.oauth_restore_failed`),
          })
        })
    }

    // Keep the authorization window tied to this click. The OAuth URL must be
    // persisted before session discovery, so open a placeholder immediately.
    const popup = window.open('/mcp-oauth-pending.html', '_blank')
    if (popup) popup.opener = null
    let authorizationWindow: Window | null = popup

    try {
      setConnecting(true)
      await userApis.updateMcpProviderService(providerId, serviceId, {
        enabled: false,
        url: draftOAuthUrl,
        auth_mode: 'oauth',
      })
      if (!isActiveRun()) {
        await restorePreviousConfiguration()
        return
      }

      session = await userApis.createMcpProviderOAuthSession(providerId, serviceId)
      if (!isActiveRun()) {
        await restorePreviousConfiguration()
        return
      }

      const oauthSession = session
      if (popup) {
        popup.location.replace(oauthSession.authorize_url)
      } else {
        authorizationWindow = window.open(
          oauthSession.authorize_url,
          '_blank',
          'noopener,noreferrer'
        )
      }
      oauthWindowRef.current = authorizationWindow

      const deadline = Math.min(oauthSession.expires_at * 1000, Date.now() + 10 * 60 * 1000)
      let result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, oauthSession)
      while (result.status === 'pending' && Date.now() < deadline) {
        if (!isActiveRun()) {
          result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, oauthSession)
          if (result.status === 'success') {
            authorizationSucceeded = true
            break
          }
          await restorePreviousConfiguration()
          return
        }
        if (authorizationWindow?.closed) {
          result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, oauthSession)
          break
        }
        await new Promise(resolve =>
          setTimeout(resolve, Math.max(1, oauthSession.poll_interval_seconds) * 1000)
        )
        if (!isActiveRun()) {
          result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, oauthSession)
          if (result.status === 'success') {
            authorizationSucceeded = true
            break
          }
          await restorePreviousConfiguration()
          return
        }
        result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, oauthSession)
      }
      if (result.status !== 'success') {
        throw new Error(result.error || t(`${providerId}.oauth_failed`))
      }
      authorizationSucceeded = true

      const refreshed = await userApis.getMcpProviderService(providerId, serviceId)
      if (!isActiveRun()) return
      setService(refreshed)
      setDraftOAuthUrl(refreshed.url)
      setAuthMode('oauth')
      setSaved(false)
      toast({ title: t(`${providerId}.oauth_connect_success`) })
    } catch (error) {
      authorizationWindow?.close()
      await restorePreviousConfiguration()
      if (!isActiveRun()) return
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.oauth_failed`),
      })
    } finally {
      if (isCurrentRun()) setConnecting(false)
    }
  }

  const oauthMode = authMode === 'oauth'
  const currentDraftUrl = oauthMode ? draftOAuthUrl : draftUrl
  const oauthDraftChanged =
    service?.auth_mode === 'oauth' && draftOAuthUrl.trim() !== (service.url ?? '').trim()
  const oauthConnected = Boolean(service?.oauth_connected) && !oauthDraftChanged
  const saveRequiresOAuth = oauthMode && Boolean(service?.oauth_supported) && !oauthConnected

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
              <li>{t(`${providerId}.modal.step_open_home`, { service: resolvedServiceName })}</li>
              <li>{t(`${providerId}.modal.step_get_config`)}</li>
              <li>
                {t(
                  oauthMode
                    ? `${providerId}.modal.step_copy_oauth_url`
                    : `${providerId}.modal.step_copy_url`
                )}
              </li>
              <li>
                {t(
                  oauthMode
                    ? `${providerId}.modal.step_paste_oauth_url`
                    : `${providerId}.modal.step_paste_url`
                )}
              </li>
              {oauthMode && <li>{t(`${providerId}.modal.step_connect_oauth`)}</li>}
              <li>
                {t(
                  oauthMode
                    ? `${providerId}.modal.step_save_oauth`
                    : `${providerId}.modal.step_save_url`
                )}
              </li>
            </ol>
          </div>

          {service?.oauth_supported && (
            <div className="flex gap-2" data-testid={`${providerId}-${serviceId}-auth-mode`}>
              <Button
                variant={oauthMode ? 'primary' : 'outline'}
                type="button"
                onClick={() => {
                  setAuthMode('oauth')
                  setSaved(false)
                }}
                disabled={loading || saving || connecting}
                data-testid={`${providerId}-${serviceId}-auth-mode-oauth`}
              >
                {t(`${providerId}.auth_mode_oauth`)}
              </Button>
              <Button
                variant={oauthMode ? 'outline' : 'primary'}
                type="button"
                onClick={() => {
                  setAuthMode('url')
                  setSaved(false)
                }}
                disabled={loading || saving || connecting}
                data-testid={`${providerId}-${serviceId}-auth-mode-url`}
              >
                {t(`${providerId}.auth_mode_url`)}
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${providerId}-mcp-dialog-url`}>
              {t(oauthMode ? `${providerId}.oauth_url_label` : `${providerId}.url_label`)}
            </Label>
            <Input
              id={`${providerId}-mcp-dialog-url`}
              value={currentDraftUrl}
              onChange={event => {
                if (oauthMode) {
                  setDraftOAuthUrl(event.target.value)
                } else {
                  setDraftUrl(event.target.value)
                }
                setSaved(false)
              }}
              placeholder={t(
                oauthMode ? `${providerId}.oauth_url_placeholder` : `${providerId}.url_placeholder`
              )}
              disabled={loading || saving || connecting}
              data-testid={`${providerId}-mcp-dialog-url-input`}
            />
            <p className="text-xs text-text-muted">
              {t(oauthMode ? `${providerId}.oauth_url_hint` : `${providerId}.url_hint`)}
            </p>
          </div>

          {oauthMode && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                type="button"
                onClick={handleConnect}
                disabled={
                  loading || saving || connecting || oauthConnected || !draftOAuthUrl.trim()
                }
                data-testid={`${providerId}-${serviceId}-oauth-connect`}
              >
                {connecting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t(`${providerId}.oauth_connecting`)}
                  </>
                ) : (
                  t(`${providerId}.oauth_connect`)
                )}
              </Button>
              {oauthConnected && (
                <span
                  className="flex items-center gap-1 text-xs text-emerald-600"
                  data-testid={`${providerId}-${serviceId}-oauth-connected`}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t(`${providerId}.oauth_connected`)}
                </span>
              )}
            </div>
          )}
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
            {t(`${providerId}.modal.open_home`, { service: resolvedServiceName })}
          </Button>
          <div className="flex items-center gap-3">
            {saved && (
              <span
                className="flex items-center gap-1 text-xs text-emerald-600"
                data-testid={`${providerId}-${serviceId}-save-success`}
              >
                <CheckCircle2 className="h-4 w-4" />
                {t(`${providerId}.modal.save_success`)}
              </span>
            )}
            <Button
              variant="primary"
              type="button"
              onClick={handleSave}
              disabled={loading || saving || !currentDraftUrl.trim() || saveRequiresOAuth}
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
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
