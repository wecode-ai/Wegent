// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

type ParticipantTab = "members" | "agents" | "groups";

export function ProjectCollaborationParticipants({
  agentsContent,
  groupsContent,
  membersContent,
  translate,
}: {
  agentsContent: ReactNode;
  groupsContent: ReactNode;
  membersContent: ReactNode;
  translate: CollaborationTranslate;
}) {
  const [selectedTab, setSelectedTab] = useState<ParticipantTab>("agents");
  const tabs: Array<{ id: ParticipantTab; label: string }> = [
    {
      id: "agents",
      label: translate("todo.project_agents", "智能体"),
    },
    {
      id: "members",
      label: translate("todo.project_members", "项目成员"),
    },
    {
      id: "groups",
      label: translate("todo.collaboration_groups", "协作小组"),
    },
  ];
  const content = {
    members: membersContent,
    agents: agentsContent,
    groups: groupsContent,
  }[selectedTab];

  return (
    <ProjectSettingsPage
      title={translate("todo.collaboration_participants", "协作成员")}
      description={translate(
        "todo.collaboration_participants_description",
        "统一管理项目中的成员、智能体和协作小组。三者保持独立身份，协作小组从已有成员和智能体中组织工作。",
      )}
      testId="collaboration-project-participants-page"
    >
      <div
        aria-label={translate("todo.collaboration_participants", "协作成员")}
        className="mb-6 flex gap-1 border-b border-border"
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            aria-controls={`collaboration-participants-panel-${tab.id}`}
            aria-selected={selectedTab === tab.id}
            className={
              selectedTab === tab.id
                ? "-mb-px border-b-2 border-text-primary px-3 py-2 text-sm font-medium text-text-primary"
                : "px-3 py-2 text-sm text-text-muted hover:text-text-primary"
            }
            data-testid={`collaboration-participants-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setSelectedTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        data-testid={`collaboration-participants-panel-${selectedTab}`}
        id={`collaboration-participants-panel-${selectedTab}`}
        role="tabpanel"
      >
        {content}
      </div>
    </ProjectSettingsPage>
  );
}
