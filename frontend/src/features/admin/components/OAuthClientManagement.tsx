// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminApis,
  OAuthClient,
  OAuthClientCreateRequest,
  OAuthClientType,
  TokenIssuer,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { Copy, KeyRound, Loader2, Pencil, RotateCw, Trash2 } from 'lucide-react'

type ClientForm = {
  name: string
  clientType: OAuthClientType
  redirectUris: string
  tokenIssuerId: string
  accessTtlSeconds: string
  refreshTtlSeconds: string
  description: string
  enabled: boolean
}

const DEFAULT_FORM: ClientForm = {
  name: '',
  clientType: 'confidential',
  redirectUris: '',
  tokenIssuerId: '',
  accessTtlSeconds: '600',
  refreshTtlSeconds: '2592000',
  description: '',
  enabled: true,
}

export default function OAuthClientManagement() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [clients, setClients] = useState<OAuthClient[]>([])
  const [issuers, setIssuers] = useState<TokenIssuer[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<OAuthClient | null>(null)
  const [form, setForm] = useState<ClientForm>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState<{ clientId: string; value: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const oauthIssuers = useMemo(
    () => issuers.filter(issuer => issuer.is_active && issuer.audience === 'wegent-userinfo'),
    [issuers]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [clientResponse, issuerResponse] = await Promise.all([
        adminApis.getOAuthClients(),
        adminApis.getTokenIssuers(),
      ])
      setClients(clientResponse.items)
      setIssuers(issuerResponse.items)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.load_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  function openCreate() {
    setEditing(null)
    setForm({
      ...DEFAULT_FORM,
      tokenIssuerId: oauthIssuers[0] ? String(oauthIssuers[0].id) : '',
    })
    setDialogOpen(true)
  }

  function openEdit(client: OAuthClient) {
    setEditing(client)
    setForm({
      name: client.name,
      clientType: client.client_type,
      redirectUris: client.redirect_uris.join('\n'),
      tokenIssuerId: String(client.token_issuer_id),
      accessTtlSeconds: String(client.access_ttl_seconds),
      refreshTtlSeconds: String(client.refresh_ttl_seconds),
      description: client.description,
      enabled: client.is_active,
    })
    setDialogOpen(true)
  }

  async function save() {
    const redirectUris = form.redirectUris
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean)
    if (!form.name.trim() || !form.tokenIssuerId || redirectUris.length === 0) {
      toast({ variant: 'destructive', title: t('oauth_clients.errors.required') })
      return
    }
    const payload: OAuthClientCreateRequest = {
      name: form.name.trim(),
      client_type: form.clientType,
      redirect_uris: redirectUris,
      token_issuer_id: Number(form.tokenIssuerId),
      access_ttl_seconds: Number(form.accessTtlSeconds),
      refresh_ttl_seconds: Number(form.refreshTtlSeconds),
      description: form.description.trim(),
      enabled: form.enabled,
    }
    setSaving(true)
    try {
      const saved = editing
        ? await adminApis.updateOAuthClient(editing.id, payload)
        : await adminApis.createOAuthClient(payload)
      setClients(previous =>
        editing ? previous.map(item => (item.id === saved.id ? saved : item)) : [saved, ...previous]
      )
      setDialogOpen(false)
      if (saved.client_secret) {
        setSecret({ clientId: saved.client_id, value: saved.client_secret })
      }
      toast({
        title: editing ? t('oauth_clients.update_success') : t('oauth_clients.create_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.save_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  async function toggle(client: OAuthClient) {
    setBusyId(client.id)
    try {
      const updated = await adminApis.updateOAuthClient(client.id, {
        enabled: !client.is_active,
      })
      setClients(previous => previous.map(item => (item.id === updated.id ? updated : item)))
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.toggle_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyId(null)
    }
  }

  async function rotate(client: OAuthClient) {
    setBusyId(client.id)
    try {
      const updated = await adminApis.rotateOAuthClientSecret(client.id)
      setClients(previous => previous.map(item => (item.id === updated.id ? updated : item)))
      if (updated.client_secret) {
        setSecret({ clientId: updated.client_id, value: updated.client_secret })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.rotate_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyId(null)
    }
  }

  async function remove() {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    try {
      await adminApis.deleteOAuthClient(deleteTarget.id)
      setClients(previous => previous.filter(item => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast({ title: t('oauth_clients.delete_success') })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.delete_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyId(null)
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: t('oauth_clients.copy_success') })
    } catch {
      toast({ variant: 'destructive', title: t('oauth_clients.errors.copy_failed') })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">{t('oauth_clients.title')}</h3>
          <p className="mt-1 text-sm text-text-muted">{t('oauth_clients.description')}</p>
        </div>
        <UnifiedAddButton
          onClick={openCreate}
          data-testid="oauth-client-create-button"
          disabled={oauthIssuers.length === 0}
          className="min-h-11"
        >
          {t('oauth_clients.create')}
        </UnifiedAddButton>
      </div>

      {oauthIssuers.length === 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          {t('oauth_clients.no_issuer')}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-text-muted">
          {t('oauth_clients.empty')}
        </div>
      ) : (
        <div className="grid gap-3">
          {clients.map(client => (
            <div
              key={client.id}
              className="rounded-lg border border-border bg-surface px-4 py-4"
              data-testid={`oauth-client-card-${client.id}`}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="h-4 w-4 text-primary" />
                    <span className="font-medium text-text-primary">{client.name}</span>
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-text-secondary">
                      {client.client_type}
                    </span>
                  </div>
                  <code className="mt-2 block break-all text-xs text-text-secondary">
                    {client.client_id}
                  </code>
                  <p className="mt-2 text-sm text-text-muted">
                    {t('oauth_clients.issuer')}: {client.token_issuer_name}
                  </p>
                  <p className="mt-1 break-all text-sm text-text-muted">
                    {client.redirect_uris.join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    checked={client.is_active}
                    disabled={busyId === client.id}
                    onCheckedChange={() => void toggle(client)}
                    data-testid={`oauth-client-toggle-${client.id}`}
                  />
                  {client.client_type === 'confidential' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      disabled={busyId === client.id}
                      onClick={() => void rotate(client)}
                      data-testid={`oauth-client-rotate-${client.id}`}
                    >
                      <RotateCw className="mr-1 h-4 w-4" />
                      {t('oauth_clients.rotate')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => openEdit(client)}
                    data-testid={`oauth-client-edit-${client.id}`}
                  >
                    <Pencil className="mr-1 h-4 w-4" />
                    {t('outbound_tokens.actions.edit')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => setDeleteTarget(client)}
                    data-testid={`oauth-client-delete-${client.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-surface sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('oauth_clients.edit_title') : t('oauth_clients.create_title')}
            </DialogTitle>
            <DialogDescription>{t('oauth_clients.dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('oauth_clients.name')}>
                <Input
                  value={form.name}
                  onChange={event =>
                    setForm(previous => ({ ...previous, name: event.target.value }))
                  }
                  data-testid="oauth-client-name"
                />
              </Field>
              <Field label={t('oauth_clients.type')}>
                <Select
                  value={form.clientType}
                  onValueChange={value =>
                    setForm(previous => ({ ...previous, clientType: value as OAuthClientType }))
                  }
                >
                  <SelectTrigger data-testid="oauth-client-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="confidential">{t('oauth_clients.confidential')}</SelectItem>
                    <SelectItem value="public">{t('oauth_clients.public')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label={t('oauth_clients.redirect_uris')}>
              <Textarea
                rows={4}
                value={form.redirectUris}
                onChange={event =>
                  setForm(previous => ({ ...previous, redirectUris: event.target.value }))
                }
                placeholder="https://client.example/callback"
                data-testid="oauth-client-redirect-uris"
              />
            </Field>
            <Field label={t('oauth_clients.issuer')}>
              <Select
                value={form.tokenIssuerId}
                onValueChange={value =>
                  setForm(previous => ({ ...previous, tokenIssuerId: value }))
                }
              >
                <SelectTrigger data-testid="oauth-client-issuer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {oauthIssuers.map(issuer => (
                    <SelectItem key={issuer.id} value={String(issuer.id)}>
                      {issuer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('oauth_clients.access_ttl')}>
                <Input
                  type="number"
                  min={60}
                  max={3600}
                  value={form.accessTtlSeconds}
                  data-testid="oauth-client-access-ttl"
                  onChange={event =>
                    setForm(previous => ({
                      ...previous,
                      accessTtlSeconds: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t('oauth_clients.refresh_ttl')}>
                <Input
                  type="number"
                  min={3600}
                  max={7776000}
                  value={form.refreshTtlSeconds}
                  data-testid="oauth-client-refresh-ttl"
                  onChange={event =>
                    setForm(previous => ({
                      ...previous,
                      refreshTtlSeconds: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <Field label={t('oauth_clients.description_label')}>
              <Textarea
                rows={3}
                value={form.description}
                data-testid="oauth-client-description"
                onChange={event =>
                  setForm(previous => ({ ...previous, description: event.target.value }))
                }
              />
            </Field>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <span className="text-sm text-text-primary">{t('oauth_clients.enabled')}</span>
              <Switch
                checked={form.enabled}
                onCheckedChange={enabled => setForm(previous => ({ ...previous, enabled }))}
                data-testid="oauth-client-form-enabled"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setDialogOpen(false)}
              data-testid="oauth-client-dialog-cancel"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              className="min-h-11"
              disabled={saving}
              onClick={() => void save()}
              data-testid="oauth-client-save"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={open => !open && setSecret(null)}>
        <DialogContent className="bg-surface sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('oauth_clients.secret_title')}</DialogTitle>
            <DialogDescription>{t('oauth_clients.secret_warning')}</DialogDescription>
          </DialogHeader>
          {secret && (
            <div className="space-y-3">
              <SecretRow
                label="client_id"
                value={secret.clientId}
                testId="oauth-client-copy-client-id"
                onCopy={copy}
              />
              <SecretRow
                label="client_secret"
                value={secret.value}
                testId="oauth-client-copy-client-secret"
                onCopy={copy}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="primary"
              className="min-h-11"
              onClick={() => setSecret(null)}
              data-testid="oauth-client-secret-confirm"
            >
              {t('common:actions.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('oauth_clients.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('oauth_clients.delete_description', { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" data-testid="oauth-client-delete-cancel">
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              onClick={event => {
                event.preventDefault()
                void remove()
              }}
              data-testid="oauth-client-delete-confirm"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      {children}
    </label>
  )
}

function SecretRow({
  label,
  value,
  testId,
  onCopy,
}: {
  label: string
  value: string
  testId: string
  onCopy: (value: string) => Promise<void>
}) {
  return (
    <div>
      <span className="text-xs text-text-muted">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 text-xs">{value}</code>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 min-w-11"
          onClick={() => void onCopy(value)}
          data-testid={testId}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
