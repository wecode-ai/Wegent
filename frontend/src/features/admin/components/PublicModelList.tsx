// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { CpuChipIcon } from '@heroicons/react/24/outline'
import { Loader2, Search, X } from 'lucide-react'
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
import {
  adminApis,
  AdminPublicModel,
  AdminPublicModelCreate,
  AdminPublicModelUpdate,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { Pagination } from '@/components/ui/pagination'
import { ModelPrimaryGroupIconSettings } from './ModelPrimaryGroupIconSettings'
import { PublicModelCardList } from './PublicModelCardList'
import {
  getPublicModelAllowedUsersEnabledFromConfig,
  getPublicModelAllowedUsersFromConfig,
  getPublicModelSpec,
  getPublicModelSpecBoolean,
  getPublicModelSpecValue,
  getPublicModelVisibilityFromConfig,
  parseAllowedUsersInput,
  parsePublicModelConfig,
  setPublicModelAllowedUsersEnabledInConfig,
  setPublicModelAllowedUsersInConfig,
  setPublicModelVisibilityInConfig,
} from './publicModelConfig'

const PUBLIC_MODELS_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

const parsePageParam = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

const PublicModelList: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialSearch = searchParams?.get('search')?.trim() ?? ''
  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => parsePageParam(searchParams?.get('page') ?? null))
  const [search, setSearch] = useState(initialSearch)
  const [searchQuery, setSearchQuery] = useState(initialSearch)
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AdminPublicModel | null>(null)

  // Form states
  const [formData, setFormData] = useState<{
    name: string
    namespace: string
    modelGroup: string
    modelSubGroup: string
    config: string
    is_active: boolean
    is_visible: boolean
    is_advanced: boolean
    is_wework_available: boolean
    allowed_users: string
    allowed_users_enabled: boolean
  }>({
    name: '',
    namespace: 'default',
    modelGroup: '',
    modelSubGroup: '',
    config: '{}',
    is_active: true,
    is_visible: true,
    is_advanced: false,
    is_wework_available: false,
    allowed_users: '',
    allowed_users_enabled: false,
  })
  const [configError, setConfigError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [resultsScope, setResultsScope] = useState<{ search: string; page: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const activeScopeRef = useRef({ search, page })
  const resultsScopeRef = useRef<{ search: string; page: number } | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    activeScopeRef.current = { search, page }
  }, [page, search])

  const fetchModels = useCallback(async () => {
    const requestId = ++requestIdRef.current
    const requestScope = { search, page }
    const isActiveScope = () => {
      const active = activeScopeRef.current
      return requestScope.search === active.search && requestScope.page === active.page
    }
    const lastResultsScope = resultsScopeRef.current
    const sameScopeRefresh = lastResultsScope?.search === search && lastResultsScope?.page === page
    setRefreshing(sameScopeRefresh)
    setLoading(!sameScopeRefresh)
    setLoadError(false)
    try {
      const response = await adminApis.getPublicModels(
        page,
        PUBLIC_MODELS_PAGE_SIZE,
        search || undefined
      )
      if (requestId !== requestIdRef.current || !isActiveScope()) return
      setModels(response.items)
      setTotal(response.total)
      resultsScopeRef.current = { search, page }
      setResultsScope({ search, page })
    } catch (_error) {
      if (requestId !== requestIdRef.current || !isActiveScope()) return
      setLoadError(true)
    } finally {
      if (requestId === requestIdRef.current && isActiveScope()) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [page, search])

  useEffect(() => {
    fetchModels()
  }, [fetchModels, refreshToken])

  // Persist the committed search and page in the URL so a refresh restores them.
  useEffect(() => {
    const currentParams = searchParams?.toString() ?? ''
    const params = new URLSearchParams(currentParams)
    if (search) {
      params.set('search', search)
    } else {
      params.delete('search')
    }
    if (page > 1) {
      params.set('page', String(page))
    } else {
      params.delete('page')
    }
    const nextParams = params.toString()
    if (nextParams !== currentParams) {
      router.replace(nextParams ? `?${nextParams}` : '?', { scroll: false })
    }
  }, [page, router, search, searchParams])

  const totalPages = Math.max(1, Math.ceil(total / PUBLIC_MODELS_PAGE_SIZE))
  const hasCurrentSearchResults = resultsScope?.search === search
  const hasCurrentResults = hasCurrentSearchResults && resultsScope?.page === page
  const hasVisibleResults = hasCurrentResults && models.length > 0

  // Keep the current page valid after deletions or a stale URL page. Only clamp
  // after a successful response for the current search, so a failed request
  // cannot move the user away from a valid requested page.
  useEffect(() => {
    if (!loading && hasCurrentSearchResults && page > totalPages) {
      setPage(totalPages)
    }
  }, [hasCurrentSearchResults, loading, page, totalPages])

  // Debounce typing, then commit the search and return to the first page.
  const trimmedSearchQuery = searchQuery.trim()
  useEffect(() => {
    if (trimmedSearchQuery === search) return
    const timer = setTimeout(() => {
      setSearch(trimmedSearchQuery)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, trimmedSearchQuery])

  const validateConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setConfigError(t('admin:public_models.errors.config_required'))
      return null
    }
    const parsed = parsePublicModelConfig(value)
    if (!parsed) {
      setConfigError(t('admin:public_models.errors.config_invalid_json'))
      return null
    }
    setConfigError('')
    return parsed
  }

  const applyGroupingToConfig = (config: Record<string, unknown>) => {
    const nextConfig = { ...config }
    const spec = getPublicModelSpec(nextConfig)
    const trimmedGroup = formData.modelGroup.trim()
    const trimmedSubGroup = formData.modelSubGroup.trim()

    if (trimmedGroup) {
      spec.modelGroup = trimmedGroup
    } else {
      delete spec.modelGroup
    }
    if (trimmedSubGroup) {
      spec.modelSubGroup = trimmedSubGroup
    } else {
      delete spec.modelSubGroup
    }

    if (formData.is_wework_available) {
      spec.isWeworkAvailable = true
    } else {
      delete spec.isWeworkAvailable
    }
    spec.isVisible = formData.is_visible

    if (formData.allowed_users_enabled) {
      spec.allowedUsersEnabled = true
      const allowedUsers = parseAllowedUsersInput(formData.allowed_users)
      if (allowedUsers.length > 0) {
        spec.allowedUsers = allowedUsers
      } else {
        delete spec.allowedUsers
      }
    } else {
      delete spec.allowedUsersEnabled
      // Keep spec.allowedUsers as-is so the list is retained (but not enforced)
      // when the switch is off.
    }

    nextConfig.spec = spec
    return nextConfig
  }

  const handleConfigChange = (value: string) => {
    const config = validateConfig(value)
    const configVisibility = getPublicModelVisibilityFromConfig(value)
    setFormData(current => ({
      ...current,
      config: value,
      ...(config
        ? {
            modelGroup: getPublicModelSpecValue(config, 'modelGroup'),
            modelSubGroup: getPublicModelSpecValue(config, 'modelSubGroup'),
          }
        : {}),
      ...(configVisibility === undefined ? {} : { is_visible: configVisibility }),
      ...(config ? { allowed_users: getPublicModelAllowedUsersFromConfig(value).join(', ') } : {}),
      ...(config
        ? { allowed_users_enabled: getPublicModelAllowedUsersEnabledFromConfig(value) }
        : {}),
    }))
  }

  const handleAllowedUsersEnabledChange = (enabled: boolean) => {
    setFormData(current => ({
      ...current,
      allowed_users_enabled: enabled,
      config: setPublicModelAllowedUsersEnabledInConfig(current.config, enabled),
    }))
  }

  const handleAllowedUsersChange = (value: string) => {
    setFormData(current => ({
      ...current,
      allowed_users: value,
      config: setPublicModelAllowedUsersInConfig(current.config, parseAllowedUsersInput(value)),
    }))
  }

  const handleGroupChange = (key: 'modelGroup' | 'modelSubGroup', value: string) => {
    const config = validateConfig(formData.config)
    if (!config) return

    const spec = getPublicModelSpec(config)
    const trimmedValue = value.trim()
    if (trimmedValue) {
      spec[key] = trimmedValue
    } else {
      delete spec[key]
    }

    setFormData(current => ({
      ...current,
      [key]: value,
      config: JSON.stringify({ ...config, spec }, null, 2),
    }))
  }

  const handleVisibilityChange = (isVisible: boolean) => {
    if (!validateConfig(formData.config)) {
      return
    }
    setFormData(current => ({
      ...current,
      is_visible: isVisible,
      config: setPublicModelVisibilityInConfig(current.config, isVisible),
    }))
  }

  const handleCreateModel = async () => {
    if (!formData.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.name_required'),
      })
      return
    }

    const parsedConfig = validateConfig(formData.config)
    if (!parsedConfig) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const config = applyGroupingToConfig(parsedConfig)
      const createData: AdminPublicModelCreate = {
        name: formData.name.trim(),
        namespace: formData.namespace.trim() || 'default',
        json: config,
        is_visible: formData.is_visible,
      }
      await adminApis.createPublicModel(createData)
      toast({ title: t('admin:public_models.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      setRefreshToken(token => token + 1)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateModel = async () => {
    if (!selectedModel) return

    const parsedConfig = validateConfig(formData.config)
    if (!parsedConfig) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const config = applyGroupingToConfig(parsedConfig)
      const updateData: AdminPublicModelUpdate = {}
      if (formData.name !== selectedModel.name) {
        updateData.name = formData.name
      }
      if (formData.namespace !== selectedModel.namespace) {
        updateData.namespace = formData.namespace
      }
      updateData.json = config
      if (formData.is_active !== selectedModel.is_active) {
        updateData.is_active = formData.is_active
      }
      if (formData.is_visible !== selectedModel.is_visible) {
        updateData.is_visible = formData.is_visible
      }
      if (formData.is_advanced !== (selectedModel.is_advanced ?? false)) {
        updateData.is_advanced = formData.is_advanced
      }

      await adminApis.updatePublicModel(selectedModel.id, updateData)
      toast({ title: t('admin:public_models.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      setRefreshToken(token => token + 1)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteModel = async () => {
    if (!selectedModel) return

    setSaving(true)
    try {
      await adminApis.deletePublicModel(selectedModel.id)
      toast({ title: t('admin:public_models.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedModel(null)
      setRefreshToken(token => token + 1)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      namespace: 'default',
      modelGroup: '',
      modelSubGroup: '',
      config: '{}',
      is_active: true,
      is_visible: true,
      is_advanced: false,
      is_wework_available: false,
      allowed_users: '',
      allowed_users_enabled: false,
    })
    setConfigError('')
    setSelectedModel(null)
  }

  const openEditDialog = (model: AdminPublicModel) => {
    setSelectedModel(model)
    setFormData({
      name: model.name,
      namespace: model.namespace,
      modelGroup: getPublicModelSpecValue(model.json, 'modelGroup'),
      modelSubGroup: getPublicModelSpecValue(model.json, 'modelSubGroup'),
      config: JSON.stringify(model.json, null, 2),
      is_active: model.is_active,
      is_visible: model.is_visible,
      is_advanced: model.is_advanced ?? false,
      is_wework_available: getPublicModelSpecBoolean(model.json, 'isWeworkAvailable'),
      allowed_users: getPublicModelAllowedUsersFromConfig(JSON.stringify(model.json)).join(', '),
      allowed_users_enabled: getPublicModelAllowedUsersEnabledFromConfig(
        JSON.stringify(model.json)
      ),
    })
    setIsEditDialogOpen(true)
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">
            {t('admin:public_models.title')}
          </h2>
          <p className="text-sm text-text-muted">{t('admin:public_models.description')}</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <Input
            type="text"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={t('admin:public_models.search_placeholder')}
            aria-label={t('admin:public_models.search_placeholder')}
            className="h-11 pl-9 pr-12 md:h-9 md:pr-10"
            data-testid="public-model-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label={t('admin:public_models.clear_search')}
              data-testid="public-model-search-clear"
              className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-muted hover:text-text-primary md:right-2 md:h-8 md:w-8"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Same-scope refresh keeps the current list visible */}
        {refreshing && (
          <div
            className="flex items-center justify-center py-2"
            role="status"
            data-testid="public-model-refreshing"
          >
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
        )}

        {/* Load Error */}
        {!loading && loadError && (
          <div
            className={
              hasVisibleResults
                ? 'flex items-center justify-between gap-3 rounded-md border border-error/40 bg-error/10 px-3 py-2'
                : 'flex flex-col items-center justify-center gap-3 py-12 text-center'
            }
            role="alert"
          >
            <p className="text-sm text-text-muted">{t('admin:public_models.errors.load_failed')}</p>
            <Button variant="outline" onClick={fetchModels} data-testid="public-model-load-retry">
              {t('common:common.retry')}
            </Button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !loadError && hasCurrentResults && models.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">
              {search
                ? t('admin:public_models.no_search_results', { search })
                : t('admin:public_models.no_models')}
            </p>
          </div>
        )}

        {/* Model List */}
        {!loading && hasCurrentResults && models.length > 0 && (
          <PublicModelCardList
            models={models}
            onEdit={openEditDialog}
            onDelete={model => {
              setSelectedModel(model)
              setIsDeleteDialogOpen(true)
            }}
          />
        )}

        {/* Footer: add actions and pagination */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex flex-wrap justify-center gap-2">
              <ModelPrimaryGroupIconSettings
                groups={
                  hasCurrentResults
                    ? models
                        .map(model => getPublicModelSpecValue(model.json, 'modelGroup').trim())
                        .filter(Boolean)
                    : []
                }
              />
              <UnifiedAddButton onClick={() => setIsCreateDialogOpen(true)}>
                {t('admin:public_models.create_model')}
              </UnifiedAddButton>
            </div>
            {(!loadError || hasCurrentSearchResults) && (
              <Pagination
                page={page}
                totalPages={totalPages}
                totalCount={total}
                pageSize={PUBLIC_MODELS_PAGE_SIZE}
                showPageSizeSelector={false}
                onGoToPage={setPage}
                totalCountLabel={t('admin:public_models.pagination.total_count', { count: total })}
              />
            )}
          </div>
        )}
      </div>

      {/* Create Model Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('admin:public_models.create_model')}</DialogTitle>
            <DialogDescription>{t('admin:public_models.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('admin:public_models.form.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:public_models.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namespace">{t('admin:public_models.form.namespace')}</Label>
              <Input
                id="namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('admin:public_models.form.namespace_placeholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="model-group">{t('admin:public_models.form.model_group')}</Label>
                <Input
                  id="model-group"
                  data-testid="public-model-group-input"
                  value={formData.modelGroup}
                  onChange={e => handleGroupChange('modelGroup', e.target.value)}
                  placeholder={t('admin:public_models.form.model_group_placeholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="model-sub-group">
                  {t('admin:public_models.form.model_sub_group')}
                </Label>
                <Input
                  id="model-sub-group"
                  data-testid="public-model-sub-group-input"
                  value={formData.modelSubGroup}
                  onChange={e => handleGroupChange('modelSubGroup', e.target.value)}
                  placeholder={t('admin:public_models.form.model_sub_group_placeholder')}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="allowed-users-enabled">
                  {t('admin:public_models.form.allowed_users_enabled')}
                </Label>
                <Switch
                  id="allowed-users-enabled"
                  data-testid="public-model-allowed-users-enabled-switch"
                  checked={formData.allowed_users_enabled}
                  onCheckedChange={handleAllowedUsersEnabledChange}
                />
              </div>
              <p className="text-xs text-text-muted">
                {t('admin:public_models.form.allowed_users_enabled_hint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="allowed-users">{t('admin:public_models.form.allowed_users')}</Label>
              <Input
                id="allowed-users"
                data-testid="public-model-allowed-users-input"
                value={formData.allowed_users}
                onChange={e => handleAllowedUsersChange(e.target.value)}
                placeholder={t('admin:public_models.form.allowed_users_placeholder')}
                disabled={!formData.allowed_users_enabled}
              />
              <p className="text-xs text-text-muted">
                {t('admin:public_models.form.allowed_users_hint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="config">{t('admin:public_models.form.config')} *</Label>
              <Textarea
                id="config"
                value={formData.config}
                onChange={e => handleConfigChange(e.target.value)}
                placeholder={t('admin:public_models.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="create-is-visible">{t('admin:public_models.form.is_visible')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_visible
                    ? t('admin:public_models.status.visible')
                    : t('admin:public_models.status.hidden')}
                </span>
                <Switch
                  id="create-is-visible"
                  data-testid="public-model-create-visible-switch"
                  checked={formData.is_visible}
                  onCheckedChange={handleVisibilityChange}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="create-is-wework-available">
                {t('admin:public_models.form.is_wework_available')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_wework_available
                    ? t('admin:public_models.status.wework_available')
                    : t('admin:public_models.status.wework_unavailable')}
                </span>
                <Switch
                  id="create-is-wework-available"
                  data-testid="public-model-wework-available-switch"
                  checked={formData.is_wework_available}
                  onCheckedChange={checked =>
                    setFormData({ ...formData, is_wework_available: checked })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleCreateModel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Model Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('admin:public_models.edit_model')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('admin:public_models.form.name')}</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:public_models.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-namespace">{t('admin:public_models.form.namespace')}</Label>
              <Input
                id="edit-namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('admin:public_models.form.namespace_placeholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-model-group">
                  {t('admin:public_models.form.model_group')}
                </Label>
                <Input
                  id="edit-model-group"
                  data-testid="edit-public-model-group-input"
                  value={formData.modelGroup}
                  onChange={e => handleGroupChange('modelGroup', e.target.value)}
                  placeholder={t('admin:public_models.form.model_group_placeholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-model-sub-group">
                  {t('admin:public_models.form.model_sub_group')}
                </Label>
                <Input
                  id="edit-model-sub-group"
                  data-testid="edit-public-model-sub-group-input"
                  value={formData.modelSubGroup}
                  onChange={e => handleGroupChange('modelSubGroup', e.target.value)}
                  placeholder={t('admin:public_models.form.model_sub_group_placeholder')}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-allowed-users-enabled">
                  {t('admin:public_models.form.allowed_users_enabled')}
                </Label>
                <Switch
                  id="edit-allowed-users-enabled"
                  data-testid="edit-public-model-allowed-users-enabled-switch"
                  checked={formData.allowed_users_enabled}
                  onCheckedChange={handleAllowedUsersEnabledChange}
                />
              </div>
              <p className="text-xs text-text-muted">
                {t('admin:public_models.form.allowed_users_enabled_hint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-allowed-users">
                {t('admin:public_models.form.allowed_users')}
              </Label>
              <Input
                id="edit-allowed-users"
                data-testid="edit-public-model-allowed-users-input"
                value={formData.allowed_users}
                onChange={e => handleAllowedUsersChange(e.target.value)}
                placeholder={t('admin:public_models.form.allowed_users_placeholder')}
                disabled={!formData.allowed_users_enabled}
              />
              <p className="text-xs text-text-muted">
                {t('admin:public_models.form.allowed_users_hint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-config">{t('admin:public_models.form.config')}</Label>
              <Textarea
                id="edit-config"
                value={formData.config}
                onChange={e => handleConfigChange(e.target.value)}
                placeholder={t('admin:public_models.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-active">{t('admin:public_models.columns.status')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_active
                    ? t('admin:public_models.status.active')
                    : t('admin:public_models.status.inactive')}
                </span>
                <Switch
                  id="edit-is-active"
                  checked={formData.is_active}
                  onCheckedChange={checked => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-visible">{t('admin:public_models.form.is_visible')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_visible
                    ? t('admin:public_models.status.visible')
                    : t('admin:public_models.status.hidden')}
                </span>
                <Switch
                  id="edit-is-visible"
                  data-testid="public-model-edit-visible-switch"
                  checked={formData.is_visible}
                  onCheckedChange={handleVisibilityChange}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-advanced">{t('admin:public_models.form.is_advanced')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_advanced
                    ? t('admin:public_models.status.advanced')
                    : t('admin:public_models.status.standard')}
                </span>
                <Switch
                  id="edit-is-advanced"
                  checked={formData.is_advanced}
                  onCheckedChange={checked => setFormData({ ...formData, is_advanced: checked })}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-wework-available">
                {t('admin:public_models.form.is_wework_available')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_wework_available
                    ? t('admin:public_models.status.wework_available')
                    : t('admin:public_models.status.wework_unavailable')}
                </span>
                <Switch
                  id="edit-is-wework-available"
                  data-testid="public-model-edit-wework-available-switch"
                  checked={formData.is_wework_available}
                  onCheckedChange={checked =>
                    setFormData({ ...formData, is_wework_available: checked })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleUpdateModel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:public_models.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:public_models.confirm.delete_message', { name: selectedModel?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-delete-public-model">
              {t('admin:common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteModel}
              className="bg-error hover:bg-error/90"
              data-testid="confirm-delete-public-model"
            >
              {t('admin:common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default PublicModelList
