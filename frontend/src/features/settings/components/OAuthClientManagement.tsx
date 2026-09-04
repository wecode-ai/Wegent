// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  oauthClientAdminApis,
  oauthClientApis,
  OAuthClient,
  OAuthClientCreateRequest,
  OAuthClientType,
} from '@/apis/oauthProvider'
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
  description: string
}

const DEFAULT_FORM: ClientForm = {
  name: '',
  clientType: 'public',
  redirectUris: '',
  description: '',
}

interface OAuthClientManagementProps {
  mode?: 'owner' | 'admin'
}

export default function OAuthClientManagement({ mode = 'owner' }: OAuthClientManagementProps) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const isAdmin = mode === 'admin'
  const [clients, setClients] = useState<OAuthClient[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<OAuthClient | null>(null)
  const [form, setForm] = useState<ClientForm>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [credentials, setCredentials] = useState<{
    clientId: string
    clientSecret?: string | null
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const clientResponse = isAdmin
        ? await oauthClientAdminApis.getOAuthClients()
        : await oauthClientApis.getOAuthClients()
      setClients(clientResponse.items)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('oauth_clients.errors.load_failed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setLoading(false)
    }
  }, [isAdmin, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  function openCreate() {
    setEditing(null)
    setForm(DEFAULT_FORM)
    setDialogOpen(true)
  }

  function openEdit(client: OAuthClient) {
    setEditing(client)
    setForm({
      name: client.name,
      clientType: client.client_type,
      redirectUris: client.redirect_uris.join('\n'),
      description: client.description,
    })
    setDialogOpen(true)
  }

  async function save() {
    const redirectUris = form.redirectUris
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean)
    if (!form.name.trim() || redirectUris.length === 0) {
      toast({ variant: 'destructive', title: t('oauth_clients.errors.required') })
      return
    }
    const payload: OAuthClientCreateRequest = {
      name: form.name.trim(),
      client_type: form.clientType,
      redirect_uris: redirectUris,
      description: form.description.trim(),
    }
    setSaving(true)
    try {
      const saved = editing
        ? await oauthClientApis.updateOAuthClient(editing.id, payload)
        : await oauthClientApis.createOAuthClient(payload)
      setClients(previous =>
        editing ? previous.map(item => (item.id === saved.id ? saved : item)) : [saved, ...previous]
      )
      setDialogOpen(false)
      if (!editing || saved.client_secret) {
        setCredentials({
          clientId: saved.client_id,
          clientSecret: saved.client_secret,
        })
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
      const updated = isAdmin
        ? await oauthClientAdminApis.updateOAuthClient(client.id, {
            enabled: !client.is_active,
          })
        : await oauthClientApis.updateOAuthClient(client.id, {
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
      const updated = await oauthClientApis.rotateOAuthClientSecret(client.id)
      setClients(previous => previous.map(item => (item.id === updated.id ? updated : item)))
      if (updated.client_secret) {
        setCredentials({
          clientId: updated.client_id,
          clientSecret: updated.client_secret,
        })
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
      if (isAdmin) {
        await oauthClientAdminApis.deleteOAuthClient(deleteTarget.id)
      } else {
        await oauthClientApis.deleteOAuthClient(deleteTarget.id)
      }
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
          <h3 className="text-lg font-semibold text-text-primary">
            {t(isAdmin ? 'oauth_clients.admin_title' : 'oauth_clients.title')}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t(isAdmin ? 'oauth_clients.admin_description' : 'oauth_clients.description')}
          </p>
        </div>
        {!isAdmin && (
          <UnifiedAddButton
            onClick={openCreate}
            data-testid="oauth-client-create-button"
            className="min-h-11"
          >
            {t('oauth_clients.create')}
          </UnifiedAddButton>
        )}
      </div>

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
                      {t(
                        client.client_type === 'public'
                          ? 'oauth_clients.public_label'
                          : 'oauth_clients.confidential_label'
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-text-muted">{t('oauth_clients.client_id')}</p>
                  <code
                    className="mt-1 block break-all text-xs text-text-secondary"
                    data-testid={`oauth-client-id-${client.id}`}
                  >
                    {client.client_id}
                  </code>
                  <p className="mt-1 break-all text-sm text-text-muted">
                    {client.redirect_uris.join(', ')}
                  </p>
                  {isAdmin && (
                    <p
                      className="mt-1 text-xs text-text-muted"
                      data-testid={`oauth-client-owner-${client.id}`}
                    >
                      {t('oauth_clients.owner')}:{' '}
                      {client.owner_user_name || `#${client.owner_user_id}`}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    checked={client.is_active}
                    disabled={busyId === client.id}
                    onCheckedChange={() => void toggle(client)}
                    data-testid={`oauth-client-toggle-${client.id}`}
                  />
                  {!isAdmin && client.client_type === 'confidential' && (
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
                  {!isAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => openEdit(client)}
                      data-testid={`oauth-client-edit-${client.id}`}
                    >
                      <Pencil className="mr-1 h-4 w-4" />
                      {t('oauth_clients.edit')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => setDeleteTarget(client)}
                    aria-label={t('common:actions.delete')}
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
                    <SelectItem value="public">{t('oauth_clients.public')}</SelectItem>
                    <SelectItem value="confidential">{t('oauth_clients.confidential')}</SelectItem>
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

      <Dialog open={!!credentials} onOpenChange={open => !open && setCredentials(null)}>
        <DialogContent className="bg-surface sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('oauth_clients.secret_title')}</DialogTitle>
            <DialogDescription>
              {t(
                credentials?.clientSecret
                  ? 'oauth_clients.secret_warning'
                  : 'oauth_clients.public_credential_note'
              )}
            </DialogDescription>
          </DialogHeader>
          {credentials && (
            <div className="space-y-3">
              <SecretRow
                label="client_id"
                value={credentials.clientId}
                testId="oauth-client-copy-client-id"
                copyLabel={t('common:actions.copy')}
                onCopy={copy}
              />
              {credentials.clientSecret && (
                <SecretRow
                  label="client_secret"
                  value={credentials.clientSecret}
                  testId="oauth-client-copy-client-secret"
                  copyLabel={t('common:actions.copy')}
                  onCopy={copy}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="primary"
              className="min-h-11"
              onClick={() => setCredentials(null)}
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
  copyLabel,
  onCopy,
}: {
  label: string
  value: string
  testId: string
  copyLabel: string
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
          aria-label={copyLabel}
          data-testid={testId}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
