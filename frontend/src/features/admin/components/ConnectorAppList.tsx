// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Cable, Loader2, Pencil, Play, Plus, Power, PowerOff, Search } from 'lucide-react'
import { adminApis } from '@/apis/admin'
import { ApiError } from '@/apis/client'
import type {
  AdminConnectorApp,
  AdminConnectorAppCreate,
  ConnectorAuthType,
  ConnectorHttpToolDefinition,
  ConnectorToolLoadingMode,
  ConnectorTransport,
  ConnectorVisibility,
} from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tag } from '@/components/ui/tag'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  authorizeConnectorApp,
  CONNECTOR_AUTHORIZATION_CHANGED_EVENT,
  ConnectorOAuthError,
} from '@/features/settings/connectorOAuth'
import { matchesConnectorAppQuery } from '@/features/settings/connectorAppSearch'

interface ConnectorForm {
  slug: string
  name: string
  description: string
  iconUrl: string
  enabled: boolean
  visibility: ConnectorVisibility
  allowedRoles: string
  authType: ConnectorAuthType
  oauthScope: string
  transport: ConnectorTransport
  mcpUrl: string
  toolLoadingMode: ConnectorToolLoadingMode
  keywords: string
  providerHeaders: string
  clearProviderHeaders: boolean
  toolAllowlist: string
  httpTools: string
}

const EMPTY_FORM: ConnectorForm = {
  slug: '',
  name: '',
  description: '',
  iconUrl: '',
  enabled: true,
  visibility: 'all',
  allowedRoles: '',
  authType: 'oauth2',
  oauthScope: '',
  transport: 'streamable-http',
  mcpUrl: '',
  toolLoadingMode: 'lazy',
  keywords: '',
  providerHeaders: '',
  clearProviderHeaders: false,
  toolAllowlist: '',
  httpTools: '',
}

function lines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

function normalizeConnectorSlug(value: string): string {
  return value.trim().toLowerCase()
}

function defaultConnectorKeywords(name: string, slug: string): string {
  const displayName = name.trim()
  const slugWords = normalizeConnectorSlug(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...new Set([displayName, slugWords].filter(Boolean))].join('\n')
}

function normalizeToolLoadingMode(value?: string): ConnectorToolLoadingMode {
  return value === 'lazy' || value === 'skill' ? 'lazy' : 'static'
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const value = (item as { text?: unknown }).text
      return typeof value === 'string' ? value : null
    })
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

function formFromApp(app: AdminConnectorApp): ConnectorForm {
  return {
    slug: app.slug,
    name: app.name,
    description: app.description,
    iconUrl: app.icon_url ?? '',
    enabled: app.enabled,
    visibility: app.visibility,
    allowedRoles: app.allowed_roles.join('\n'),
    authType: app.auth_type,
    oauthScope: app.oauth_scope ?? '',
    transport: app.transport,
    mcpUrl: app.mcp_url,
    toolLoadingMode: normalizeToolLoadingMode(app.tool_loading_mode),
    keywords: (app.keywords ?? []).join('\n'),
    providerHeaders: '',
    clearProviderHeaders: false,
    toolAllowlist: app.tool_allowlist.join('\n'),
    httpTools: app.http_tools.length ? JSON.stringify(app.http_tools, null, 2) : '',
  }
}

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('provider_headers_invalid')
  }
  if (Object.values(parsed).some(item => typeof item !== 'string')) {
    throw new Error('provider_headers_invalid')
  }
  return parsed as Record<string, string>
}

function parseHttpTools(value: string): ConnectorHttpToolDefinition[] {
  if (!value.trim()) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object')) {
    throw new Error('http_tools_invalid')
  }
  return parsed as ConnectorHttpToolDefinition[]
}

function payloadFromForm(form: ConnectorForm): AdminConnectorAppCreate {
  return {
    slug: normalizeConnectorSlug(form.slug),
    name: form.name.trim(),
    description: form.description.trim(),
    icon_url: form.iconUrl.trim() || null,
    enabled: form.enabled,
    visibility: form.visibility,
    allowed_roles: lines(form.allowedRoles),
    auth_type: form.authType,
    oauth_scope: form.authType === 'oauth2' ? form.oauthScope.trim() || null : null,
    transport: form.transport,
    mcp_url: form.mcpUrl.trim(),
    tool_loading_mode: normalizeToolLoadingMode(form.toolLoadingMode),
    keywords: lines(form.keywords),
    provider_headers: parseHeaders(form.providerHeaders) ?? {},
    tool_allowlist: lines(form.toolAllowlist),
    http_tools: parseHttpTools(form.httpTools),
  }
}

