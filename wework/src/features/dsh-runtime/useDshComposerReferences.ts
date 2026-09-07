import { useSyncExternalStore } from 'react'

import {
  getDshExtensionHost,
  subscribeDshExtensions,
  type WeworkResolvedComposerReferenceContribution,
} from './dshExtensions'

function listDshComposerReferences(): readonly WeworkResolvedComposerReferenceContribution[] {
  return getDshExtensionHost()?.composer.references.list() ?? []
}

export function useDshComposerReferences(
  query: string
): readonly WeworkResolvedComposerReferenceContribution[] {
  useSyncExternalStore(
    subscribeDshExtensions,
    () => getDshExtensionHost()?.getRevision() ?? 0,
    () => 0
  )
  const references = listDshComposerReferences()
  const normalizedQuery = query.trim().toLocaleLowerCase()

  if (!normalizedQuery) return references
  return references.filter(reference =>
    [reference.title, reference.description, ...(reference.searchAliases ?? [])].some(value =>
      value?.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
}
