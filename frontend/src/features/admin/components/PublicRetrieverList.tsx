// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import {
  CircleStackIcon,
  PencilIcon,
  TrashIcon,
  GlobeAltIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
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
import { adminApis, AdminPublicRetriever, RetrieverCRD } from '@/apis/admin'
import { retrieverApis, RetrievalMethodType } from '@/apis/retrievers'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import {
  RetrieverFormFields,
  RetrieverFormData,
  defaultFormData,
  STORAGE_TYPE_CONFIG,
  IndexModeType,
} from './RetrieverFormFields'

/**
 * Kubernetes-style resource name validation pattern.
 * Rules:
 * - Must start and end with alphanumeric character (a-z, 0-9)
 * - May contain hyphens (-) in the middle
 * - Single character names are allowed (just alphanumeric)
 * - Examples: "my-retriever", "retriever1", "a", "my-test-retriever-01"
 */
const KUBERNETES_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

/**
 * Default weights for hybrid retrieval methods.
 * Vector search typically has higher weight as it captures semantic meaning.
 * Keyword search complements with exact term matching.
 * Total should sum to 1.0 for normalized scoring.
 */
const DEFAULT_VECTOR_WEIGHT = 0.7
const DEFAULT_KEYWORD_WEIGHT = 0.3

/**
 * Default page size for fetching public retrievers.
 * Using a larger value to minimize pagination requests in admin view.
 */
const DEFAULT_PAGE_SIZE = 100

