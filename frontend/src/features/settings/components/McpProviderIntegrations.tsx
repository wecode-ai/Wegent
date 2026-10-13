// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'

import { userApis, type McpProviderServiceConfig } from '@/apis/user'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

type EditableService = McpProviderServiceConfig & {
  draftUrl: string
  draftAuthMode: 'url' | 'oauth'
  connecting: boolean
}

function McpProviderServiceCard({
  providerId,
  service,
  loading,
  onToggle,
  onUrlChange,
  onAuthModeChange,
  onConnect,
  onDisconnect,
  onSave,
}: {
  providerId: string
  service: EditableService
  loading: boolean
  onToggle: (serviceId: string, enabled: boolean) => void
  onUrlChange: (serviceId: string, value: string) => void
  onAuthModeChange: (serviceId: string, mode: 'url' | 'oauth') => void
  onConnect: (serviceId: string) => void
  onDisconnect: (serviceId: string) => void
  onSave: (serviceId: string) => void
}) {
  const { t } = useTranslation('common')
  const baseKey = `${providerId}.services.${service.service_id}`
  const oauthMode = service.draftAuthMode === 'oauth'

  return (
    <div className="space-y-3 rounded-md border border-border bg-base p-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-text-primary">{t(`${baseKey}.title`)}</h3>
        <p className="text-sm text-text-muted">{t(`${baseKey}.description`)}</p>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border/70 bg-surface px-3 py-2.5">
        <div className="space-y-0.5 pr-4">
          <Label
            htmlFor={`${providerId}-${service.service_id}-enabled`}
            className="text-sm font-medium"
          >
            {t(`${baseKey}.enable_label`)}
          </Label>
          <p className="text-xs text-text-muted">{t(`${baseKey}.enable_hint`)}</p>
        </div>
        <Switch
          id={`${providerId}-${service.service_id}-enabled`}
          checked={service.enabled}
          onCheckedChange={checked => onToggle(service.service_id, checked)}
          disabled={loading}
          data-testid={`toggle-${providerId}-${service.service_id}-switch`}
        />
      </div>

      {service.enabled && (
        <>
          {service.oauth_supported && (
            <div className="space-y-1.5">
              <Label>{t(`${providerId}.auth_mode_label`)}</Label>
              <div
                className="flex gap-2"
                data-testid={`${providerId}-${service.service_id}-auth-mode`}
              >
                <Button
                  variant={oauthMode ? 'outline' : 'primary'}
                  type="button"
                  onClick={() => onAuthModeChange(service.service_id, 'url')}
                  disabled={loading || service.connecting}
                  data-testid={`${providerId}-${service.service_id}-auth-mode-url`}
                >
                  {t(`${providerId}.auth_mode_url`)}
                </Button>
                <Button
                  variant={oauthMode ? 'primary' : 'outline'}
                  type="button"
                  onClick={() => onAuthModeChange(service.service_id, 'oauth')}
                  disabled={loading || service.connecting}
                  data-testid={`${providerId}-${service.service_id}-auth-mode-oauth`}
                >
                  {t(`${providerId}.auth_mode_oauth`)}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${providerId}-${service.service_id}-url`}>
              {oauthMode ? t(`${providerId}.oauth_url_label`) : t(`${providerId}.url_label`)}
            </Label>
            <Input
              id={`${providerId}-${service.service_id}-url`}
              value={service.draftUrl}
              onChange={event => onUrlChange(service.service_id, event.target.value)}
              placeholder={t(`${providerId}.url_placeholder`)}
              disabled={loading || service.connecting}
              data-testid={`${providerId}-${service.service_id}-url-input`}
            />
            <p className="text-xs text-text-muted">
              {oauthMode ? t(`${providerId}.oauth_url_hint`) : t(`${providerId}.url_hint`)}
            </p>
          </div>

          {oauthMode && (
            <div className="space-y-2">
              {service.oauth_connected ? (
                <p
                  className="text-xs text-text-muted"
                  data-testid={`${providerId}-${service.service_id}-oauth-status`}
                >
                  {t(`${providerId}.oauth_connected`)}
                  {service.oauth_account ? ` · ${service.oauth_account}` : ''}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => onConnect(service.service_id)}
                  disabled={loading || service.connecting || !service.draftUrl.trim()}
                  data-testid={`${providerId}-${service.service_id}-oauth-connect`}
                >
                  {service.connecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t(`${providerId}.oauth_connecting`)}
                    </>
                  ) : (
                    t(`${providerId}.oauth_connect`)
                  )}
                </Button>
                {service.oauth_connected ? (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => onDisconnect(service.service_id)}
                    disabled={loading || service.connecting}
                    data-testid={`${providerId}-${service.service_id}-oauth-disconnect`}
                  >
                    {t(`${providerId}.oauth_disconnect`)}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="outline"
          type="button"
          onClick={() => window.open(service.detail_url, '_blank', 'noopener,noreferrer')}
          disabled={loading}
          data-testid={`open-${providerId}-${service.service_id}-link-button`}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          {t(`${providerId}.open_link`)}
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => onSave(service.service_id)}
          disabled={loading || (service.enabled && !service.draftUrl.trim())}
          data-testid={`save-${providerId}-${service.service_id}-button`}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t(`${providerId}.saving`)}
            </>
          ) : (
            t(`${providerId}.save`)
          )}
        </Button>
      </div>
    </div>
  )
}

type McpAuthMode = 'url' | 'oauth'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default function McpProviderIntegrations({ providerId }: { providerId: string }) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [savingServiceId, setSavingServiceId] = useState<string | null>(null)
  const [services, setServices] = useState<EditableService[]>([])

  useEffect(() => {
    const loadServices = async () => {
      try {
        setLoading(true)
        const configs = await userApis.getMcpProviderServices(providerId)
        setServices(
          configs.map(service => ({
            ...service,
            draftUrl: service.url,
            draftAuthMode: service.auth_mode ?? 'url',
            connecting: false,
          }))
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

    loadServices()
  }, [providerId, toast, t])

  const updateServiceState = (
    serviceId: string,
    updater: (service: EditableService) => EditableService
  ) => {
    setServices(current =>
      current.map(service => (service.service_id === serviceId ? updater(service) : service))
    )
  }

  const handleToggle = (serviceId: string, enabled: boolean) => {
    updateServiceState(serviceId, service => ({ ...service, enabled }))
  }

  const handleUrlChange = (serviceId: string, draftUrl: string) => {
    updateServiceState(serviceId, service => ({ ...service, draftUrl }))
  }

  const handleAuthModeChange = (serviceId: string, mode: McpAuthMode) => {
    updateServiceState(serviceId, service => ({ ...service, draftAuthMode: mode }))
  }

  const handleSave = async (serviceId: string) => {
    const current = services.find(service => service.service_id === serviceId)
    if (!current) return

    try {
      setSavingServiceId(serviceId)
      const saved = await userApis.updateMcpProviderService(providerId, serviceId, {
        enabled: current.enabled,
        url: current.draftUrl,
        auth_mode: current.draftAuthMode,
      })

      updateServiceState(serviceId, () => ({
        ...saved,
        draftUrl: saved.url,
        draftAuthMode: saved.auth_mode ?? 'url',
        connecting: false,
      }))
      toast({
        title: t(`${providerId}.services.${serviceId}.save_success`),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.services.${serviceId}.save_failed`),
      })
    } finally {
      setSavingServiceId(null)
    }
  }

  const handleConnect = async (serviceId: string) => {
    const current = services.find(service => service.service_id === serviceId)
    if (!current) return

    // Open the window while the click is still a user activation; the session
    // request performs discovery and client registration before we know the URL.
    const popup = window.open('', '_blank')
    if (popup) popup.opener = null

    updateServiceState(serviceId, service => ({ ...service, connecting: true }))
    try {
      // The backend discovers metadata from the resource URL, so persist the
      // OAuth resource and the mode before starting the session.
      const saved = await userApis.updateMcpProviderService(providerId, serviceId, {
        enabled: true,
        url: current.draftUrl,
        auth_mode: 'oauth',
      })
      const session = await userApis.createMcpProviderOAuthSession(providerId, serviceId)
      if (popup) {
        popup.location.replace(session.authorize_url)
      } else {
        window.open(session.authorize_url, '_blank', 'noopener,noreferrer')
      }

      const deadline = Math.min(session.expires_at * 1000, Date.now() + 10 * 60 * 1000)
      let result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, session)
      while (result.status === 'pending' && Date.now() < deadline) {
        await sleep(Math.max(1, session.poll_interval_seconds) * 1000)
        result = await userApis.pollMcpProviderOAuthSession(providerId, serviceId, session)
      }
      if (result.status !== 'success') {
        throw new Error(result.error || t(`${providerId}.oauth_failed`))
      }

      const refreshed = await userApis.getMcpProviderService(providerId, serviceId)
      updateServiceState(serviceId, () => ({
        ...refreshed,
        draftUrl: refreshed.url || saved.url,
        draftAuthMode: refreshed.auth_mode ?? 'oauth',
        connecting: false,
      }))
      toast({ title: t(`${providerId}.oauth_connect_success`) })
    } catch (error) {
      popup?.close()
      updateServiceState(serviceId, service => ({ ...service, connecting: false }))
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.oauth_failed`),
      })
    }
  }

  const handleDisconnect = async (serviceId: string) => {
    try {
      await userApis.disconnectMcpProviderOAuth(providerId, serviceId)
      updateServiceState(serviceId, service => ({
        ...service,
        oauth_connected: false,
        oauth_account: null,
        oauth_expires_at: null,
      }))
      toast({ title: t(`${providerId}.oauth_disconnect_success`) })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t(`${providerId}.oauth_disconnect_failed`),
      })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-base p-4 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t(`${providerId}.loading`)}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {services.map(service => (
        <McpProviderServiceCard
          key={service.service_id}
          providerId={providerId}
          service={service}
          loading={savingServiceId === service.service_id}
          onToggle={handleToggle}
          onUrlChange={handleUrlChange}
          onAuthModeChange={handleAuthModeChange}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onSave={handleSave}
        />
      ))}
    </div>
  )
}
