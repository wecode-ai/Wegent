// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelCategoryType, ModelTypeEnum, UnifiedModel } from '@/apis/models'

export function toModelSelectValue(name: string, type?: ModelTypeEnum, namespace?: string): string {
  if (!name) return '__none__'
  return `${name}:${type || ''}:${namespace || 'default'}`
}

export function parseModelSelectValue(value: string): {
  name: string
  type?: ModelTypeEnum
  namespace?: string
} {
  if (value === '__none__') {
    return { name: '', type: undefined, namespace: undefined }
  }

  const [name, type, namespace] = value.split(':')
  return {
    name,
    type: (type as ModelTypeEnum) || undefined,
    namespace: namespace || 'default',
  }
}

export function resolveSelectedModel(
  models: UnifiedModel[],
  name: string,
  type?: ModelTypeEnum,
  namespace?: string,
  modelCategoryType?: ModelCategoryType
): UnifiedModel | null {
  if (!name) return null

  return (
    models.find(
      model =>
        toModelSelectValue(model.name, model.type, model.namespace) ===
        toModelSelectValue(name, type, namespace)
    ) ?? {
      name,
      displayName: name,
      type: type ?? 'public',
      namespace: namespace ?? 'default',
      modelCategoryType,
    }
  )
}
