// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useMemo, useContext } from 'react';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { Tag } from '@/components/ui/tag';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { useRouter } from 'next/navigation';
import { Team, TaskDetail } from '@/types/api';
import { TaskContext } from '../contexts/taskContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { paths } from '@/config/paths';
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles';
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay';

interface TeamSelectorProps {
  selectedTeam: Team | null;
  setSelectedTeam: (team: Team | null) => void;
  teams: Team[];
  disabled: boolean;
  isLoading?: boolean;
  // Optional: pass task detail directly instead of using context
  taskDetail?: TaskDetail | null;
  // Optional: hide the settings footer link
  hideSettingsLink?: boolean;
  // Optional: current mode for filtering teams by bind_mode
  currentMode?: 'chat' | 'code';
  // Optional: whether to open the dropdown by default
  defaultOpen?: boolean;
}

export default function TeamSelector({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  isLoading,
  taskDetail,
  hideSettingsLink = false,
  currentMode,
  defaultOpen = false,
}: TeamSelectorProps) {
  // Try to get context, but don't throw if not available
  const taskContext = useContext(TaskContext);
  const selectedTaskDetail = taskDetail ?? taskContext?.selectedTaskDetail ?? null;
  const { t } = useTranslation('common');
  const router = useRouter();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(), []);

  // Filter teams by bind_mode based on current mode
  const filteredTeams = useMemo(() => {
    // First filter out teams with empty bind_mode array
    const teamsWithValidBindMode = teams.filter(team => {
      // If bind_mode is an empty array, filter it out
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false;
      return true;
    });

    if (!currentMode) return teamsWithValidBindMode;
    return teamsWithValidBindMode.filter(team => {
      // If bind_mode is not set (undefined/null), show in all modes
      if (!team.bind_mode) return true;
      // Otherwise, only show if current mode is in bind_mode
      return team.bind_mode.includes(currentMode);
    });
  }, [teams, currentMode]);

  // Handle team selection from task detail
  useEffect(() => {
    // Priority 1: Set team from task detail if viewing a task
    if (
      selectedTaskDetail &&
      'team' in selectedTaskDetail &&
      selectedTaskDetail.team &&
      filteredTeams.length > 0
    ) {
      const foundTeam =
        filteredTeams.find(t => t.id === (selectedTaskDetail.team as { id: number }).id) || null;
      if (foundTeam && (!selectedTeam || selectedTeam.id !== foundTeam.id)) {
        console.log('[TeamSelector] Setting team from task detail:', foundTeam.name, foundTeam.id);
        setSelectedTeam(foundTeam);
        return;
      }
    }

    // Priority 2: Validate selected team still exists in filtered list
    if (selectedTeam) {
      if (filteredTeams.length > 0) {
        const exists = filteredTeams.some(team => team.id === selectedTeam.id);
        if (!exists) {
          // When selected team is filtered out, auto-select the first available team
          setSelectedTeam(filteredTeams[0]);
        }
      } else {
        // No teams available after filtering, clear selection
        setSelectedTeam(null);
      }
    }
  }, [selectedTaskDetail, filteredTeams, selectedTeam, setSelectedTeam]);

  const handleChange = (value: string) => {
    const team = filteredTeams.find(t => t.id === Number(value));
    if (team) {
      setSelectedTeam(team);
    }
  };

  // Convert filtered teams to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    return filteredTeams.map(team => {
      const isSharedTeam = team.share_status === 2 && team.user?.user_name;
      const isGroupTeam = team.namespace && team.namespace !== 'default';
      return {
        value: team.id.toString(),
        label: team.name,
        searchText: team.name,
        content: (
          <div className="flex items-center gap-2 min-w-0">
            <TeamIconDisplay iconId={team.icon} size="sm" className="flex-shrink-0 text-text-muted" />
            <span
              className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0"
              title={team.name}
            >
              {team.name}
            </span>
            {isGroupTeam && (
              <Tag className="ml-2 text-xs !m-0 flex-shrink-0" variant="info">
                {team.namespace}
              </Tag>
            )}
            {isSharedTeam && (
              <Tag
                className="ml-2 text-xs !m-0 flex-shrink-0"
                variant="default"
                style={sharedBadgeStyle}
              >
                {t('teams.shared_by', { author: team.user?.user_name })}
              </Tag>
            )}
          </div>
        ),
      };
    });
  }, [filteredTeams, t, sharedBadgeStyle]);

  if (!selectedTeam || filteredTeams.length === 0) return null;

  return (
    <div
      className="flex items-center space-x-2 min-w-0 flex-shrink"
      data-tour="team-selector"
      style={{ maxWidth: isMobile ? 200 : 260, minWidth: isMobile ? 60 : 80 }}
    >
      <TeamIconDisplay
        iconId={selectedTeam?.icon}
        size="xs"
        className={`text-text-muted flex-shrink-0 ml-1 ${isLoading ? 'animate-pulse' : ''}`}
      />
      <div className="relative min-w-0 flex-1">
        <SearchableSelect
          value={selectedTeam?.id.toString()}
          onValueChange={handleChange}
          disabled={disabled || isLoading}
          placeholder={isLoading ? 'Loading...' : t('teams.select_team')}
          searchPlaceholder={t('teams.search_team')}
          items={selectItems}
          loading={isLoading}
          emptyText={t('teams.no_match')}
          noMatchText={t('teams.no_match')}
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName="max-w-[320px]"
          defaultOpen={defaultOpen}
          renderTriggerValue={item => {
            if (!item) return null;
            const team = filteredTeams.find(t => t.id.toString() === item.value);
            const isSharedTeam = team?.share_status === 2 && team?.user?.user_name;
            const isGroupTeam = team?.namespace && team.namespace !== 'default';
            return (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate max-w-full flex-1 min-w-0" title={item.label}>
                  {item.label}
                </span>
                {isGroupTeam && (
                  <Tag className="text-xs !m-0 flex-shrink-0 ml-2" variant="info">
                    {team.namespace}
                  </Tag>
                )}
                {isSharedTeam && (
                  <Tag
                    className="text-xs !m-0 flex-shrink-0 ml-2"
                    variant="default"
                    style={sharedBadgeStyle}
                  >
                    {team.user?.user_name}
                  </Tag>
                )}
              </div>
            );
          }}
          footer={
            hideSettingsLink ? undefined : (
              <div
                className="border-t border-border bg-base cursor-pointer group flex items-center space-x-2 px-2.5 py-2 text-xs text-text-secondary hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full"
                onClick={() => router.push(paths.settings.team.getHref())}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(paths.settings.team.getHref());
                  }
                }}
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">
                  {t('teams.manage')}
                </span>
              </div>
            )
          }
        />
      </div>
    </div>
  );
}
