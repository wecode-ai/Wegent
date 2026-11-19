// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useSyncExternalStore } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import {
  createCollaborationPlatformSource,
  type PlatformLocationObservation,
} from './collaborationPlatformSource'
export type { CollaborationPlatformState } from './platformNavigationCollections'
export function useCollaborationPlatformController(
  options: PlatformLocationObservation & {
    api: SharedWorkspaceApi
    navigationApis?: SharedWorkspaceApi[]
  }
) {
  const { api, navigationApis } = options
  const sources = navigationApis?.length ? navigationApis : [api]
  const [source, setSource] = useState(() =>
    createCollaborationPlatformSource(api, sources, options)
  )
  if (
    source.api !== api ||
    source.sources.length !== sources.length ||
    sources.some((api, index) => source.sources[index] !== api)
  )
    setSource(createCollaborationPlatformSource(api, sources, options))
  const state = useSyncExternalStore(
    listener => source.subscribe(options, listener),
    source.getSnapshot,
    source.getSnapshot
  )
  return { state, commands: source.commands }
}
