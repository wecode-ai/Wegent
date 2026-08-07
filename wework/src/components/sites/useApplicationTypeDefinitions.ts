import { useEffect, useMemo, useState } from 'react'
import type { ApplicationTypeDescriptor, SitesApi } from '@/api/sites'
import {
  defaultResolvedApplicationTypes,
  getApplicationTypeDefinition,
} from './applicationTypeDefinitions'
import type { ResolvedApplicationTypeDefinition } from './applicationTypeDefinitions'

const APPLICATION_TYPES_CACHE_KEY = 'wework:sites-application-types'

function normalizeCreateDescriptor(descriptor: ApplicationTypeDescriptor) {
  const create = descriptor.create
  const pluginName = create?.plugin_name?.trim()
  const marketplaceName = create?.marketplace_name?.trim()
  if (!pluginName || !marketplaceName) return undefined
  return {
    pluginName,
    marketplaceName,
  }
}

function resolveApplicationTypes(
  descriptors: readonly ApplicationTypeDescriptor[]
): ResolvedApplicationTypeDefinition[] {
  return [...descriptors]
    .filter(descriptor => descriptor.enabled)
    .sort((left, right) => left.order - right.order)
    .flatMap(descriptor => {
      const definition = getApplicationTypeDefinition(descriptor.app_type)
      if (!definition) return []

      const create = normalizeCreateDescriptor(descriptor)
      const capabilities = definition.capabilities.filter(capability =>
        capability === 'create'
          ? descriptor.capabilities.includes(capability) && Boolean(create)
          : descriptor.capabilities.includes(capability)
      )
      return [
        {
          definition: create
            ? {
                ...definition,
                create: {
                  ...definition.create,
                  ...create,
                },
              }
            : definition,
          capabilities: new Set(capabilities),
        },
      ]
    })
}

function readCachedApplicationTypes(): ApplicationTypeDescriptor[] | null {
  try {
    const raw = window.localStorage.getItem(APPLICATION_TYPES_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { items?: unknown }
    if (!Array.isArray(parsed.items)) return null
    const items = parsed.items
    const valid = items.every(item => {
      if (!item || typeof item !== 'object') return false
      const create = (item as { create?: unknown }).create
      if (create === undefined || create === null) return true
      if (typeof create !== 'object') return false
      const pluginName = (create as { plugin_name?: unknown }).plugin_name
      const marketplaceName = (create as { marketplace_name?: unknown }).marketplace_name
      return (
        (pluginName === undefined || typeof pluginName === 'string') &&
        (marketplaceName === undefined || typeof marketplaceName === 'string')
      )
    })
    return valid ? (items as ApplicationTypeDescriptor[]) : null
  } catch {
    return null
  }
}

function cacheApplicationTypes(items: ApplicationTypeDescriptor[]): void {
  try {
    window.localStorage.setItem(APPLICATION_TYPES_CACHE_KEY, JSON.stringify({ items }))
  } catch {
    // Cache is a convenience; discovery still works without storage.
  }
}

export function useApplicationTypeDefinitions(api: SitesApi): ResolvedApplicationTypeDefinition[] {
  const [descriptors, setDescriptors] = useState<ApplicationTypeDescriptor[] | null>(() =>
    readCachedApplicationTypes()
  )

  useEffect(() => {
    let cancelled = false

    void api
      .listApplicationTypes()
      .then(response => {
        if (cancelled) return
        cacheApplicationTypes(response.items)
        setDescriptors(response.items)
      })
      .catch(() => {
        if (!cancelled) setDescriptors(readCachedApplicationTypes())
      })

    return () => {
      cancelled = true
    }
  }, [api])

  return useMemo(() => {
    if (!descriptors) return defaultResolvedApplicationTypes()
    const resolved = resolveApplicationTypes(descriptors)
    return resolved.length > 0 ? resolved : defaultResolvedApplicationTypes()
  }, [descriptors])
}
