// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import ModelList from './ModelList'
import { GroupSelector } from './groups/GroupSelector'

interface ModelListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
}

export function ModelListWithScope({ scope }: ModelListWithScopeProps) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)

  if (scope === 'personal') {
    return <ModelList scope="personal" />
  }

  return (
    <div className="space-y-4">
      {scope === 'group' && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <GroupSelector
            value={selectedGroup}
            onChange={setSelectedGroup}
            scope={scope}
          />
        </div>
      )}
      <ModelList scope="group" groupName={selectedGroup || undefined} />
    </div>
  )
}