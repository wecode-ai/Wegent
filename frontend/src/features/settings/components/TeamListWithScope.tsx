// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import TeamList from './TeamList';
import { GroupSelector } from './groups/GroupSelector';

interface TeamListWithScopeProps {
  scope: 'personal' | 'group' | 'all';
  selectedGroup?: string | null;
  onGroupChange?: (groupName: string | null) => void;
}

export function TeamListWithScope({
  scope,
  selectedGroup: externalSelectedGroup,
  onGroupChange,
}: TeamListWithScopeProps) {
  // Use external state if provided, otherwise use internal state
  const [internalSelectedGroup, setInternalSelectedGroup] = useState<string | null>(null);

  const selectedGroup =
    externalSelectedGroup !== undefined ? externalSelectedGroup : internalSelectedGroup;
  const setSelectedGroup = onGroupChange || setInternalSelectedGroup;

  // Sync internal state with external state
  useEffect(() => {
    if (externalSelectedGroup !== undefined && externalSelectedGroup !== internalSelectedGroup) {
      setInternalSelectedGroup(externalSelectedGroup);
    }
  }, [externalSelectedGroup, internalSelectedGroup]);

  if (scope === 'personal') {
    return <TeamList scope="personal" />;
  }

  // When selectedGroup is provided externally (from nav), don't show GroupSelector
  const showGroupSelector = externalSelectedGroup === undefined;

  return (
    <div className="space-y-4">
      {scope === 'group' && showGroupSelector && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <GroupSelector value={selectedGroup} onChange={setSelectedGroup} scope={scope} />
        </div>
      )}
      <TeamList scope="group" groupName={selectedGroup || undefined} />
    </div>
  );
}
