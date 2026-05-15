// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '@/apis/client'
import {
  adminApis,
  SigningKey,
  TokenIssuer,
  TokenIssuerCreateRequest,
  TokenIssuerUpdateRequest,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { KeyIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'

import {
  DeleteTarget,
  InlineKeyFormState,
  IssuerFormState,
  PemTarget,
} from './OutboundTokenAdminTypes'
import OutboundTokenDeleteDialog from './OutboundTokenDeleteDialog'
import OutboundTokenIssuerCard from './OutboundTokenIssuerCard'
import OutboundTokenIssuerDialog from './OutboundTokenIssuerDialog'
import OutboundTokenPemDialog from './OutboundTokenPemDialog'
import OutboundTokenSigningKeysPanel from './OutboundTokenSigningKeysPanel'

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

  const activeIssuerNamesByKeyId = useMemo(() => {
    const names = new Map<number, string[]>()
    issuers.forEach(issuer => {
      if (!issuer.is_active) {
        return
      }
      names.set(issuer.signing_key_id, [...(names.get(issuer.signing_key_id) ?? []), issuer.name])
    })
    return names
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

  const handleIssuerFormChange = useCallback(
    <K extends keyof IssuerFormState>(field: K, value: IssuerFormState[K]) => {
      setIssuerForm(prev => ({ ...prev, [field]: value }))
    },
    []
  )

  const handleInlineKeyFormChange = useCallback(
    <K extends keyof InlineKeyFormState>(field: K, value: InlineKeyFormState[K]) => {
      setInlineKeyForm(prev => ({ ...prev, [field]: value }))
    },
    []
  )

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

  const handleViewIssuerPem = (issuer: TokenIssuer) => {
    setPemTarget({
      title: t('outbound_tokens.pem_dialog.issuer_title'),
      kid: issuer.signing_key_kid,
      name: issuer.signing_key_name,
      publicKeyPem: issuer.public_key_pem,
    })
  }

  const handleViewSigningKeyPem = (key: SigningKey) => {
    setPemTarget({
      title: t('outbound_tokens.pem_dialog.key_title'),
      kid: key.kid,
      name: key.name,
      publicKeyPem: key.public_key_pem,
    })
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
    const activeIssuerNames = activeIssuerNamesByKeyId.get(key.id) ?? []
    if (key.is_active && activeIssuerNames.length > 0) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.signing_keys.errors.toggle_failed'),
        description: t('outbound_tokens.signing_keys.errors.disable_blocked_by_active_issuers', {
          count: activeIssuerNames.length,
          names: activeIssuerNames.join('、'),
        }),
      })
      return
    }

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

  const handleRequestDeleteIssuer = (issuer: TokenIssuer) => {
    setDeleteTarget({ type: 'issuer', issuer })
  }

  const handleRequestDeleteSigningKey = (key: SigningKey) => {
    const activeIssuerNames = activeIssuerNamesByKeyId.get(key.id) ?? []
    if (activeIssuerNames.length > 0) {
      toast({
        variant: 'destructive',
        title: t('outbound_tokens.signing_keys.errors.delete_failed'),
        description: t('outbound_tokens.signing_keys.errors.delete_blocked_by_active_issuers', {
          count: activeIssuerNames.length,
          names: activeIssuerNames.join('、'),
        }),
      })
      return
    }
    setDeleteTarget({ type: 'key', key })
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

  const handleSigningKeysPanelToggle = () => {
    const next = !showSigningKeys
    setShowSigningKeys(next)
    if (next) {
      void loadSigningKeys()
    }
  }

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
        <UnifiedAddButton onClick={openCreateDialog} data-testid="create-outbound-token">
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
              <OutboundTokenIssuerCard
                key={issuer.id}
                issuer={issuer}
                togglingIssuerId={togglingIssuerId}
                formatDate={formatDate}
                formatTtl={formatTtl}
                onViewPem={handleViewIssuerPem}
                onEdit={openEditDialog}
                onToggle={handleToggleIssuerStatus}
                onDelete={handleRequestDeleteIssuer}
              />
            ))}
          </div>
        )}
      </div>

      <OutboundTokenSigningKeysPanel
        showSigningKeys={showSigningKeys}
        signingKeysLoading={signingKeysLoading}
        signingKeysLoaded={signingKeysLoaded}
        signingKeys={signingKeys}
        usageCounts={usageCounts}
        togglingKeyId={togglingKeyId}
        onTogglePanel={handleSigningKeysPanelToggle}
        onViewPem={handleViewSigningKeyPem}
        onToggle={handleToggleSigningKeyStatus}
        onDelete={handleRequestDeleteSigningKey}
      />

      <OutboundTokenIssuerDialog
        open={issuerDialogOpen}
        mode={issuerDialogMode}
        issuerForm={issuerForm}
        inlineKeyForm={inlineKeyForm}
        showInlineKeyForm={showInlineKeyForm}
        signingKeysLoading={signingKeysLoading}
        signingKeysLoaded={signingKeysLoaded}
        hasSelectableSigningKeys={hasSelectableSigningKeys}
        signingKeyOptions={signingKeyOptions}
        isSavingIssuer={isSavingIssuer}
        isCreatingInlineKey={isCreatingInlineKey}
        onOpenChange={handleIssuerDialogChange}
        onIssuerFormChange={handleIssuerFormChange}
        onInlineKeyFormChange={handleInlineKeyFormChange}
        onToggleInlineKeyForm={() => setShowInlineKeyForm(value => !value)}
        onCreateInlineSigningKey={handleCreateInlineSigningKey}
        onSave={handleSaveIssuer}
      />

      <OutboundTokenPemDialog
        pemTarget={pemTarget}
        copiedPemTarget={copiedPemTarget}
        onOpenChange={open => !open && setPemTarget(null)}
        onCopy={handleCopyPem}
      />

      <OutboundTokenDeleteDialog
        deleteTarget={deleteTarget}
        isDeleting={isDeleting}
        onOpenChange={open => !open && !isDeleting && setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </div>
  )
}

export default OutboundTokenIssuerList
