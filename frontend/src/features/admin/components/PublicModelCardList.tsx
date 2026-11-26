// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { AdminPublicModel } from '@/apis/admin'
import {
  getPublicModelAllowedUsersEnabledFromConfig,
  getPublicModelAllowedUsersFromConfig,
  getPublicModelSpecValue,
} from './publicModelConfig'

const getModelProvider = (json: Record<string, unknown>): string => {
  const env = (json?.env as Record<string, unknown>) || {}
  const model = env?.model as string
  if (model === 'openai') return 'OpenAI'
  if (model === 'claude') return 'Anthropic'
  return 'Unknown'
}

const getModelId = (json: Record<string, unknown>): string => {
  const env = (json?.env as Record<string, unknown>) || {}
  return (env?.model_id as string) || 'N/A'
}

const getDisplayName = (model: AdminPublicModel): string => {
  // Use display_name from API response if available, otherwise fall back to name
  return model.display_name || model.name
}

const getGroupPath = (model: AdminPublicModel): string | null => {
  const group = getPublicModelSpecValue(model.json, 'modelGroup')
  const subGroup = getPublicModelSpecValue(model.json, 'modelSubGroup')
  if (group && subGroup) return `${group} / ${subGroup}`
  return group || subGroup || null
}

interface PublicModelCardListProps {
  models: AdminPublicModel[]
  onEdit: (model: AdminPublicModel) => void
  onDelete: (model: AdminPublicModel) => void
}

export const PublicModelCardList: React.FC<PublicModelCardListProps> = ({
  models,
  onEdit,
  onDelete,
}) => {
  const { t } = useTranslation()

  return (
    <div className="flex-1 overflow-y-auto space-y-3 p-1">
      {models.map(model => (
        <Card
          key={model.id}
          className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
        >
          <div className="flex items-center justify-between min-w-0">
            <div className="flex items-center space-x-3 min-w-0 flex-1">
              <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="flex flex-col justify-center min-w-0 flex-1">
                <div className="flex items-center space-x-2 min-w-0">
                  <h3 className="text-base font-medium text-text-primary truncate">
                    {getDisplayName(model)}
                  </h3>
                  <Tag variant="info">{getModelProvider(model.json)}</Tag>
                  {model.is_active ? (
                    <Tag variant="success">{t('admin:public_models.status.active')}</Tag>
                  ) : (
                    <Tag variant="error">{t('admin:public_models.status.inactive')}</Tag>
                  )}
                  {!model.is_visible && (
                    <Tag variant="error">{t('admin:public_models.status.hidden')}</Tag>
                  )}
                  {model.is_advanced && (
                    <Tag variant="warning">{t('admin:public_models.status.advanced')}</Tag>
                  )}
                  {(getPublicModelAllowedUsersFromConfig(JSON.stringify(model.json)).length > 0 ||
                    getPublicModelAllowedUsersEnabledFromConfig(JSON.stringify(model.json))) && (
                    <Tag variant="warning">{t('admin:public_models.status.whitelisted')}</Tag>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                  <span>
                    {t('admin:public_models.form.name')}: {model.name}
                  </span>
                  <span>•</span>
                  <span>
                    {t('admin:public_models.model_id')}: {getModelId(model.json)}
                  </span>
                  <span>•</span>
                  <span>
                    {t('admin:public_models.namespace_label')}: {model.namespace}
                  </span>
                  {getGroupPath(model) && (
                    <>
                      <span>•</span>
                      <span>
                        {t('admin:public_models.form.model_group')}: {getGroupPath(model)}
                      </span>
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
                onClick={() => onEdit(model)}
                title={t('admin:public_models.edit_model')}
              >
                <PencilIcon className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:text-error"
                onClick={() => onDelete(model)}
                title={t('admin:public_models.delete_model')}
              >
                <TrashIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
