// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import {
  Bot,
  ChevronRight,
  CircleUserRound,
  FilePlus2,
  LayoutTemplate,
  MessageSquare,
  Monitor,
  Settings,
  SquarePen,
  UsersRound,
} from "lucide-react";
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
  CollaborationPlatformRootView,
} from "./types";
import type { PlatformMessages } from "./platformMessages";

type NavigationProps = {
  domain: CollaborationDomain;
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
};

function NavigationLink({
  domain,
  host,
  view,
  label,
  icon: Icon,
  testId,
}: Omit<NavigationProps, "messages"> & {
  view: CollaborationPlatformRootView;
  label: string;
  icon: typeof Bot;
  testId: string;
}) {
  const selected =
    !host.location.workspaceId &&
    !host.location.projectId &&
    (host.location.rootView ?? "home") === view;
  return (
    <button
      type="button"
      className={selected ? "active" : undefined}
      aria-current={selected ? "page" : undefined}
      data-testid={testId}
      onClick={() =>
        host.navigate({
          platformView: "spaces",
          collaborationDomain: domain,
          rootView: view,
          workspaceId: null,
          workspaceView: "home",
          projectId: null,
          projectView: "board",
          issueId: null,
        })
      }
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function CollaborationPrimaryNavigation({
  domain,
  host,
  messages,
}: NavigationProps) {
  const link = (
    view: CollaborationPlatformRootView,
    label: string,
    icon: typeof Bot,
    testId: string,
  ) => (
    <NavigationLink
      key={view}
      domain={domain}
      host={host}
      view={view}
      label={label}
      icon={icon}
      testId={testId}
    />
  );
  return (
    <nav
      className="collaboration-primary-navigation"
      aria-label={messages.collaborationHome}
    >
      {host.createIndependentIssue ? (
        <button
          type="button"
          onClick={host.createIndependentIssue}
          data-testid="collaboration-primary-create-issue"
        >
          <FilePlus2 aria-hidden="true" />
          <span>{messages.createIndependentIssue}</span>
        </button>
      ) : null}
      {link(
        "home",
        host.renderPersonalHome ? messages.personalHome : messages.home,
        host.renderPersonalHome ? CircleUserRound : FilePlus2,
        "collaboration-primary-home",
      )}
      {host.renderIssueList ? (
        <>
          <div className="collaboration-workspace-section-heading">
            <span className="collaboration-workspace-section-title">
              {messages.myIssues}
            </span>
          </div>
          {link(
            "issues-assigned",
            messages.assignedIssues,
            CircleUserRound,
            "collaboration-primary-issues-assigned",
          )}
          {link(
            "issues-created",
            messages.createdIssues,
            SquarePen,
            "collaboration-primary-issues-created",
          )}
          {link(
            "issues-participating",
            messages.participatingIssues,
            MessageSquare,
            "collaboration-primary-issues-participating",
          )}
        </>
      ) : null}
    </nav>
  );
}

export function CollaborationManagementNavigation({
  domain,
  host,
  messages,
}: NavigationProps) {
  const [expanded, setExpanded] = useState(true);
  const link = (
    view: CollaborationPlatformRootView,
    label: string,
    icon: typeof Bot,
  ) => (
    <NavigationLink
      key={view}
      domain={domain}
      host={host}
      view={view}
      label={label}
      icon={icon}
      testId={`collaboration-primary-${view}`}
    />
  );
  return (
    <nav
      className="collaboration-primary-navigation collaboration-management"
      aria-label={messages.collaborationManagement}
    >
      <button
        type="button"
        data-testid="collaboration-management-toggle"
        aria-expanded={expanded}
        aria-controls="collaboration-management-navigation"
        onClick={() => setExpanded((value) => !value)}
      >
        <Settings aria-hidden="true" />
        <span>{messages.collaborationManagement}</span>
        <ChevronRight
          aria-hidden="true"
          className={expanded ? "rotate-90" : undefined}
        />
      </button>
      <div
        id="collaboration-management-navigation"
        className="collaboration-management-navigation"
        hidden={!expanded}
      >
        {link("devices", messages.devices, Monitor)}
        {host.templateStore && host.templateNavigation
          ? link("templates", messages.templates, LayoutTemplate)
          : null}
        {link("agents", messages.agents, Bot)}
        {link("teams", messages.teams, UsersRound)}
      </div>
    </nav>
  );
}
