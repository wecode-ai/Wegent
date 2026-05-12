// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { ApiError } from '@/apis/client'
import {
  adminApis,
  SigningKey,
  TokenIssuer,
  TokenIssuerCreateRequest,
  TokenIssuerUpdateRequest,
} from '@/apis/admin'
import {
  CheckIcon,
  ClipboardDocumentIcon,
  EyeIcon,
  KeyIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

type IssuerFormState = {
  name: string
  signingKeyId: string
  issuer: string
  audience: string
  defaultTtlSeconds: string
  maxTtlSeconds: string
  description: string
  enabled: boolean
}

type InlineKeyFormState = {
  name: string
  description: string
}

type DeleteTarget = { type: 'issuer'; issuer: TokenIssuer } | { type: 'key'; key: SigningKey }

type PemTarget = {
  title: string
  kid: string
  name: string
  publicKeyPem: string
}

const DEFAULT_ISSUER_FORM: IssuerFormState = {
  name: '',
  signingKeyId: '',
  issuer: 'wegent',
  audience: '',
  defaultTtlSeconds: '600',
  maxTtlSeconds: '900',
  description: '',
  enabled: true,
}

const DEFAULT_INLINE_KEY_FORM: InlineKeyFormState = {
  name: '',
  description: '',
}

const OUTBOUND_TOKEN_ERROR_MESSAGE_KEYS: Record<string, string> = {
  SIGNING_KEY_DISABLE_BLOCKED_BY_ACTIVE_ISSUER:
    'outbound_tokens.signing_keys.errors.disable_blocked_by_issuer',
  SIGNING_KEY_DELETE_BLOCKED_BY_ACTIVE_ISSUER:
    'outbound_tokens.signing_keys.errors.delete_blocked_by_issuer',
  TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY:
    'outbound_tokens.issuers.errors.requires_active_signing_key',
}

const OutboundTokenIssuerList: React.FC<{ showHeader?: boolean }> = ({ showHeader = true }) => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [issuers, setIssuers] = useState<TokenIssuer[]>([])
  const [signingKeys, setSigningKeys] = useState<SigningKey[]>([])
  const [loading, setLoading] = useState(true)
  const [signingKeysLoading, setSigningKeysLoading] = useState(false)
  const [signingKeysLoaded, setSigningKeysLoaded] = useState(false)
  const [issuerDialogOpen, setIssuerDialogOpen] = useState(false)
  const [issuerDialogMode, setIssuerDialogMode] = useState<'create' | 'edit'>('create')
  const [editingIssuer, setEditingIssuer] = useState<TokenIssuer | null>(null)
  const [issuerForm, setIssuerForm] = useState<IssuerFormState>(DEFAULT_ISSUER_FORM)
  const [inlineKeyForm, setInlineKeyForm] = useState<InlineKeyFormState>(DEFAULT_INLINE_KEY_FORM)
  const [showInlineKeyForm, setShowInlineKeyForm] = useState(false)
  const [isSavingIssuer, setIsSavingIssuer] = useState(false)
  const [isCreatingInlineKey, setIsCreatingInlineKey] = useState(false)
  const [pemTarget, setPemTarget] = useState<PemTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [togglingIssuerId, setTogglingIssuerId] = useState<number | null>(null)
  const [togglingKeyId, setTogglingKeyId] = useState<number | null>(null)
  const [copiedPemTarget, setCopiedPemTarget] = useState<string | null>(null)
  const [showSigningKeys, setShowSigningKeys] = useState(false)

  const usageCounts = useMemo(() => {
    const counts = new Map<number, number>()
    issuers.forEach(issuer => {
      counts.set(issuer.signing_key_id, (counts.get(issuer.signing_key_id) ?? 0) + 1)
    })
    return counts
  }, [issuers])

  const resetIssuerDialogState = () => {
    setIssuerForm(DEFAULT_ISSUER_FORM)
    setInlineKeyForm(DEFAULT_INLINE_KEY_FORM)
    setShowInlineKeyForm(false)
    setEditingIssuer(null)
  }

  const getOutboundTokenErrorMessage = useCallback(
    (error: unknown) => {
      const apiError = error as ApiError
      if (typeof apiError?.errorCode === 'string') {
        const translationKey = OUTBOUND_TOKEN_ERROR_MESSAGE_KEYS[apiError.errorCode]
        if (translationKey) {
          return t(translationKey)
        }
      }
      return error instanceof Error ? error.message : undefined
    },
    [t]
  )

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const issuerResponse = await adminApis.getTokenIssuers()
      setIssuers(issuerResponse.items || [])
    } catch (error) {
      console.error('Failed to fetch outbound token configuration:', error)
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  const loadSigningKeys = useCallback(
    async (force: boolean = false) => {
      if (signingKeysLoading) {
        return
      }
      if (signingKeysLoaded && !force) {
        return
      }

      setSigningKeysLoading(true)
      try {
        const response = await adminApis.getSigningKeys()
        setSigningKeys(response.items || [])
        setSigningKeysLoaded(true)
      } catch (error) {
        console.error('Failed to fetch signing keys:', error)
        toast({
          variant: 'destructive',
          title: t('outbound_tokens.signing_keys.errors.load_failed'),
          description: (error as Error).message,
        })
      } finally {
        setSigningKeysLoading(false)
      }
    },
    [signingKeysLoaded, signingKeysLoading, toast, t]
  )

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatTtl = (seconds: number) => {
    if (seconds % 60 === 0) {
      return `${seconds / 60}m`
    }
    return `${seconds}s`
  }

  const openCreateDialog = () => {
    setIssuerDialogMode('create')
    resetIssuerDialogState()
    setShowInlineKeyForm(false)
    setIssuerDialogOpen(true)
    void loadSigningKeys()
  }

  const openEditDialog = (issuer: TokenIssuer) => {
    setIssuerDialogMode('edit')
    setEditingIssuer(issuer)
    setIssuerForm({
      name: issuer.name,
      signingKeyId: String(issuer.signing_key_id),
      issuer: issuer.issuer,
      audience: issuer.audience,
      defaultTtlSeconds: String(issuer.default_ttl_seconds),
      maxTtlSeconds: String(issuer.max_ttl_seconds),
      description: issuer.description || '',
      enabled: issuer.is_active,
    })
    setInlineKeyForm(DEFAULT_INLINE_KEY_FORM)
    setShowInlineKeyForm(false)
    setIssuerDialogOpen(true)
    void loadSigningKeys()
  }

  const handleIssuerDialogChange = (open: boolean) => {
    setIssuerDialogOpen(open)
    if (!open && !isSavingIssuer && !isCreatingInlineKey) {
      resetIssuerDialogState()
    }
  }

  const handleCopyPem = async (pem: string, target: string) => {
    try {
      await navigator.clipboard.writeText(pem)
      setCopiedPemTarget(target)
      setTimeout(() => setCopiedPemTarget(current => (current === target ? null : current)), 2000)
    } catch {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.copy_failed'),
      })
    }
  }

  const handleCreateInlineSigningKey = async () => {
    if (!inlineKeyForm.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.signing_key_name_required'),
      })
      return
    }

    setIsCreatingInlineKey(true)
    try {
      const created = await adminApis.createSigningKey({
        name: inlineKeyForm.name.trim(),
        description: inlineKeyForm.description.trim() || undefined,
      })
      setSigningKeys(prev => [created, ...prev])
      setSigningKeysLoaded(true)
      setIssuerForm(prev => ({ ...prev, signingKeyId: String(created.id) }))
      setInlineKeyForm(DEFAULT_INLINE_KEY_FORM)
      setShowInlineKeyForm(false)
      toast({
        title: t('outbound_tokens.signing_keys.create_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.signing_keys.errors.create_failed'),
        description: getOutboundTokenErrorMessage(error),
      })
    } finally {
      setIsCreatingInlineKey(false)
    }
  }

  const handleSaveIssuer = async () => {
    if (!issuerForm.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.issuer_name_required'),
      })
      return
    }
    if (!issuerForm.signingKeyId) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.signing_key_required'),
      })
      return
    }
    if (!issuerForm.audience.trim()) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.audience_required'),
      })
      return
    }

    const defaultTtlSeconds = Number(issuerForm.defaultTtlSeconds)
    const maxTtlSeconds = Number(issuerForm.maxTtlSeconds)

    if (!Number.isFinite(defaultTtlSeconds) || !Number.isFinite(maxTtlSeconds)) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.errors.invalid_ttl'),
      })
      return
    }

    setIsSavingIssuer(true)
    try {
      if (issuerDialogMode === 'create') {
        const payload: TokenIssuerCreateRequest = {
          name: issuerForm.name.trim(),
          signing_key_id: Number(issuerForm.signingKeyId),
          issuer: issuerForm.issuer.trim(),
          audience: issuerForm.audience.trim(),
          default_ttl_seconds: defaultTtlSeconds,
          max_ttl_seconds: maxTtlSeconds,
          description: issuerForm.description.trim() || undefined,
          enabled: issuerForm.enabled,
        }
        const created = await adminApis.createTokenIssuer(payload)
        setIssuers(prev => [created, ...prev])
        toast({
          title: t('outbound_tokens.issuers.create_success'),
        })
      } else if (editingIssuer) {
        const payload: TokenIssuerUpdateRequest = {
          name: issuerForm.name.trim(),
          signing_key_id: Number(issuerForm.signingKeyId),
          issuer: issuerForm.issuer.trim(),
          audience: issuerForm.audience.trim(),
          default_ttl_seconds: defaultTtlSeconds,
          max_ttl_seconds: maxTtlSeconds,
          description: issuerForm.description.trim(),
          enabled: issuerForm.enabled,
        }
        const updated = await adminApis.updateTokenIssuer(editingIssuer.id, payload)
        setIssuers(prev => prev.map(item => (item.id === updated.id ? updated : item)))
        toast({
          title: t('outbound_tokens.issuers.update_success'),
        })
      }

      handleIssuerDialogChange(false)
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          issuerDialogMode === 'create'
            ? t('outbound_tokens.issuers.errors.create_failed')
            : t('outbound_tokens.issuers.errors.update_failed'),
        description: getOutboundTokenErrorMessage(error),
      })
    } finally {
      setIsSavingIssuer(false)
    }
  }

  const handleToggleIssuerStatus = async (issuer: TokenIssuer) => {
    setTogglingIssuerId(issuer.id)
    try {
      const updated = await adminApis.toggleTokenIssuerStatus(issuer.id)
      setIssuers(prev => prev.map(item => (item.id === updated.id ? updated : item)))
      toast({
        title: updated.is_active
          ? t('outbound_tokens.issuers.enabled_success')
          : t('outbound_tokens.issuers.disabled_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.issuers.errors.toggle_failed'),
        description: getOutboundTokenErrorMessage(error),
      })
    } finally {
      setTogglingIssuerId(null)
    }
  }

  const handleToggleSigningKeyStatus = async (key: SigningKey) => {
    setTogglingKeyId(key.id)
    try {
      const updated = await adminApis.toggleSigningKeyStatus(key.id)
      setSigningKeys(prev => prev.map(item => (item.id === updated.id ? updated : item)))
      setSigningKeysLoaded(true)
      toast({
        title: updated.is_active
          ? t('outbound_tokens.signing_keys.enabled_success')
          : t('outbound_tokens.signing_keys.disabled_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.signing_keys.errors.toggle_failed'),
        description: getOutboundTokenErrorMessage(error),
      })
    } finally {
      setTogglingKeyId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) {
      return
    }

    setIsDeleting(true)
    try {
      if (deleteTarget.type === 'issuer') {
        await adminApis.deleteTokenIssuer(deleteTarget.issuer.id)
        setIssuers(prev => prev.filter(item => item.id !== deleteTarget.issuer.id))
        toast({
          title: t('outbound_tokens.issuers.delete_success'),
        })
      } else {
        await adminApis.deleteSigningKey(deleteTarget.key.id)
        setSigningKeys(prev => prev.filter(item => item.id !== deleteTarget.key.id))
        setSigningKeysLoaded(true)
        toast({
          title: t('outbound_tokens.signing_keys.delete_success'),
        })
      }
      setDeleteTarget(null)
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          deleteTarget.type === 'issuer'
            ? t('outbound_tokens.issuers.errors.delete_failed')
            : t('outbound_tokens.signing_keys.errors.delete_failed'),
        description: getOutboundTokenErrorMessage(error),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const selectedSigningKey = signingKeys.find(key => String(key.id) === issuerForm.signingKeyId)
  const activeSigningKeys = signingKeys.filter(key => key.is_active)
  const signingKeyOptions = selectedSigningKey
    ? activeSigningKeys.some(key => key.id === selectedSigningKey.id)
      ? activeSigningKeys
      : [...activeSigningKeys, selectedSigningKey]
    : activeSigningKeys
  const hasSelectableSigningKeys =
    signingKeysLoaded && (activeSigningKeys.length > 0 || !!selectedSigningKey)

  useEffect(() => {
    if (!issuerDialogOpen || !signingKeysLoaded) {
      return
    }
    if (!hasSelectableSigningKeys) {
      setIssuerForm(prev => (prev.signingKeyId ? { ...prev, signingKeyId: '' } : prev))
      setShowInlineKeyForm(true)
    }
  }, [hasSelectableSigningKeys, issuerDialogOpen, signingKeysLoaded])

  return (
    <div className="space-y-3">
      {showHeader && (
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">
            {t('outbound_tokens.title')}
          </h2>
          <p className="text-sm text-text-muted">{t('outbound_tokens.description')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-text-muted">{t('outbound_tokens.summary')}</div>
        <UnifiedAddButton onClick={openCreateDialog}>
          {t('outbound_tokens.issuers.create')}
        </UnifiedAddButton>
      </div>

      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && issuers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <KeyIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('outbound_tokens.issuers.no_issuers')}</p>
            <p className="text-sm text-text-muted mt-1">{t('outbound_tokens.empty_hint')}</p>
          </div>
        )}

        {!loading && issuers.length > 0 && (
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
            {issuers.map(issuer => (
              <Card
                key={issuer.id}
                className={`p-4 bg-base hover:bg-hover transition-colors ${
                  !issuer.is_active ? 'opacity-70' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{issuer.name}</span>
                      <Badge variant={issuer.is_active ? 'success' : 'secondary'} size="sm">
                        {issuer.is_active
                          ? t('outbound_tokens.common.status_active')
                          : t('outbound_tokens.common.status_disabled')}
                      </Badge>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
                        issuer_id={issuer.id}
                      </code>
                    </div>

                    {issuer.description && (
                      <p className="text-sm text-text-muted">{issuer.description}</p>
                    )}

                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                        {t('outbound_tokens.issuers.current_signing_key')}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-primary">
                        <span className="font-medium">{issuer.signing_key_name}</span>
                        <code className="text-xs bg-base px-1.5 py-0.5 rounded text-text-secondary">
                          {issuer.signing_key_kid}
                        </code>
                        <span className="text-text-muted">
                          {t('outbound_tokens.issuers.signing_key_hint')}
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-2 text-sm text-text-secondary md:grid-cols-2">
                      <div>
                        <span className="text-text-muted">
                          {t('outbound_tokens.issuers.audience')}:
                        </span>{' '}
                        <code>{issuer.audience}</code>
                      </div>
                      <div>
                        <span className="text-text-muted">
                          {t('outbound_tokens.issuers.jwt_issuer')}:
                        </span>{' '}
                        <code>{issuer.issuer}</code>
                      </div>
                      <div>
                        <span className="text-text-muted">
                          {t('outbound_tokens.issuers.default_ttl')}:
                        </span>{' '}
                        {formatTtl(issuer.default_ttl_seconds)}
                      </div>
                      <div>
                        <span className="text-text-muted">
                          {t('outbound_tokens.issuers.max_ttl')}:
                        </span>{' '}
                        {formatTtl(issuer.max_ttl_seconds)}
                      </div>
                      <div className="md:col-span-2">
                        <span className="text-text-muted">
                          {t('outbound_tokens.common.created_at')}:
                        </span>{' '}
                        {formatDate(issuer.created_at)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setPemTarget({
                          title: t('outbound_tokens.pem_dialog.issuer_title'),
                          kid: issuer.signing_key_kid,
                          name: issuer.signing_key_name,
                          publicKeyPem: issuer.public_key_pem,
                        })
                      }
                      title={t('outbound_tokens.actions.view_pem')}
                    >
                      <EyeIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(issuer)}
                      title={t('outbound_tokens.actions.edit')}
                    >
                      <PencilSquareIcon className="w-4 h-4" />
                    </Button>
                    <Switch
                      checked={issuer.is_active}
                      onCheckedChange={() => handleToggleIssuerStatus(issuer)}
                      disabled={togglingIssuerId === issuer.id}
                      title={
                        issuer.is_active
                          ? t('outbound_tokens.actions.disable')
                          : t('outbound_tokens.actions.enable')
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => setDeleteTarget({ type: 'issuer', issuer })}
                      title={t('common:actions.delete')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Card className="p-4 bg-base">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left"
          onClick={() => {
            const next = !showSigningKeys
            setShowSigningKeys(next)
            if (next) {
              void loadSigningKeys()
            }
          }}
        >
          <div>
            <div className="font-medium text-text-primary">
              {t('outbound_tokens.signing_keys.section_title')}
            </div>
            <p className="text-sm text-text-muted mt-1">
              {t('outbound_tokens.signing_keys.section_description')}
            </p>
          </div>
          <div className="flex items-center gap-2 text-text-muted">
            {signingKeysLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : signingKeysLoaded ? (
              <Badge variant="info" size="sm">
                {signingKeys.length}
              </Badge>
            ) : null}
            {showSigningKeys ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </div>
        </button>

        {showSigningKeys && (
          <div className="mt-4 space-y-3">
            {signingKeysLoading && !signingKeysLoaded && (
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('outbound_tokens.signing_keys.loading')}
              </div>
            )}

            {signingKeysLoaded && signingKeys.length === 0 && (
              <p className="text-sm text-text-muted">{t('outbound_tokens.signing_keys.no_keys')}</p>
            )}

            {signingKeysLoaded &&
              signingKeys.map(key => (
                <div
                  key={key.id}
                  className={`rounded-md border border-border p-3 ${
                    key.is_active ? 'bg-base' : 'bg-muted/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text-primary">{key.name}</span>
                        <Badge variant={key.is_active ? 'success' : 'secondary'} size="sm">
                          {key.is_active
                            ? t('outbound_tokens.common.status_active')
                            : t('outbound_tokens.common.status_disabled')}
                        </Badge>
                      </div>
                      {key.description && (
                        <p className="text-sm text-text-muted mt-1">{key.description}</p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                        <span>
                          {t('outbound_tokens.signing_keys.kid')}: <code>{key.kid}</code>
                        </span>
                        <span>
                          {t('outbound_tokens.signing_keys.algorithm')}: {key.algorithm}
                        </span>
                        <span>
                          {t('outbound_tokens.signing_keys.usage_count')}:{' '}
                          {usageCounts.get(key.id) ?? 0}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() =>
                          setPemTarget({
                            title: t('outbound_tokens.pem_dialog.key_title'),
                            kid: key.kid,
                            name: key.name,
                            publicKeyPem: key.public_key_pem,
                          })
                        }
                        title={t('outbound_tokens.actions.view_pem')}
                      >
                        <EyeIcon className="w-4 h-4" />
                      </Button>
                      <Switch
                        checked={key.is_active}
                        onCheckedChange={() => handleToggleSigningKeyStatus(key)}
                        disabled={togglingKeyId === key.id}
                        title={
                          key.is_active
                            ? t('outbound_tokens.actions.disable')
                            : t('outbound_tokens.actions.enable')
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-error"
                        onClick={() => setDeleteTarget({ type: 'key', key })}
                        title={t('common:actions.delete')}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Card>

      <Dialog open={issuerDialogOpen} onOpenChange={handleIssuerDialogChange}>
        <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto bg-surface">
          <DialogHeader>
            <DialogTitle>
              {issuerDialogMode === 'create'
                ? t('outbound_tokens.issuers.create_dialog_title')
                : t('outbound_tokens.issuers.edit_dialog_title')}
            </DialogTitle>
            <DialogDescription>{t('outbound_tokens.issuers.dialog_description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.common.name')}
                </label>
                <Input
                  value={issuerForm.name}
                  onChange={e => setIssuerForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder={t('outbound_tokens.issuers.name_placeholder')}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.issuers.jwt_issuer')}
                </label>
                <Input
                  value={issuerForm.issuer}
                  onChange={e => setIssuerForm(prev => ({ ...prev, issuer: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.issuers.signing_key')}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-2"
                  onClick={() => setShowInlineKeyForm(value => !value)}
                >
                  {showInlineKeyForm
                    ? t('outbound_tokens.signing_keys.cancel_inline_create')
                    : t('outbound_tokens.signing_keys.inline_create')}
                </Button>
              </div>

              {signingKeysLoading && !signingKeysLoaded ? (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm text-text-muted flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('outbound_tokens.signing_keys.loading')}
                </div>
              ) : hasSelectableSigningKeys ? (
                <Select
                  key={`signing-key-select-${signingKeyOptions.map(key => key.id).join('-') || 'empty'}-${issuerForm.signingKeyId || 'none'}`}
                  value={issuerForm.signingKeyId}
                  onValueChange={value => setIssuerForm(prev => ({ ...prev, signingKeyId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('outbound_tokens.issuers.signing_key_placeholder')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {signingKeyOptions.map(key => (
                      <SelectItem key={key.id} value={String(key.id)} disabled={!key.is_active}>
                        {key.name} ({key.kid})
                        {key.is_active ? '' : ` - ${t('outbound_tokens.common.status_disabled')}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-3 text-sm">
                  <div className="font-medium text-text-primary">
                    {t('outbound_tokens.issuers.no_signing_keys_title')}
                  </div>
                  <p className="text-text-muted mt-1">
                    {t('outbound_tokens.issuers.no_signing_keys_description')}
                  </p>
                </div>
              )}

              {showInlineKeyForm && (
                <div className="rounded-md border border-border bg-base p-3 space-y-3">
                  <div className="text-sm font-medium text-text-primary">
                    {t('outbound_tokens.signing_keys.inline_create_title')}
                  </div>
                  <Input
                    value={inlineKeyForm.name}
                    onChange={e => setInlineKeyForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder={t('outbound_tokens.signing_keys.name_placeholder')}
                  />
                  <Textarea
                    value={inlineKeyForm.description}
                    onChange={e =>
                      setInlineKeyForm(prev => ({ ...prev, description: e.target.value }))
                    }
                    placeholder={t('outbound_tokens.signing_keys.description_placeholder')}
                    rows={3}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleCreateInlineSigningKey}
                      disabled={isCreatingInlineKey}
                    >
                      {isCreatingInlineKey && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      {t('outbound_tokens.signing_keys.create')}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.issuers.audience')}
                </label>
                <Input
                  value={issuerForm.audience}
                  onChange={e => setIssuerForm(prev => ({ ...prev, audience: e.target.value }))}
                  placeholder={t('outbound_tokens.issuers.audience_placeholder')}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.common.enabled')}
                </label>
                <div className="h-10 px-3 rounded-lg border border-border flex items-center justify-between">
                  <span className="text-sm text-text-secondary">
                    {issuerForm.enabled
                      ? t('outbound_tokens.common.status_active')
                      : t('outbound_tokens.common.status_disabled')}
                  </span>
                  <Switch
                    checked={issuerForm.enabled}
                    onCheckedChange={checked =>
                      setIssuerForm(prev => ({ ...prev, enabled: checked }))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.issuers.default_ttl')}
                </label>
                <Input
                  type="number"
                  min={60}
                  value={issuerForm.defaultTtlSeconds}
                  onChange={e =>
                    setIssuerForm(prev => ({ ...prev, defaultTtlSeconds: e.target.value }))
                  }
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.issuers.max_ttl')}
                </label>
                <Input
                  type="number"
                  min={60}
                  value={issuerForm.maxTtlSeconds}
                  onChange={e =>
                    setIssuerForm(prev => ({ ...prev, maxTtlSeconds: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.common.description')}
              </label>
              <Textarea
                value={issuerForm.description}
                onChange={e => setIssuerForm(prev => ({ ...prev, description: e.target.value }))}
                placeholder={t('outbound_tokens.common.description_placeholder')}
                rows={4}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleIssuerDialogChange(false)}
              disabled={isSavingIssuer || isCreatingInlineKey}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleSaveIssuer} disabled={isSavingIssuer || isCreatingInlineKey}>
              {isSavingIssuer && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {issuerDialogMode === 'create'
                ? t('common:actions.create')
                : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pemTarget} onOpenChange={open => !open && setPemTarget(null)}>
        <DialogContent className="sm:max-w-[720px] bg-surface">
          <DialogHeader>
            <DialogTitle>{pemTarget?.title}</DialogTitle>
            <DialogDescription>
              {t('outbound_tokens.pem_dialog.description', {
                name: pemTarget?.name,
                kid: pemTarget?.kid,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Textarea
              value={pemTarget?.publicKeyPem || ''}
              readOnly
              rows={12}
              className="font-mono text-xs"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() =>
                  pemTarget &&
                  handleCopyPem(pemTarget.publicKeyPem, `${pemTarget.name}:${pemTarget.kid}`)
                }
              >
                {copiedPemTarget === `${pemTarget?.name}:${pemTarget?.kid}` ? (
                  <CheckIcon className="w-4 h-4 mr-2" />
                ) : (
                  <ClipboardDocumentIcon className="w-4 h-4 mr-2" />
                )}
                {t('outbound_tokens.actions.copy_pem')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && !isDeleting && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('outbound_tokens.common.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'issuer'
                ? t('outbound_tokens.issuers.delete_confirm_message', {
                    name: deleteTarget.issuer.name,
                  })
                : t('outbound_tokens.signing_keys.delete_confirm_message', {
                    name: deleteTarget?.key.name,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault()
                handleDelete()
              }}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default OutboundTokenIssuerList
