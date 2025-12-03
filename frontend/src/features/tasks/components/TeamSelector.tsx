// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useMemo } from 'react';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { FaUsers } from 'react-icons/fa';
import { Tag } from '@/components/ui/tag';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { useRouter } from 'next/navigation';
import { Team } from '@/types/api';
import { useTaskContext } from '../contexts/taskContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { paths } from '@/config/paths';
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles';

interface TeamSelectorProps {
  selectedTeam: Team | null;
  setSelectedTeam: (team: Team | null) => void;
  teams: Team[];
  disabled: boolean;
  isLoading?: boolean;
}

export default function TeamSelector({
  selectedTeam,
  setSelectedTeam,
  teams,
  disabled,
  isLoading,
}: TeamSelectorProps) {
  const { selectedTaskDetail } = useTaskContext();
  const { t } = useTranslation('common');
  const router = useRouter();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const sharedBadgeStyle = useMemo(() => getSharedBadgeStyle(), []);
  // Handle team selection from task detail
  useEffect(() => {
    // Priority 1: Set team from task detail if viewing a task
    if (
      selectedTaskDetail &&
      'team' in selectedTaskDetail &&
      selectedTaskDetail.team &&
      teams.length > 0
    ) {
      const foundTeam =
        teams.find(t => t.id === (selectedTaskDetail.team as { id: number }).id) || null;
      if (foundTeam && (!selectedTeam || selectedTeam.id !== foundTeam.id)) {
        console.log('[TeamSelector] Setting team from task detail:', foundTeam.name, foundTeam.id);
        setSelectedTeam(foundTeam);
        return;
      }
    }

    // Priority 2: Validate selected team still exists in list
    if (selectedTeam && teams.length > 0) {
      const exists = teams.some(team => team.id === selectedTeam.id);
      if (!exists) {
        console.log('[TeamSelector] Selected team not in list, clearing selection');
        setSelectedTeam(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, teams]);

  const handleChange = (value: string) => {
    const team = teams.find(t => t.id === Number(value));
    if (team) {
      setSelectedTeam(team);
    }
  };

  // Convert teams to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    return teams.map(team => {
      const isSharedTeam = team.share_status === 2 && team.user?.user_name;
      return {
        value: team.id.toString(),
        label: team.name,
        searchText: team.name,
        content: (
          <div className="flex items-center gap-2 min-w-0">
            <FaUsers className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
            <span
              className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0"
              title={team.name}
            >
              {team.name}
            </span>
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
  }, [teams, t, sharedBadgeStyle]);

  if (!selectedTeam || teams.length === 0) return null;

  return (
    <div
      className="flex items-center space-x-2 min-w-0 flex-shrink"
      data-tour="team-selector"
      style={{ maxWidth: isMobile ? 200 : 260, minWidth: isMobile ? 60 : 80 }}
    >
      <FaUsers
        className={`w-3 h-3 text-text-muted flex-shrink-0 ml-1 ${isLoading ? 'animate-pulse' : ''}`}
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
          renderTriggerValue={item => {
            if (!item) return null;
            const team = teams.find(t => t.id.toString() === item.value);
            const isSharedTeam = team?.share_status === 2 && team?.user?.user_name;
            return (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate max-w-full flex-1 min-w-0" title={item.label}>
                  {item.label}
                </span>
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
              <span className="font-medium group-hover:text-text-primary">{t('teams.manage')}</span>
            </div>
          }
        />
      </div>
    </div>
  );
}
