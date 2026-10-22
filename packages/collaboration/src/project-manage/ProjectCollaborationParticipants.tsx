// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

type ParticipantTab = "members" | "agents" | "groups";

export function CollaborationParticipantsTabs({
  agentsContent,
  agentsLabel,
  ariaLabel,
  groupsContent,
  groupsLabel,
  initialTab = "agents",
  membersContent,
  membersLabel,
  testIdPrefix = "collaboration-participants",
}: {
  agentsContent: ReactNode;
  agentsLabel: string;
  ariaLabel: string;
  groupsContent: ReactNode;
  groupsLabel: string;
  initialTab?: ParticipantTab;
  membersContent?: ReactNode;
  membersLabel?: string;
  testIdPrefix?: string;
}) {
  const [selectedTab, setSelectedTab] = useState<ParticipantTab>(initialTab);
  const tabRefs = useRef<Record<ParticipantTab, HTMLButtonElement | null>>({
    agents: null,
    members: null,
    groups: null,
  });
  const tabs: Array<{ id: ParticipantTab; label: string }> = [
    {
      id: "agents",
      label: agentsLabel,
    },
    ...(membersContent && membersLabel
      ? [
          {
            id: "members" as const,
            label: membersLabel,
          },
        ]
      : []),
    {
      id: "groups",
      label: groupsLabel,
    },
  ];
  const content = {
    members: membersContent,
    agents: agentsContent,
    groups: groupsContent,
  }[selectedTab];
  const selectAndFocusTab = (tab: ParticipantTab) => {
    setSelectedTab(tab);
    tabRefs.current[tab]?.focus();
  };
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: ParticipantTab,
  ) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectAndFocusTab(tabs[nextIndex].id);
  };

  return (
    <>
      <div
        aria-label={ariaLabel}
        className="mb-6 flex gap-1 border-b border-border"
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            aria-controls={`${testIdPrefix}-panel-${tab.id}`}
            aria-selected={selectedTab === tab.id}
            className={
              selectedTab === tab.id
                ? "-mb-px border-b-2 border-text-primary px-3 py-2 text-sm font-medium text-text-primary"
                : "px-3 py-2 text-sm font-normal text-text-muted hover:text-text-primary"
            }
            data-testid={`${testIdPrefix}-tab-${tab.id}`}
            id={`${testIdPrefix}-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setSelectedTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            role="tab"
            tabIndex={selectedTab === tab.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${testIdPrefix}-tab-${selectedTab}`}
        data-testid={`${testIdPrefix}-panel-${selectedTab}`}
        id={`${testIdPrefix}-panel-${selectedTab}`}
        role="tabpanel"
      >
        {content}
      </div>
    </>
  );
}
