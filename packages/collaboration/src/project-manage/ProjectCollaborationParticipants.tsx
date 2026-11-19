// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { useState, type ReactNode } from 'react'

export type ParticipantTab = 'members' | 'agents' | 'groups'

export function CollaborationParticipantsTabs({
  agentsContent,
  agentsLabel,
  ariaLabel,
  groupsContent,
  groupsLabel,
  initialTab = 'agents',
  membersContent,
  membersLabel,
  testIdPrefix = 'collaboration-participants',
  tabOrder = ['agents', 'members', 'groups'],
  onTabChange,
}: {
  agentsContent: ReactNode
  agentsLabel: string
  ariaLabel: string
  groupsContent: ReactNode
  groupsLabel: string
  initialTab?: ParticipantTab
  membersContent?: ReactNode
  membersLabel?: string
  testIdPrefix?: string
  tabOrder?: readonly ParticipantTab[]
  onTabChange?(tab: ParticipantTab): void
}) {
  const [selectedTab, setSelectedTab] = useState<ParticipantTab>(initialTab)
  const availableTabs: Array<{ id: ParticipantTab; label: string }> = [
    {
      id: 'agents',
      label: agentsLabel,
    },
    ...(membersContent && membersLabel
      ? [
          {
            id: 'members' as const,
            label: membersLabel,
          },
        ]
      : []),
    {
      id: 'groups',
      label: groupsLabel,
    },
  ]
  const tabs = tabOrder.flatMap(id => availableTabs.filter(tab => tab.id === id))
  const content = { members: membersContent, agents: agentsContent, groups: groupsContent }
  const value = tabs.some(tab => tab.id === selectedTab) ? selectedTab : tabs[0]?.id
  return (
    <Tabs
      value={value}
      onValueChange={next => {
        if (next !== null) {
          setSelectedTab(next)
          onTabChange?.(next)
        }
      }}
    >
      <TabsList aria-label={ariaLabel} className="mb-6 flex gap-1 border-b border-border">
        {tabs.map(tab => (
          <TabsTab
            key={tab.id}
            value={tab.id}
            id={`${testIdPrefix}-tab-${tab.id}`}
            data-testid={`${testIdPrefix}-tab-${tab.id}`}
            className="-mb-px min-h-11 border-b-2 border-transparent px-3 text-sm text-text-secondary outline-none hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 data-[active]:border-text-primary data-[active]:font-medium data-[active]:text-text-primary md:min-h-9"
          >
            {tab.label}
          </TabsTab>
        ))}
      </TabsList>
      {tabs.map(tab => (
        <TabsPanel
          key={tab.id}
          value={tab.id}
          id={`${testIdPrefix}-panel-${tab.id}`}
          data-testid={`${testIdPrefix}-panel-${tab.id}`}
        >
          {content[tab.id]}
        </TabsPanel>
      ))}
    </Tabs>
  )
}
