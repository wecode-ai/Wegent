// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'

import {
  SkillListWithScope,
  type ResourceListState,
} from '@/features/settings/components/SkillListWithScope'
import { useTranslation } from '@/hooks/useTranslation'
import type { Group } from '@/types/group'

const initialResourceListState: ResourceListState = {
  loading: true,
  hasItems: false,
  hasError: false,
}

/** Displays one team's skills with scoped loading and empty states. */
export function TeamSkillResources({
  groupName,
  groups,
  keyword,
}: {
  groupName: string
  groups: Group[]
  keyword: string
}) {
  const { t } = useTranslation('resource-library')
  const { t: tCommon } = useTranslation('common')
  const [listState, setListState] = useState<ResourceListState>(initialResourceListState)
  const isLoading = !listState.hasItems && listState.loading
  const isEmpty = !listState.hasItems && !listState.loading && !listState.hasError

  return (
    <div className="space-y-6" data-testid="team-skill-resources">
      <SkillListWithScope
        scope="group"
        selectedGroup={groupName}
        groups={groups}
        sourceFilter="group"
        sortMode="latest"
        showAutoEnabledSkills={false}
        hideCreateActions
        hideEmptyState
        hideLoadingState
        compact
        searchQuery={keyword}
        onListStateChange={setListState}
      />
      {isLoading && (
        <div
          className="flex min-h-[260px] items-center justify-center text-text-secondary"
          data-testid="team-skill-resources-loading"
        >
          {tCommon('skills.loading')}
        </div>
      )}
      {isEmpty && (
        <div
          className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface p-6 text-sm text-text-secondary"
          data-testid="team-skill-resources-empty"
        >
          {t('states.empty')}
        </div>
      )}
    </div>
  )
}
