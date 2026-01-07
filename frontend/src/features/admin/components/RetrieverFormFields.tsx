// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { RetrievalMethodType } from '@/apis/retrievers'

// Storage type configuration for extensibility
export const STORAGE_TYPE_CONFIG = {
  elasticsearch: {
    defaultUrl: 'http://elasticsearch:9200',
    recommendedIndexMode: 'per_user' as const,
    authFields: {
      supportsUsernamePassword: true,
      supportsApiKey: false,
    },
    fallbackRetrievalMethods: ['vector', 'keyword', 'hybrid'] as const,
  },
  qdrant: {
    defaultUrl: 'http://localhost:6333',
    recommendedIndexMode: 'per_dataset' as const,
    authFields: {
      supportsUsernamePassword: false,
      supportsApiKey: true,
    },
    fallbackRetrievalMethods: ['vector'] as const,
  },
} as const

// Retrieval method labels for display
export const RETRIEVAL_METHOD_LABELS: Record<string, string> = {
  vector: 'common:retrievers.retrieval_method_vector',
  keyword: 'common:retrievers.retrieval_method_keyword',
  hybrid: 'common:retrievers.retrieval_method_hybrid',
}

export type IndexModeType = 'fixed' | 'rolling' | 'per_dataset' | 'per_user'

export interface RetrieverFormData {
  name: string
  displayName: string
  namespace: string
  storageType: 'elasticsearch' | 'qdrant'
  url: string
  username: string
  password: string
  apiKey: string
  indexMode: IndexModeType
  fixedName: string
  rollingStep: string
  prefix: string
  enabledRetrievalMethods: RetrievalMethodType[]
}

export const defaultFormData: RetrieverFormData = {
  name: '',
  displayName: '',
  namespace: 'default',
  storageType: 'elasticsearch',
  url: '',
  username: '',
  password: '',
  apiKey: '',
  indexMode: 'per_user',
  fixedName: '',
  rollingStep: '5000',
  prefix: 'wegent',
  enabledRetrievalMethods: ['vector', 'keyword', 'hybrid'],
}

interface RetrieverFormFieldsProps {
  formData: RetrieverFormData
  setFormData: React.Dispatch<React.SetStateAction<RetrieverFormData>>
  isEditDialogOpen: boolean
  availableRetrievalMethods: RetrievalMethodType[]
  loadingRetrievalMethods: boolean
  showPassword: boolean
  setShowPassword: (show: boolean) => void
  showApiKey: boolean
  setShowApiKey: (show: boolean) => void
  handleStorageTypeChange: (value: 'elasticsearch' | 'qdrant') => void
  handleRetrievalMethodToggle: (method: RetrievalMethodType, checked: boolean) => void
}