const PublicRetrieverList: React.FC = () => {
  const { t } = useTranslation(['admin', 'common', 'wizard'])
  const { toast } = useToast()
  const [retrievers, setRetrievers] = useState<AdminPublicRetriever[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedRetriever, setSelectedRetriever] = useState<AdminPublicRetriever | null>(null)

  // Form states
  const [formData, setFormData] = useState<RetrieverFormData>(defaultFormData)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  // Retrieval methods state
  const [availableRetrievalMethods, setAvailableRetrievalMethods] = useState<RetrievalMethodType[]>(
    [...STORAGE_TYPE_CONFIG.elasticsearch.fallbackRetrievalMethods]
  )
  const [loadingRetrievalMethods, setLoadingRetrievalMethods] = useState(false)

  const fetchRetrievers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPublicRetrievers(page, DEFAULT_PAGE_SIZE)
      setRetrievers(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_retrievers.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  useEffect(() => {
    fetchRetrievers()
  }, [fetchRetrievers])

  // Fetch retrieval methods for a storage type from API
  const fetchRetrievalMethods = useCallback(async (type: 'elasticsearch' | 'qdrant') => {
    setLoadingRetrievalMethods(true)
    try {
      const response = await retrieverApis.getStorageTypeRetrievalMethods(type)
      const methods = response.retrieval_methods as RetrievalMethodType[]
      setAvailableRetrievalMethods(methods)
      return methods
    } catch (error) {
      console.error('Failed to fetch retrieval methods:', error)
      const fallback = [...STORAGE_TYPE_CONFIG[type].fallbackRetrievalMethods]
      setAvailableRetrievalMethods(fallback)
      return fallback
    } finally {
      setLoadingRetrievalMethods(false)
    }
  }, [])

  // Handle retrieval method toggle
  const handleRetrievalMethodToggle = useCallback(
    (method: RetrievalMethodType, checked: boolean) => {
      setFormData(prev => {
        const currentMethods = prev.enabledRetrievalMethods
        if (checked) {
          return {
            ...prev,
            enabledRetrievalMethods: currentMethods.includes(method)
              ? currentMethods
              : [...currentMethods, method],
          }
        } else {
          const newMethods = currentMethods.filter(m => m !== method)
          return {
            ...prev,
            enabledRetrievalMethods: newMethods.length > 0 ? newMethods : currentMethods,
          }
        }
      })
    },
    []
  )

  const formToRetrieverCRD = (data: RetrieverFormData): RetrieverCRD => {
    // Build retrieval methods config
    const retrievalMethodsConfig: RetrieverCRD['spec']['retrievalMethods'] = {
      vector: {
        enabled: data.enabledRetrievalMethods.includes('vector'),
        defaultWeight: DEFAULT_VECTOR_WEIGHT,
      },
      keyword: {
        enabled: data.enabledRetrievalMethods.includes('keyword'),
        defaultWeight: DEFAULT_KEYWORD_WEIGHT,
      },
      hybrid: {
        enabled: data.enabledRetrievalMethods.includes('hybrid'),
      },
    }

    return {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Retriever',
      metadata: {
        name: data.name,
        namespace: data.namespace,
        displayName: data.displayName || undefined,
      },
      spec: {
        storageConfig: {
          type: data.storageType,
          url: data.url,
          ...(data.username && { username: data.username }),
          ...(data.password && { password: data.password }),
          ...(data.apiKey && { apiKey: data.apiKey }),
          indexStrategy: {
            mode: data.indexMode,
            ...(data.indexMode === 'fixed' && { fixedName: data.fixedName }),
            ...(data.indexMode === 'rolling' && { rollingStep: parseInt(data.rollingStep) }),
            ...(data.prefix && { prefix: data.prefix }),
          },
        },
        retrievalMethods: retrievalMethodsConfig,
      },
    }
  }

  const retrieverToFormData = (retriever: AdminPublicRetriever): RetrieverFormData => {
    const json = retriever.json
    const spec = json?.spec || ({} as RetrieverCRD['spec'])
    const storageConfig = spec?.storageConfig || {}
    const indexStrategy = storageConfig?.indexStrategy || {}

    // Parse enabled retrieval methods
    const enabledMethods: RetrievalMethodType[] = []
    if (spec.retrievalMethods) {
      if (spec.retrievalMethods.vector?.enabled) enabledMethods.push('vector')
      if (spec.retrievalMethods.keyword?.enabled) enabledMethods.push('keyword')
      if (spec.retrievalMethods.hybrid?.enabled) enabledMethods.push('hybrid')
    }
    if (enabledMethods.length === 0) {
      enabledMethods.push('vector')
    }

    return {
      name: retriever.name,
      displayName: retriever.displayName || '',
      namespace: retriever.namespace,
      storageType: (storageConfig.type as 'elasticsearch' | 'qdrant') || 'elasticsearch',
      url: storageConfig.url || '',
      username: storageConfig.username || '',
      password: (storageConfig as { password?: string }).password || '',
      apiKey: storageConfig.apiKey || '',
      indexMode: (indexStrategy.mode as IndexModeType) || 'per_user',
      fixedName: indexStrategy.fixedName || '',
      rollingStep: String(indexStrategy.rollingStep || 5000),
      prefix: indexStrategy.prefix || 'wegent',
      enabledRetrievalMethods: enabledMethods,
    }
  }

  const handleStorageTypeChange = async (value: 'elasticsearch' | 'qdrant') => {
    const config = STORAGE_TYPE_CONFIG[value]
    const availableMethods = await fetchRetrievalMethods(value)

    setFormData(prev => ({
      ...prev,
      storageType: value,
      url: config.defaultUrl,
      indexMode: config.recommendedIndexMode,
      enabledRetrievalMethods: [...availableMethods],
    }))
  }

  const handleTestConnection = async () => {
    if (!formData.url) {
      toast({
        variant: 'destructive',
        title: t('common:retrievers.url_required'),
      })
      return
    }

    setTesting(true)
    try {
      const result = await retrieverApis.testConnection({
        storage_type: formData.storageType,
        url: formData.url,
        username: formData.username || undefined,
        password: formData.password || undefined,
        api_key: formData.apiKey || undefined,
      })

      if (result.success) {
        toast({
          title: t('common:retrievers.test_success'),
          description: result.message,
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('common:retrievers.test_failed'),
          description: result.message,
        })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:retrievers.test_failed'),
        description: (error as Error).message,
      })
    } finally {
      setTesting(false)
    }
  }

  // Validation helper: show error toast and return false
  const showValidationError = (title: string, description?: string): false => {
    toast({ variant: 'destructive', title, description })
    return false
  }

  // Validate retriever name (required + Kubernetes naming convention)
  const validateName = (): boolean => {
    if (!formData.name.trim()) {
      return showValidationError(t('admin:public_retrievers.errors.name_required'))
    }
    if (!KUBERNETES_NAME_REGEX.test(formData.name)) {
      return showValidationError(
        t('common:retrievers.name_invalid'),
        t('common:retrievers.name_invalid_hint')
      )
    }
    return true
  }

  // Validate URL (required)
  const validateUrl = (): boolean => {
    if (!formData.url.trim()) {
      return showValidationError(t('admin:public_retrievers.errors.url_required'))
    }
    return true
  }

  // Validate index strategy specific fields
  const validateIndexStrategy = (): boolean => {
    const { indexMode, fixedName, rollingStep, prefix } = formData

    if (indexMode === 'fixed' && !fixedName.trim()) {
      return showValidationError(t('common:retrievers.fixed_index_name_empty'))
    }

    if (indexMode === 'rolling') {
      const step = parseInt(rollingStep)
      if (isNaN(step) || step <= 0) {
        return showValidationError(t('common:retrievers.rolling_step_invalid'))
      }
      if (!prefix.trim()) {
        return showValidationError(t('common:retrievers.rolling_prefix_required'))
      }
    }

    if ((indexMode === 'per_dataset' || indexMode === 'per_user') && !prefix.trim()) {
      return showValidationError(t('common:retrievers.per_dataset_prefix_required'))
    }

    return true
  }

  // Main form validation - combines all validators
  const validateForm = (): boolean => {
    return validateName() && validateUrl() && validateIndexStrategy()
  }

  const handleCreateRetriever = async () => {
    if (!validateForm()) return

    setSaving(true)
    try {
      const retrieverData = formToRetrieverCRD(formData)
      await adminApis.createPublicRetriever(retrieverData)
      toast({ title: t('admin:public_retrievers.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchRetrievers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_retrievers.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateRetriever = async () => {
    if (!selectedRetriever) return
    if (!validateForm()) return

    setSaving(true)
    try {
      const retrieverData = formToRetrieverCRD(formData)
      await adminApis.updatePublicRetriever(selectedRetriever.id, retrieverData)
      toast({ title: t('admin:public_retrievers.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchRetrievers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_retrievers.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteRetriever = async () => {
    if (!selectedRetriever) return

    setSaving(true)
    try {
      await adminApis.deletePublicRetriever(selectedRetriever.id)
      toast({ title: t('admin:public_retrievers.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedRetriever(null)
      fetchRetrievers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_retrievers.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setFormData(defaultFormData)
    setSelectedRetriever(null)
    setShowPassword(false)
    setShowApiKey(false)
  }

  const openCreateDialog = async () => {
    resetForm()
    const methods = await fetchRetrievalMethods('elasticsearch')
    setFormData(prev => ({
      ...prev,
      enabledRetrievalMethods: [...methods],
    }))
    setIsCreateDialogOpen(true)
  }

  const openEditDialog = async (retriever: AdminPublicRetriever) => {
    setSelectedRetriever(retriever)
    const formDataFromRetriever = retrieverToFormData(retriever)
    setFormData(formDataFromRetriever)
    await fetchRetrievalMethods(formDataFromRetriever.storageType)
    setIsEditDialogOpen(true)
  }

  const getDisplayName = (retriever: AdminPublicRetriever): string => {
    return retriever.displayName || retriever.name
  }

  const getStorageTypeLabel = (storageType: string): string => {
    if (storageType === 'elasticsearch') return 'Elasticsearch'
    if (storageType === 'qdrant') return 'Qdrant'
    return storageType
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('admin:public_retrievers.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('admin:public_retrievers.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && retrievers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CircleStackIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:public_retrievers.no_retrievers')}</p>
          </div>
        )}

        {/* Retriever List */}
        {!loading && retrievers.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {retrievers.map(retriever => (
              <Card
                key={retriever.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {getDisplayName(retriever)}
                        </h3>
                        <Tag variant="info">{getStorageTypeLabel(retriever.storageType)}</Tag>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                        <span>
                          {t('admin:public_retrievers.form.name')}: {retriever.name}
                        </span>
                        {retriever.description && (
                          <>
                            <span>•</span>
                            <span className="truncate max-w-[300px]">{retriever.description}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(retriever)}
                      title={t('admin:public_retrievers.edit_retriever')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedRetriever(retriever)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('admin:public_retrievers.delete_retriever')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={openCreateDialog}>
                {t('admin:public_retrievers.create_retriever')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create Retriever Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('admin:public_retrievers.create_retriever')}</DialogTitle>
            <DialogDescription>{t('admin:public_retrievers.description')}</DialogDescription>
          </DialogHeader>
          <RetrieverFormFields
            formData={formData}
            setFormData={setFormData}
            isEditDialogOpen={false}
            availableRetrievalMethods={availableRetrievalMethods}
            loadingRetrievalMethods={loadingRetrievalMethods}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            showApiKey={showApiKey}
            setShowApiKey={setShowApiKey}
            handleStorageTypeChange={handleStorageTypeChange}
            handleRetrievalMethodToggle={handleRetrievalMethodToggle}
          />
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !formData.url}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <BeakerIcon className="w-4 h-4 mr-1" />
              {t('common:retrievers.test_connection')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                {t('admin:common.cancel')}
              </Button>
              <Button onClick={handleCreateRetriever} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('admin:common.create')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Retriever Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('admin:public_retrievers.edit_retriever')}</DialogTitle>
          </DialogHeader>
          <RetrieverFormFields
            formData={formData}
            setFormData={setFormData}
            isEditDialogOpen={true}
            availableRetrievalMethods={availableRetrievalMethods}
            loadingRetrievalMethods={loadingRetrievalMethods}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            showApiKey={showApiKey}
            setShowApiKey={setShowApiKey}
            handleStorageTypeChange={handleStorageTypeChange}
            handleRetrievalMethodToggle={handleRetrievalMethodToggle}
          />
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !formData.url}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <BeakerIcon className="w-4 h-4 mr-1" />
              {t('common:retrievers.test_connection')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                {t('admin:common.cancel')}
              </Button>
              <Button onClick={handleUpdateRetriever} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('admin:common.save')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:public_retrievers.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:public_retrievers.confirm.delete_message', {
                name: selectedRetriever?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin:common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRetriever}
              className="bg-error hover:bg-error/90"
            >
              {t('admin:common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default PublicRetrieverList
