import { useEffect, useMemo, useState } from 'react'
import type { ApplicationTypeDescriptor, SitesApi } from '@/api/sites'
import {
  defaultResolvedApplicationTypes,
  getApplicationTypeDefinition,
} from './applicationTypeDefinitions'
import type { ResolvedApplicationTypeDefinition } from './applicationTypeDefinitions'

function resolveApplicationTypes(
  descriptors: readonly ApplicationTypeDescriptor[]
): ResolvedApplicationTypeDefinition[] {
  return [...descriptors]
    .filter(descriptor => descriptor.enabled)
    .sort((left, right) => left.order - right.order)
    .flatMap(descriptor => {
      const definition = getApplicationTypeDefinition(descriptor.app_type)
      if (!definition) return []

      const capabilities = definition.capabilities.filter(capability =>
        descriptor.capabilities.includes(capability)
      )
      return [{ definition, capabilities: new Set(capabilities) }]
    })
}

export function useApplicationTypeDefinitions(api: SitesApi): ResolvedApplicationTypeDefinition[] {
  const [descriptors, setDescriptors] = useState<ApplicationTypeDescriptor[] | null>(null)

  useEffect(() => {
    let cancelled = false

    void api
      .listApplicationTypes()
      .then(response => {
        if (!cancelled) setDescriptors(response.items)
      })
      .catch(() => {
        if (!cancelled) setDescriptors(null)
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
