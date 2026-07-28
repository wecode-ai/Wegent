// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelCapabilities } from '@/apis/models'

export interface GroupableModel {
  name: string
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  type?: string | null
  namespace?: string | null
  modelGroup?: string | null
  modelSubGroup?: string | null
  modelCapabilities?: ModelCapabilities | null
  config?: Record<string, unknown> | null
}

export interface ModelSubGroup<T extends GroupableModel = GroupableModel> {
  name: string
  count: number
  models: T[]
}

export interface ModelCascadeGroup<T extends GroupableModel = GroupableModel> {
  name: string
  count: number
  subGroups: ModelSubGroup<T>[]
}

interface GroupingLabels {
  ungroupedLabel: string
  uncategorizedLabel: string
}

function normalizeGroupValue(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function compareGroupName(a: string, b: string, fallback: string): number {
  if (a === fallback && b !== fallback) return 1
  if (b === fallback && a !== fallback) return -1
  return a.localeCompare(b)
}

export function getModelDisplayName(model: GroupableModel): string {
  return model.displayName?.trim() || model.name
}

export function getModelSearchText(model: GroupableModel): string {
  return [
    model.name,
    model.displayName,
    model.provider,
    model.modelId,
    model.type,
    model.namespace,
    model.modelGroup,
    model.modelSubGroup,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function matchesModelSearch(model: GroupableModel, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return getModelSearchText(model).includes(normalizedQuery)
}

export function buildModelCascadeGroups<T extends GroupableModel>(
  models: T[],
  labels: GroupingLabels
): ModelCascadeGroup<T>[] {
  const primaryGroups = new Map<string, Map<string, T[]>>()

  for (const model of models) {
    const primaryName = normalizeGroupValue(model.modelGroup, labels.ungroupedLabel)
    const secondaryName = normalizeGroupValue(model.modelSubGroup, labels.uncategorizedLabel)
    const secondaryGroups = primaryGroups.get(primaryName) ?? new Map<string, T[]>()
    const groupModels = secondaryGroups.get(secondaryName) ?? []

    groupModels.push(model)
    secondaryGroups.set(secondaryName, groupModels)
    primaryGroups.set(primaryName, secondaryGroups)
  }

  return Array.from(primaryGroups.entries())
    .sort(([a], [b]) => compareGroupName(a, b, labels.ungroupedLabel))
    .map(([name, secondaryGroups]) => {
      const subGroups = Array.from(secondaryGroups.entries())
        .sort(([a], [b]) => compareGroupName(a, b, labels.uncategorizedLabel))
        .map(([subGroupName, groupModels]) => {
          const sortedModels = groupModels.slice().sort((a, b) => {
            return getModelDisplayName(a).localeCompare(getModelDisplayName(b))
          })

          return {
            name: subGroupName,
            count: sortedModels.length,
            models: sortedModels,
          }
        })

      return {
        name,
        count: subGroups.reduce((total, subGroup) => total + subGroup.count, 0),
        subGroups,
      }
    })
}