export const RetrieverFormFields: React.FC<RetrieverFormFieldsProps> = ({
  formData,
  setFormData,
  isEditDialogOpen,
  availableRetrievalMethods,
  loadingRetrievalMethods,
  showPassword,
  setShowPassword,
  showApiKey,
  setShowApiKey,
  handleStorageTypeChange,
  handleRetrievalMethodToggle,
}) => {
  const { t } = useTranslation(['admin', 'common', 'wizard'])

  return (
    <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
      {/* Retriever Name and Display Name */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name" className="text-sm font-medium">
            {t('admin:public_retrievers.form.name')} *
          </Label>
          <Input
            id="name"
            value={formData.name}
            onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder={t('admin:public_retrievers.form.name_placeholder')}
            disabled={isEditDialogOpen}
            className="bg-base"
          />
          <p className="text-xs text-text-muted">
            {isEditDialogOpen
              ? t('common:retrievers.retriever_id_readonly')
              : t('common:retrievers.retriever_id_hint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="displayName" className="text-sm font-medium">
            {t('admin:public_retrievers.form.display_name')}
          </Label>
          <Input
            id="displayName"
            value={formData.displayName}
            onChange={e => setFormData(prev => ({ ...prev, displayName: e.target.value }))}
            placeholder={t('admin:public_retrievers.form.display_name_placeholder')}
            className="bg-base"
          />
        </div>
      </div>

      {/* Storage Type */}
      <div className="space-y-2">
        <Label htmlFor="storageType" className="text-sm font-medium">
          {t('admin:public_retrievers.form.storage_type')} *
        </Label>
        <Select value={formData.storageType} onValueChange={handleStorageTypeChange}>
          <SelectTrigger className="bg-base">
            <SelectValue placeholder={t('admin:public_retrievers.form.storage_type_placeholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="elasticsearch">Elasticsearch</SelectItem>
            <SelectItem value="qdrant">Qdrant</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* URL */}
      <div className="space-y-2">
        <Label htmlFor="url" className="text-sm font-medium">
          {t('admin:public_retrievers.form.url')} *
        </Label>
        <Input
          id="url"
          value={formData.url}
          onChange={e => setFormData(prev => ({ ...prev, url: e.target.value }))}
          placeholder={t('admin:public_retrievers.form.url_placeholder')}
          className="bg-base"
        />
        <p className="text-xs text-text-muted">
          {formData.storageType === 'elasticsearch'
            ? t('common:retrievers.connection_url_hint_es')
            : t('common:retrievers.connection_url_hint_qdrant')}
        </p>
      </div>

      {/* Authentication - Username/Password (Elasticsearch) */}
      {STORAGE_TYPE_CONFIG[formData.storageType].authFields.supportsUsernamePassword && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="username" className="text-sm font-medium">
              {t('admin:public_retrievers.form.username')}
            </Label>
            <Input
              id="username"
              value={formData.username}
              onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
              placeholder={t('admin:public_retrievers.form.username_placeholder')}
              className="bg-base"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm font-medium">
              {t('common:retrievers.password')}
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={formData.password}
                onChange={e => setFormData(prev => ({ ...prev, password: e.target.value }))}
                placeholder={t('common:retrievers.password_placeholder')}
                className="bg-base pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeSlashIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Authentication - API Key (Qdrant) */}
      {STORAGE_TYPE_CONFIG[formData.storageType].authFields.supportsApiKey && (
        <div className="space-y-2">
          <Label htmlFor="apiKey" className="text-sm font-medium">
            {t('admin:public_retrievers.form.api_key')}
          </Label>
          <div className="relative">
            <Input
              id="apiKey"
              type={showApiKey ? 'text' : 'password'}
              value={formData.apiKey}
              onChange={e => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={t('admin:public_retrievers.form.api_key_placeholder')}
              className="bg-base pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}

      {/* Index Strategy */}
      <div className="space-y-2">
        <Label htmlFor="indexMode" className="text-sm font-medium">
          {t('admin:public_retrievers.form.index_strategy')} *
        </Label>
        <Select
          value={formData.indexMode}
          onValueChange={(value: string) =>
            setFormData(prev => ({ ...prev, indexMode: value as IndexModeType }))
          }
        >
          <SelectTrigger className="bg-base">
            <SelectValue
              placeholder={t('admin:public_retrievers.form.index_strategy_placeholder')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per_user">
              {t('common:retrievers.index_strategy_per_user')}
              {STORAGE_TYPE_CONFIG[formData.storageType].recommendedIndexMode === 'per_user' &&
                ` (${t('wizard:recommended')})`}
            </SelectItem>
            <SelectItem value="per_dataset">
              {t('common:retrievers.index_strategy_per_dataset')}
              {STORAGE_TYPE_CONFIG[formData.storageType].recommendedIndexMode === 'per_dataset' &&
                ` (${t('wizard:recommended')})`}
            </SelectItem>
            <SelectItem value="fixed">{t('common:retrievers.index_strategy_fixed')}</SelectItem>
            <SelectItem value="rolling">{t('common:retrievers.index_strategy_rolling')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-text-muted">
          {formData.indexMode === 'per_user' && t('common:retrievers.index_strategy_per_user_desc')}
          {formData.indexMode === 'per_dataset' &&
            t('common:retrievers.index_strategy_per_dataset_desc')}
          {formData.indexMode === 'fixed' && t('common:retrievers.index_strategy_fixed_desc')}
          {formData.indexMode === 'rolling' && t('common:retrievers.index_strategy_rolling_desc')}
        </p>
      </div>

      {/* Index Strategy Fields */}
      {formData.indexMode === 'fixed' && (
        <div className="space-y-2">
          <Label htmlFor="fixedName" className="text-sm font-medium">
            {t('admin:public_retrievers.form.fixed_name')} *
          </Label>
          <Input
            id="fixedName"
            value={formData.fixedName}
            onChange={e => setFormData(prev => ({ ...prev, fixedName: e.target.value }))}
            placeholder={t('admin:public_retrievers.form.fixed_name_placeholder')}
            className="bg-base"
          />
        </div>
      )}

      {formData.indexMode === 'rolling' && (
        <div className="space-y-2">
          <Label htmlFor="rollingStep" className="text-sm font-medium">
            {t('common:retrievers.rolling_step_required')}
          </Label>
          <Input
            id="rollingStep"
            type="number"
            value={formData.rollingStep}
            onChange={e => setFormData(prev => ({ ...prev, rollingStep: e.target.value }))}
            placeholder={t('common:retrievers.rolling_step_placeholder')}
            className="bg-base"
          />
          <p className="text-xs text-text-muted">{t('common:retrievers.rolling_step_hint')}</p>
        </div>
      )}

      {(formData.indexMode === 'rolling' ||
        formData.indexMode === 'per_dataset' ||
        formData.indexMode === 'per_user') && (
        <div className="space-y-2">
          <Label htmlFor="prefix" className="text-sm font-medium">
            {t('admin:public_retrievers.form.prefix')} *
          </Label>
          <Input
            id="prefix"
            value={formData.prefix}
            onChange={e => setFormData(prev => ({ ...prev, prefix: e.target.value }))}
            placeholder={t('admin:public_retrievers.form.prefix_placeholder')}
            className="bg-base"
          />
          <p className="text-xs text-text-muted">{t('common:retrievers.index_prefix_hint')}</p>
        </div>
      )}

      {/* Retrieval Methods */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('common:retrievers.retrieval_methods')}</Label>
        <div className="flex flex-wrap gap-4">
          {loadingRetrievalMethods ? (
            <div className="flex items-center gap-2 text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t('common:retrievers.loading_retrieval_methods')}</span>
            </div>
          ) : (
            availableRetrievalMethods.map(method => (
              <div key={method} className="flex items-center space-x-2">
                <Checkbox
                  id={`retrieval-method-${method}`}
                  checked={formData.enabledRetrievalMethods.includes(method)}
                  onCheckedChange={checked =>
                    handleRetrievalMethodToggle(method, checked as boolean)
                  }
                  disabled={
                    formData.enabledRetrievalMethods.length === 1 &&
                    formData.enabledRetrievalMethods.includes(method)
                  }
                />
                <Label
                  htmlFor={`retrieval-method-${method}`}
                  className="text-sm font-normal cursor-pointer"
                >
                  {t(RETRIEVAL_METHOD_LABELS[method] || method)}
                </Label>
              </div>
            ))
          )}
        </div>
        <p className="text-xs text-text-muted">{t('common:retrievers.retrieval_methods_hint')}</p>
      </div>
    </div>
  )
}

export default RetrieverFormFields
