import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

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
} from 'lucide-react'
import { useState } from 'react'
import type { PlatformMessages } from './platformMessages'
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
  CollaborationPlatformRootView,
} from './types'

type NavigationProps = {
  domain: CollaborationDomain
  host: CollaborationPlatformHostAdapter
  messages: PlatformMessages
}

function NavigationLink({
  domain,
  host,
  view,
  label,
  icon: Icon,
  testId,
}: Omit<NavigationProps, 'messages'> & {
  view: CollaborationPlatformRootView
  label: string
  icon: typeof Bot
  testId: string
}) {
  const selected =
    !host.location.workspaceId &&
    !host.location.projectId &&
    (host.location.rootView ?? 'home') === view
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      className={selected ? 'active' : undefined}
      aria-current={selected ? 'page' : undefined}
      data-testid={testId}
      onClick={() =>
        host.navigate({
          platformView: 'spaces',
          collaborationDomain: domain,
          rootView: view,
          workspaceId: null,
          workspaceView: 'home',
          projectId: null,
          projectView: 'board',
          issueId: null,
        })
      }
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </ControlButton>
  )
}

export function CollaborationPrimaryNavigation({ domain, host, messages }: NavigationProps) {
  const link = (
    view: CollaborationPlatformRootView,
    label: string,
    icon: typeof Bot,
    testId: string
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
  )
  return (
    <nav className="collaboration-primary-navigation" aria-label={messages.collaborationHome}>
      {link(
        'home',
        host.renderPersonalHome || host.createIndependentIssue ? messages.personalHome : messages.home,
        host.renderPersonalHome || host.createIndependentIssue ? CircleUserRound : FilePlus2,
        'collaboration-primary-home'
      )}
      {host.renderIssueList || host.createIndependentIssue ? (
        <>
          {host.createIndependentIssue ? (
            <ControlButton
              variant="unstyled"
              type="button"
              onClick={host.createIndependentIssue}
              data-testid="collaboration-primary-create-issue"
            >
              <FilePlus2 aria-hidden="true" />
              <span>{messages.createIndependentIssue}</span>
            </ControlButton>
          ) : null}
          {host.renderIssueList ? (
            <>
              {link(
                'issues-assigned',
                messages.assignedIssues,
                CircleUserRound,
                'collaboration-primary-issues-assigned'
              )}
              {link(
                'issues-created',
                messages.createdIssues,
                SquarePen,
                'collaboration-primary-issues-created'
              )}
              {link(
                'issues-participating',
                messages.participatingIssues,
                MessageSquare,
                'collaboration-primary-issues-participating'
              )}
            </>
          ) : null}
        </>
      ) : null}
    </nav>
  )
}

export function CollaborationManagementNavigation({ domain, host, messages }: NavigationProps) {
  const [expanded, setExpanded] = useState(false)
  const link = (view: CollaborationPlatformRootView, label: string, icon: typeof Bot) => (
    <NavigationLink
      key={view}
      domain={domain}
      host={host}
      view={view}
      label={label}
      icon={icon}
      testId={`collaboration-primary-${view}`}
    />
  )
  return (
    <nav
      className="collaboration-primary-navigation collaboration-management"
      aria-label={messages.collaborationManagement}
    >
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="collaboration-management-toggle"
        aria-expanded={expanded}
        aria-controls="collaboration-management-navigation"
        onClick={() => setExpanded(value => !value)}
      >
        <Settings aria-hidden="true" />
        <span>{messages.collaborationManagement}</span>
        <ChevronRight aria-hidden="true" className={expanded ? 'rotate-90' : undefined} />
      </ControlButton>
      <div
        id="collaboration-management-navigation"
        className="collaboration-management-navigation"
        hidden={!expanded}
      >
        {link('devices', messages.devices, Monitor)}
        {host.templateStore && host.templateNavigation
          ? link('templates', messages.templates, LayoutTemplate)
          : null}
        {link('agents', messages.agents, Bot)}
        {link('teams', messages.teams, UsersRound)}
      </div>
    </nav>
  )
}
