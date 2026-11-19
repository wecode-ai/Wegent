// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { createPlatformCreationState, type PlatformCreationInput } from './platformCreationState'

export function usePlatformCreationState(api: SharedWorkspaceApi, input: PlatformCreationInput) {
  const account = input.host.accountScope
  const [owner, setOwner] = useState(() => ({
    api,
    account,
    source: createPlatformCreationState(api, input),
  }))
  let creation = owner.source
  if (owner.api !== api || owner.account !== account) {
    creation = createPlatformCreationState(api, input)
    setOwner({ api, account, source: creation })
  }
  const subscribe = useCallback(
    (listener: () => void) => creation.subscribe(input, listener),
    [creation, input]
  )
  const snapshot = useSyncExternalStore(subscribe, creation.getSnapshot, creation.getSnapshot)
  return { creation, ...snapshot }
}