export default function ConnectorAppList() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [apps, setApps] = useState<AdminConnectorApp[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [discoveringId, setDiscoveringId] = useState<number | null>(null)
  const [testingId, setTestingId] = useState<number | null>(null)
  const [deletingAppId, setDeletingAppId] = useState<number | null>(null)
  const [togglingAppId, setTogglingAppId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminConnectorApp | null>(null)
  const [deleteStep, setDeleteStep] = useState<'warning' | 'confirm' | null>(null)
  const [authorizingAppId, setAuthorizingAppId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [connectionStatusBySlug, setConnectionStatusBySlug] = useState<Record<string, string>>({})
  const [connectionStatusKnown, setConnectionStatusKnown] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AdminConnectorApp | null>(null)
  const [form, setForm] = useState<ConnectorForm>(EMPTY_FORM)

  const visibleApps = apps.filter(app => matchesConnectorAppQuery(app, searchQuery))

  const loadApps = useCallback(async () => {
    setLoading(true)
    try {
      const adminApps = await adminApis.getConnectorApps()
      setApps(adminApps)
      try {
        // The user projection only drives the authorize button; a failure there
        // must not hide the catalog or reset every status to "unauthorized".
        const userApps = await adminApis.getUserConnectorApps()
        setConnectionStatusBySlug(
          Object.fromEntries(userApps.map(app => [app.slug, app.connection.status]))
        )
        setConnectionStatusKnown(true)
      } catch {
        // Keep the last known connection statuses. Without a projection the
        // status is unknown, so the authorize action stays hidden instead of
        // claiming every app is unauthorized.
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.load_failed'),
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void loadApps()
  }, [loadApps])

  useEffect(() => {
    const refresh = () => void loadApps()
    window.addEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
  }, [loadApps])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (app: AdminConnectorApp) => {
    setEditing(app)
    setForm(formFromApp(app))
    setDialogOpen(true)
  }

  const save = async () => {
    let httpToolsMissing = false
    try {
      httpToolsMissing = form.transport === 'http' && parseHttpTools(form.httpTools).length === 0
    } catch {
      toast({ variant: 'destructive', title: t('connector_apps.errors.http_tools_invalid') })
      return
    }
    const normalizedSlug = normalizeConnectorSlug(form.slug)
    if (!CONNECTOR_SLUG_PATTERN.test(normalizedSlug)) {
      toast({ variant: 'destructive', title: t('connector_apps.errors.slug_invalid') })
      return
    }
    if (
      !normalizedSlug ||
      !form.name.trim() ||
      !form.mcpUrl.trim() ||
      (form.visibility === 'roles' && lines(form.allowedRoles).length === 0) ||
      httpToolsMissing
    ) {
      toast({ variant: 'destructive', title: t('connector_apps.errors.required') })
      return
    }
    setSaving(true)
    try {
      const payload = payloadFromForm(form)
      if (editing) {
        const { slug: _slug, provider_headers: _headers, ...update } = payload
        const headers = parseHeaders(form.providerHeaders)
        await adminApis.updateConnectorApp(editing.id, {
          ...update,
          ...(headers !== undefined ? { provider_headers: headers } : {}),
          clear_provider_headers: form.clearProviderHeaders,
        })
      } else {
        await adminApis.createConnectorApp(payload)
      }
      toast({ title: t('connector_apps.success.saved') })
      setDialogOpen(false)
      await loadApps()
    } catch (error) {
      const invalidHeaders = (error as Error).message === 'provider_headers_invalid'
      const invalidHttpTools = (error as Error).message === 'http_tools_invalid'
      toast({
        variant: 'destructive',
        title: t(
          invalidHeaders
            ? 'connector_apps.errors.provider_headers_invalid'
            : invalidHttpTools
              ? 'connector_apps.errors.http_tools_invalid'
              : 'connector_apps.errors.save_failed'
        ),
        description: invalidHeaders || invalidHttpTools ? undefined : (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const deleteConnectorApp = async () => {
    const app = deleteTarget
    if (!app) return
    setDeletingAppId(app.id)
    try {
      await adminApis.deleteConnectorApp(app.id)
      toast({ title: t('connector_apps.success.app_deleted') })
      setDeleteTarget(null)
      setDeleteStep(null)
      await loadApps()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setDeletingAppId(null)
    }
  }

  const requestDelete = (app: AdminConnectorApp) => {
    setDeleteTarget(app)
    setDeleteStep('warning')
  }

  const closeDeleteDialog = () => {
    if (deletingAppId !== null) return
    setDeleteTarget(null)
    setDeleteStep(null)
  }

  const toggleAppEnabled = async (app: AdminConnectorApp) => {
    setTogglingAppId(app.id)
    try {
      await adminApis.updateConnectorApp(app.id, { enabled: !app.enabled })
      toast({
        title: t(
          app.enabled ? 'connector_apps.success.disabled' : 'connector_apps.success.enabled'
        ),
      })
      await loadApps()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t(
          app.enabled
            ? 'connector_apps.errors.disable_failed'
            : 'connector_apps.errors.enable_failed'
        ),
        description: (error as Error).message,
      })
    } finally {
      setTogglingAppId(null)
    }
  }

  const authorizeConnector = async (app: AdminConnectorApp) => {
    setAuthorizingAppId(app.id)
    try {
      await authorizeConnectorApp(app.slug)
      toast({ title: t('connector_apps.success.authorized') })
    } catch (error) {
      const code = error instanceof ConnectorOAuthError ? error.code : null
      const messageKey = {
        popup_blocked: 'connector_apps.errors.authorization_popup_blocked',
        declined: 'connector_apps.errors.authorization_declined',
        timeout: 'connector_apps.errors.authorization_timeout',
        failed: 'connector_apps.errors.authorization_failed',
      }[code ?? 'failed']
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.authorization_failed'),
        description: messageKey
          ? t(messageKey)
          : error instanceof Error
            ? error.message
            : String(error),
      })
    } finally {
      setAuthorizingAppId(null)
    }
  }

  const discoverTools = async (app: AdminConnectorApp) => {
    setDiscoveringId(app.id)
    try {
      const response = await adminApis.discoverConnectorAppTools(app.id)
      toast({
        title: t('connector_apps.success.discovered', { count: response.tools.length }),
        description: response.tools.map(tool => tool.raw_tool_name).join(', ') || undefined,
      })
    } catch (error) {
      const authRequired = error instanceof ApiError && error.status === 401
      toast({
        variant: 'destructive',
        title: authRequired
          ? t('connector_apps.errors.authorization_required')
          : t('connector_apps.errors.discover_failed'),
        description: (error as Error).message,
      })
    } finally {
      setDiscoveringId(null)
    }
  }

  const testTool = async (app: AdminConnectorApp) => {
    setTestingId(app.id)
    let toolName = app.tool_allowlist[0] || app.http_tools[0]?.name
    try {
      if (!toolName) {
        const discovered = await adminApis.discoverConnectorAppTools(app.id)
        // Prefer a tool without required arguments so an empty test call can succeed
        const candidate =
          discovered.tools.find(tool => {
            const required = tool.input_schema?.required
            return !Array.isArray(required) || required.length === 0
          }) ?? discovered.tools[0]
        toolName = candidate?.raw_tool_name || candidate?.name
      }
      if (!toolName) {
        toast({ variant: 'destructive', title: t('connector_apps.errors.no_test_tool') })
        return
      }
      const response = await adminApis.testConnectorAppTool(app.id, toolName)
      const resultText = toolResultText(response.content)
      // Some MCP servers report failures inside the payload instead of isError
      const payloadFailed = (() => {
        if (!resultText) return false
        try {
          const parsed = JSON.parse(resultText) as { status?: unknown }
          return parsed?.status === 'error'
        } catch {
          return false
        }
      })()
      const failed = response.is_error || payloadFailed
      toast({
        variant: failed ? 'destructive' : undefined,
        title: failed
          ? t('connector_apps.errors.test_returned_error', { name: toolName })
          : t('connector_apps.success.tested'),
        description: resultText,
      })
    } catch (error) {
      const authRequired = error instanceof ApiError && error.status === 401
      toast({
        variant: 'destructive',
        title: authRequired
          ? t('connector_apps.errors.authorization_required')
          : t('connector_apps.errors.test_failed', { name: toolName ?? '' }),
        description: (error as Error).message,
      })
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="connector-app-admin-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('connector_apps.title')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t('connector_apps.description')}</p>
        </div>
        <Button variant="primary" onClick={openCreate} data-testid="create-connector-app-button">
          <Plus className="mr-2 h-4 w-4" />
          {t('connector_apps.create')}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center">
          <Cable className="mx-auto mb-3 h-10 w-10 text-text-muted" />
          <p className="text-sm text-text-muted">{t('connector_apps.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('connector_apps.search_placeholder')}
              className="pl-9"
              data-testid="search-connector-apps"
            />
          </div>
          {visibleApps.length === 0 ? (
            <div
              className="rounded-lg border border-dashed border-border py-10 text-center"
              data-testid="connector-apps-search-empty"
            >
              <p className="text-sm text-text-muted">{t('connector_apps.search_empty')}</p>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleApps.map(app => (
                <Card key={app.id} className="p-4" data-testid={`connector-app-card-${app.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-medium text-text-primary">{app.name}</h3>
                        <Tag variant={app.enabled ? 'success' : 'default'}>
                          {t(app.enabled ? 'connector_apps.enabled' : 'connector_apps.disabled')}
                        </Tag>
                        <Tag variant="info">{t(`connector_apps.auth.${app.auth_type}`)}</Tag>
                      </div>
                      <p className="mt-1 break-all text-xs text-text-muted">
                        {app.slug} · {app.mcp_url}
                      </p>
                      {app.description ? (
                        <p className="mt-2 line-clamp-2 text-sm text-text-secondary">
                          {app.description}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-text-muted">
                        {t('connector_apps.connections', { count: app.connection_count })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <TooltipProvider delayDuration={200}>
                        {app.enabled ? (
                          <>
                            <IconActionButton
                              label={t('connector_apps.discover_tools')}
                              onClick={() => void discoverTools(app)}
                              disabled={discoveringId === app.id}
                              testId={`discover-connector-app-tools-${app.id}`}
                            >
                              {discoveringId === app.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Search className="h-4 w-4" />
                              )}
                            </IconActionButton>
                            <IconActionButton
                              label={t('connector_apps.test_tool')}
                              onClick={() => void testTool(app)}
                              disabled={testingId === app.id}
                              testId={`test-connector-app-tool-${app.id}`}
                            >
                              {testingId === app.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </IconActionButton>
                          </>
                        ) : null}
                        <IconActionButton
                          label={t('connector_apps.edit')}
                          onClick={() => openEdit(app)}
                          testId={`edit-connector-app-${app.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </IconActionButton>
                        <IconActionButton
                          label={t(
                            app.enabled ? 'connector_apps.disable' : 'connector_apps.enable'
                          )}
                          onClick={() => void toggleAppEnabled(app)}
                          disabled={togglingAppId === app.id}
                          testId={`toggle-connector-app-${app.id}`}
                          danger={app.enabled}
                        >
                          {togglingAppId === app.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : app.enabled ? (
                            <PowerOff className="h-4 w-4" />
                          ) : (
                            <Power className="h-4 w-4" />
                          )}
                        </IconActionButton>
                      </TooltipProvider>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {app.enabled &&
                    app.auth_type === 'oauth2' &&
                    connectionStatusKnown &&
                    connectionStatusBySlug[app.slug] !== 'connected' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void authorizeConnector(app)}
                        disabled={authorizingAppId === app.id}
                        data-testid={`authorize-connector-app-${app.id}`}
                      >
                        {authorizingAppId === app.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        {t('connector_apps.fields.authorize_app')}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-error/40 text-error hover:bg-error/10 hover:text-error"
                      onClick={() => requestDelete(app)}
                      disabled={deletingAppId === app.id}
                      data-testid={`delete-connector-app-${app.id}`}
                    >
                      {deletingAppId === app.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      {t('connector_apps.fields.delete_app')}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      <ConnectorAppDialog
        open={dialogOpen}
        editing={editing}
        form={form}
        saving={saving}
        onOpenChange={setDialogOpen}
        onChange={setForm}
        onSave={() => void save()}
      />
      <AlertDialog
        open={Boolean(deleteTarget) && deleteStep === 'warning'}
        onOpenChange={open => {
          if (!open) closeDeleteDialog()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connector_apps.delete_impact_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connector_apps.delete_impact_body', {
                name: deleteTarget?.name,
                count: deleteTarget?.connection_count ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-delete-app">
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-error hover:bg-error/90"
              onClick={event => {
                // Radix closes the dialog on activation; without preventing it
                // the close handler clears deleteTarget before the second step.
                event.preventDefault()
                setDeleteStep('confirm')
              }}
              data-testid="acknowledge-delete-app"
            >
              {t('connector_apps.delete_impact_continue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(deleteTarget) && deleteStep === 'confirm'}
        onOpenChange={open => {
          if (!open) closeDeleteDialog()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connector_apps.confirm_delete_app_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connector_apps.confirm_delete_app', {
                name: deleteTarget?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAppId !== null} data-testid="cancel-delete-app">
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-error hover:bg-error/90"
              onClick={() => void deleteConnectorApp()}
              disabled={deletingAppId !== null}
              data-testid="confirm-delete-app"
            >
              {deletingAppId !== null ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('connector_apps.delete_forever')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function IconActionButton({
  label,
  onClick,
  disabled = false,
  testId,
  danger = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  testId: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8${danger ? ' hover:text-error' : ''}`}
          onClick={onClick}
          disabled={disabled}
          data-testid={testId}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ConnectorAppDialog({
  open,
  editing,
  form,
  saving,
  onOpenChange,
  onChange,
  onSave,
}: {
  open: boolean
  editing: AdminConnectorApp | null
  form: ConnectorForm
  saving: boolean
  onOpenChange: (open: boolean) => void
  onChange: (form: ConnectorForm) => void
  onSave: () => void
}) {
  const { t } = useTranslation('admin')
  const [keywordsDirty, setKeywordsDirty] = useState(Boolean(editing))
  const [pendingStaticLoading, setPendingStaticLoading] = useState(false)

  useEffect(() => {
    setKeywordsDirty(Boolean(editing))
    setPendingStaticLoading(false)
  }, [editing, open])

  const update = <K extends keyof ConnectorForm>(key: K, value: ConnectorForm[K]) =>
    onChange({ ...form, [key]: value })

  const updateIdentity = (patch: Partial<Pick<ConnectorForm, 'name' | 'slug'>>) => {
    const next = { ...form, ...patch }
    if (!editing && !keywordsDirty) {
      next.keywords = defaultConnectorKeywords(next.name, next.slug)
    }
    onChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(editing ? 'connector_apps.dialog.edit_title' : 'connector_apps.dialog.create_title')}
          </DialogTitle>
          <DialogDescription>{t('connector_apps.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t('connector_apps.fields.name')}>
            <Input
              value={form.name}
              onChange={event => updateIdentity({ name: event.target.value })}
              data-testid="connector-app-name"
            />
          </FormField>
          <FormField label={t('connector_apps.fields.slug')} hint={t('connector_apps.hints.slug')}>
            <Input
              value={form.slug}
              disabled={Boolean(editing)}
              onChange={event => updateIdentity({ slug: event.target.value })}
              data-testid="connector-app-slug"
            />
          </FormField>
          <div className="md:col-span-2">
            <FormField label={t('connector_apps.fields.description')}>
              <Textarea
                value={form.description}
                onChange={event => update('description', event.target.value)}
                data-testid="connector-app-description"
              />
            </FormField>
          </div>
          <FormField
            label={t(
              form.transport === 'http'
                ? 'connector_apps.fields.http_base_url'
                : 'connector_apps.fields.mcp_url'
            )}
          >
            <Input
              value={form.mcpUrl}
              onChange={event => update('mcpUrl', event.target.value)}
              data-testid="connector-app-mcp-url"
            />
          </FormField>
          <FormField label={t('connector_apps.fields.transport')}>
            <Select
              value={form.transport}
              onValueChange={value => update('transport', value as ConnectorTransport)}
            >
              <SelectTrigger data-testid="connector-app-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="http">HTTP API</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t('connector_apps.fields.tool_loading_mode')}
            hint={t('connector_apps.hints.tool_loading_mode')}
          >
            <Select
              value={form.toolLoadingMode}
              onValueChange={value => {
                if (value === 'static') {
                  setPendingStaticLoading(true)
                  return
                }
                update('toolLoadingMode', 'lazy')
              }}
            >
              <SelectTrigger data-testid="connector-app-tool-loading-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">{t('connector_apps.tool_loading.static')}</SelectItem>
                <SelectItem value="lazy">{t('connector_apps.tool_loading.lazy')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {form.toolLoadingMode === 'lazy' ? (
            <FormField
              label={t('connector_apps.fields.keywords')}
              hint={t('connector_apps.hints.keywords')}
            >
              <Textarea
                value={form.keywords}
                onChange={event => {
                  setKeywordsDirty(true)
                  update('keywords', event.target.value)
                }}
                placeholder={t('connector_apps.hints.keywords_placeholder')}
                data-testid="connector-app-keywords"
              />
            </FormField>
          ) : null}
          <FormField label={t('connector_apps.fields.auth_type')}>
            <Select
              value={form.authType}
              onValueChange={value => update('authType', value as ConnectorAuthType)}
            >
              <SelectTrigger data-testid="connector-app-auth-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('connector_apps.auth.none')}</SelectItem>
                <SelectItem value="oauth2">{t('connector_apps.auth.oauth2')}</SelectItem>
                <SelectItem value="bearer">{t('connector_apps.auth.bearer')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('connector_apps.fields.icon_url')}>
            <Input
              value={form.iconUrl}
              onChange={event => update('iconUrl', event.target.value)}
              data-testid="connector-app-icon-url"
            />
          </FormField>
          {form.authType === 'oauth2' ? (
            <FormField
              label={t('connector_apps.fields.oauth_scope')}
              hint={t('connector_apps.hints.oauth_scope')}
            >
              <Input
                value={form.oauthScope}
                onChange={event => update('oauthScope', event.target.value)}
                data-testid="connector-app-oauth-scope"
              />
            </FormField>
          ) : null}
          <FormField label={t('connector_apps.fields.visibility')}>
            <Select
              value={form.visibility}
              onValueChange={value => update('visibility', value as ConnectorVisibility)}
            >
              <SelectTrigger data-testid="connector-app-visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('connector_apps.visibility.all')}</SelectItem>
                <SelectItem value="roles">{t('connector_apps.visibility.roles')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {form.visibility === 'roles' ? (
            <div className="md:col-span-2">
              <FormField
                label={t('connector_apps.fields.allowed_roles')}
                hint={t('connector_apps.hints.lines')}
              >
                <Textarea
                  value={form.allowedRoles}
                  onChange={event => update('allowedRoles', event.target.value)}
                  data-testid="connector-app-allowed-roles"
                />
              </FormField>
            </div>
          ) : null}
          <div className="md:col-span-2">
            {form.transport === 'http' ? (
              <FormField
                label={t('connector_apps.fields.http_tools')}
                hint={t('connector_apps.hints.http_tools')}
              >
                <Textarea
                  className="min-h-64 font-mono"
                  value={form.httpTools}
                  onChange={event => update('httpTools', event.target.value)}
                  placeholder={t('connector_apps.hints.http_tools_example')}
                  data-testid="connector-app-http-tools"
                />
              </FormField>
            ) : null}
          </div>
          <div className="md:col-span-2">
            <FormField
              label={t('connector_apps.fields.provider_headers')}
              hint={
                editing?.provider_headers_configured
                  ? t('connector_apps.hints.headers_configured', {
                      names: editing.provider_header_names.join(', '),
                    })
                  : t('connector_apps.hints.headers_json')
              }
            >
              <Textarea
                value={form.providerHeaders}
                onChange={event =>
                  onChange({
                    ...form,
                    providerHeaders: event.target.value,
                    clearProviderHeaders: false,
                  })
                }
                placeholder={'{"X-API-Key":"secret"}'}
                data-testid="connector-app-provider-headers"
              />
            </FormField>
            {editing?.provider_headers_configured ? (
              <div className="mt-3 flex items-center gap-3">
                <Switch
                  checked={form.clearProviderHeaders}
                  onCheckedChange={value =>
                    onChange({
                      ...form,
                      clearProviderHeaders: value,
                      ...(value ? { providerHeaders: '' } : {}),
                    })
                  }
                  data-testid="connector-app-clear-provider-headers"
                />
                <Label>{t('connector_apps.fields.clear_provider_headers')}</Label>
              </div>
            ) : null}
          </div>
          <div className="md:col-span-2">
            <FormField
              label={t('connector_apps.fields.tool_allowlist')}
              hint={t('connector_apps.hints.allowlist')}
            >
              <Textarea
                value={form.toolAllowlist}
                onChange={event => update('toolAllowlist', event.target.value)}
                data-testid="connector-app-tool-allowlist"
              />
            </FormField>
          </div>
          <div className="flex items-center gap-3 md:col-span-2">
            <Switch
              checked={form.enabled}
              onCheckedChange={value => update('enabled', value)}
              data-testid="connector-app-enabled"
            />
            <Label>{t('connector_apps.fields.enabled')}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            data-testid="cancel-connector-app-button"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={saving}
            data-testid="save-connector-app-button"
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={pendingStaticLoading}
        onOpenChange={open => {
          if (!open) setPendingStaticLoading(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connector_apps.static_loading_warning_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connector_apps.static_loading_warning_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-static-loading">
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                update('toolLoadingMode', 'static')
                setPendingStaticLoading(false)
              }}
              data-testid="confirm-static-loading"
            >
              {t('connector_apps.static_loading_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  )
}
