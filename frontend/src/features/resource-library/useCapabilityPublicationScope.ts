// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { Group } from '@/types/group'
import type { CapabilityPublishTarget } from './components/CapabilityScopeSelector'
import type { VisibleResourceLibraryResourceType } from './types'

interface CapabilityPublicationScopeOptions {
  enabled?: boolean
  open: boolean
  resourceType: VisibleResourceLibraryResourceType
  sourceName?: string
  sourceNamespace?: string
  groups: Group[]
  defaultTarget?: CapabilityPublishTarget
  defaultGroupNames?: string[]
}

interface SaveCapabilityPublicationOptions {
  sourceName: string
  sourceNamespace: string
  displayName: string
  description?: string | null
}

export function useCapabilityPublicationScope({
  enabled = true,
  open,
  resourceType,
  sourceName,
  sourceNamespace = 'default',
  groups,
  defaultTarget = 'personal',
  defaultGroupNames,
}: CapabilityPublicationScopeOptions) {
  const defaultGroupNamesKey = (defaultGroupNames || []).join('\u0000')
  const initialGroupNames = useMemo(
    () => (defaultGroupNamesKey ? defaultGroupNamesKey.split('\u0000') : []),
    [defaultGroupNamesKey]
  )
  const [target, setTarget] = useState<CapabilityPublishTarget>(defaultTarget)
  const [groupNames, setGroupNames] = useState<string[]>(initialGroupNames)
  const [loading, setLoading] = useState(false)

  const writableGroups = useMemo(
    () =>
      groups.filter(
        group =>
          group.my_role === 'Owner' ||
          group.my_role === 'Maintainer' ||
          group.my_role === 'Developer'
      ),
    [groups]
  )

  useEffect(() => {
    if (!enabled || !open) return

    setTarget(defaultTarget)
    setGroupNames(initialGroupNames)
    setLoading(false)
    if (!sourceName) return

    let active = true
    setLoading(true)
    resourceLibraryApi
      .getPublicationBySource(resourceType, sourceName, sourceNamespace)
      .then(listing => {
        if (!active) return
        const nextGroups = listing.target_groups || []
        setGroupNames(nextGroups)
        setTarget(
          listing.status === 'published'
            ? 'marketplace'
            : nextGroups.length > 0
              ? 'team'
              : defaultTarget
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [
    defaultGroupNamesKey,
    defaultTarget,
    enabled,
    initialGroupNames,
    open,
    resourceType,
    sourceName,
    sourceNamespace,
  ])

  const handleChange = (
    nextTarget: CapabilityPublishTarget,
    nextGroupName?: string,
    nextGroupNames?: string[]
  ) => {
    setTarget(nextTarget)
    setGroupNames(
      nextTarget === 'team' ? nextGroupNames || (nextGroupName ? [nextGroupName] : []) : []
    )
  }

  const savePublicationScope = async ({
    sourceName: savedSourceName,
    sourceNamespace: savedSourceNamespace,
    displayName,
    description = null,
  }: SaveCapabilityPublicationOptions) => {
    if (!enabled) return
    if (target === 'team' && groupNames.length === 0) {
      throw new Error('Please select at least one team')
    }

    await resourceLibraryApi.createListing({
      resource_type: resourceType,
      source_name: savedSourceName,
      source_namespace: savedSourceNamespace,
      display_name: displayName || savedSourceName,
      description,
      icon: null,
      tags: [],
      version: '1.0.0',
      status: target === 'marketplace' ? 'published' : 'archived',
      target_groups: target === 'team' ? groupNames : [],
      allow_personal_install: target === 'marketplace',
      allow_group_install: target !== 'personal',
      manifest_options: {},
    })
  }

  return {
    target,
    groupNames,
    writableGroups,
    loading,
    handleChange,
    savePublicationScope,
  }
}
