// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ResourceLibraryTypeFilter } from './types'

export function getResourceSearchPlaceholderKey(resourceType: ResourceLibraryTypeFilter): string {
  if (resourceType === 'agent') {
    return 'search.agent_placeholder'
  }
  if (resourceType === 'skill') {
    return 'search.skill_placeholder'
  }
  return 'search.placeholder'
}
