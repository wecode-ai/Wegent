// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Cable, Loader2, Pencil, Play, Plus, Power, Search } from 'lucide-react'
import { adminApis } from '@/apis/admin'
import type {
  AdminConnectorApp,
  AdminConnectorAppCreate,
  ConnectorAuthType,
  ConnectorHttpToolDefinition,
  ConnectorTransport,
  ConnectorVisibility,
} from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface ConnectorForm {
  slug: string
  name: string
  description: string
  iconUrl: string
  enabled: boolean
  visibility: ConnectorVisibility
  allowedRoles: string
  authType: ConnectorAuthType
  transport: ConnectorTransport
  mcpUrl: string
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
  authType: 'none',
  transport: 'streamable-http',
  mcpUrl: '',
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
    transport: app.transport,
    mcpUrl: app.mcp_url,
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
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    icon_url: form.iconUrl.trim() || null,
    enabled: form.enabled,
    visibility: form.visibility,
    allowed_roles: lines(form.allowedRoles),
    auth_type: form.authType,
    transport: form.transport,
    mcp_url: form.mcpUrl.trim(),
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
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AdminConnectorApp | null>(null)
  const [form, setForm] = useState<ConnectorForm>(EMPTY_FORM)

  const loadApps = useCallback(async () => {
    setLoading(true)
    try {
      setApps(await adminApis.getConnectorApps())
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
    if (
      !form.slug.trim() ||
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

  const disable = async (app: AdminConnectorApp) => {
    if (!window.confirm(t('connector_apps.confirm_disable', { name: app.name }))) return
    try {
      await adminApis.disableConnectorApp(app.id)
      toast({ title: t('connector_apps.success.disabled') })
      await loadApps()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.disable_failed'),
        description: (error as Error).message,
      })
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
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.discover_failed'),
        description: (error as Error).message,
      })
    } finally {
      setDiscoveringId(null)
    }
  }

  const testTool = async (app: AdminConnectorApp) => {
    const toolName = app.tool_allowlist[0] || app.http_tools[0]?.name
    if (!toolName) {
      toast({ variant: 'destructive', title: t('connector_apps.errors.no_test_tool') })
      return
    }
    setTestingId(app.id)
    try {
      const response = await adminApis.testConnectorAppTool(app.id, toolName)
      toast({
        title: response.is_error
          ? t('connector_apps.errors.test_returned_error')
          : t('connector_apps.success.tested'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('connector_apps.errors.test_failed'),
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
        <div className="grid gap-3 lg:grid-cols-2">
          {apps.map(app => (
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void discoverTools(app)}
                    disabled={discoveringId === app.id}
                    data-testid={`discover-connector-app-tools-${app.id}`}
                    aria-label={t('connector_apps.discover_tools')}
                  >
                    {discoveringId === app.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void testTool(app)}
                    disabled={testingId === app.id}
                    data-testid={`test-connector-app-tool-${app.id}`}
                    aria-label={t('connector_apps.test_tool')}
                  >
                    {testingId === app.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(app)}
                    data-testid={`edit-connector-app-${app.id}`}
                    aria-label={t('connector_apps.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {app.enabled ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => void disable(app)}
                      data-testid={`disable-connector-app-${app.id}`}
                      aria-label={t('connector_apps.disable')}
                    >
                      <Power className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
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
    </div>
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
  const update = <K extends keyof ConnectorForm>(key: K, value: ConnectorForm[K]) =>
    onChange({ ...form, [key]: value })

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
              onChange={event => update('name', event.target.value)}
              data-testid="connector-app-name"
            />
          </FormField>
          <FormField label={t('connector_apps.fields.slug')}>
            <Input
              value={form.slug}
              disabled={Boolean(editing)}
              onChange={event => update('slug', event.target.value)}
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
          <FormField label={t('connector_apps.fields.icon_url')}>
            <Input
              value={form.iconUrl}
              onChange={event => update('iconUrl', event.target.value)}
              data-testid="connector-app-icon-url"
            />
          </FormField>
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
              </SelectContent>
            </Select>
          </FormField>
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
