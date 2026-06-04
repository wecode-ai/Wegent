// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Sparkles, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { ChatArea } from '@/features/tasks/components/chat'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'
import type { ResourceLibraryTeamRef } from '../types'

interface DiscoverAssistantDrawerProps {
  open: boolean
  teams: Team[]
  isTeamsLoading: boolean
  assistantTeamRef?: ResourceLibraryTeamRef | null
  onOpenChange: (open: boolean) => void
  onRefreshTeams?: () => Promise<Team[]>
}

const DISCOVER_ASSISTANT_TEAM_NAME = 'resource-discovery-assistant'
const DISCOVER_ASSISTANT_NAMESPACE = 'default'

function findDiscoverAssistantTeam(teams: Team[], teamRef?: ResourceLibraryTeamRef | null) {
  const expectedName = teamRef?.name || DISCOVER_ASSISTANT_TEAM_NAME
  const expectedNamespace = teamRef?.namespace || DISCOVER_ASSISTANT_NAMESPACE
  return (
    teams.find(
      team =>
        team.name === expectedName &&
        (team.namespace ?? DISCOVER_ASSISTANT_NAMESPACE) === expectedNamespace
    ) ?? null
  )
}

function DiscoverAssistantEmptyState() {
  const { t } = useTranslation('resource-library')

  return (
    <div
      className="mx-auto flex max-w-[420px] flex-col items-center px-6 text-center"
      data-testid="discover-assistant-empty-state"
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface text-primary">
        <Sparkles className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-text-primary">
        {t('discover.assistant.empty_title')}
      </h3>
      <p className="mt-2 text-sm leading-6 text-text-secondary">
        {t('discover.assistant.empty_description')}
      </p>
    </div>
  )
}

export function DiscoverAssistantDrawer({
  open,
  teams,
  isTeamsLoading,
  assistantTeamRef,
  onOpenChange,
  onRefreshTeams,
}: DiscoverAssistantDrawerProps) {
  const { t } = useTranslation('resource-library')
  const discoverAssistantTeam = findDiscoverAssistantTeam(teams, assistantTeamRef)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="flex max-h-[90vh] bg-base sm:inset-x-auto sm:inset-y-0 sm:left-auto sm:right-0 sm:mt-0 sm:h-screen sm:max-h-screen sm:w-[560px] sm:rounded-none sm:border-l"
        data-testid="discover-assistant-drawer"
      >
        <DrawerHeader className="shrink-0 border-b border-border text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <DrawerTitle className="text-lg">{t('discover.assistant.title')}</DrawerTitle>
                <Badge variant="info">{t('discover.assistant.agent_badge')}</Badge>
              </div>
              <DrawerDescription>{t('discover.assistant.description')}</DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-11 min-w-[44px] px-3 lg:h-9"
                aria-label={t('actions.close')}
                data-testid="discover-assistant-close-button"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DrawerClose>
          </div>
        </DrawerHeader>

        <div className="min-h-0 flex-1">
          {isTeamsLoading ? (
            <div
              className="flex h-full items-center justify-center px-6 text-sm text-text-secondary"
              data-testid="discover-assistant-loading"
            >
              {t('discover.assistant.loading')}
            </div>
          ) : discoverAssistantTeam ? (
            <ChatArea
              teams={[discoverAssistantTeam]}
              isTeamsLoading={false}
              selectedTeamForNewTask={discoverAssistantTeam}
              showRepositorySelector={false}
              taskType="chat"
              hideSelectors
              inputAlwaysAtBottom
              emptyStateContent={<DiscoverAssistantEmptyState />}
              onRefreshTeams={onRefreshTeams}
            />
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center px-6 text-center"
              data-testid="discover-assistant-unavailable"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                <Bot className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-text-primary">
                {t('discover.assistant.unavailable_title')}
              </h3>
              <p className="mt-2 max-w-[360px] text-sm leading-6 text-text-secondary">
                {t('discover.assistant.unavailable_description')}
              </p>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
