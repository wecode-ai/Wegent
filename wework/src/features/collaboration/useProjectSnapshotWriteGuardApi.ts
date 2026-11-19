// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import {
  guardProjectSnapshotWrites,
  type ProjectSnapshotWriteGuard,
} from './projectSnapshotWriteGuard'

export function useProjectSnapshotWriteGuardApi(
  api: SharedWorkspaceApi,
  getGuard: () => ProjectSnapshotWriteGuard
): SharedWorkspaceApi {
  const getCurrentGuard = useStableEvent(getGuard)
  return useMemo(() => guardProjectSnapshotWrites(api, getCurrentGuard), [api, getCurrentGuard])
}
