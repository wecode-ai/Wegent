// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FaUsers } from 'react-icons/fa';
import { HiOutlineCode, HiOutlineChatAlt2 } from 'react-icons/hi';
import { userApis } from '@/apis/user';
import { QuickAccessTeam, Team } from '@/types/api';
import { saveLastTeamByMode } from '@/utils/userPreferences';

interface QuickAccessCardsProps {
  teams: Team[];
  selectedTeam: Team | null;
  onTeamSelect: (team: Team) => void;
  currentMode: 'chat' | 'code';
  isLoading?: boolean;
}

export function QuickAccessCards({
  teams,
  selectedTeam,
  onTeamSelect,
  currentMode,
  isLoading,
}: QuickAccessCardsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [quickAccessTeams, setQuickAccessTeams] = useState<QuickAccessTeam[]>([]);
  const [isQuickAccessLoading, setIsQuickAccessLoading] = useState(true);
  const [clickedTeamId, setClickedTeamId] = useState<number | null>(null);
  const [switchingToMode, setSwitchingToMode] = useState<'chat' | 'code' | null>(null);

  // Define the extended team type for display
  type DisplayTeam = Team & { is_system: boolean; recommended_mode?: 'chat' | 'code' | 'both' };

  // Prefetch both chat and code pages on mount for smoother navigation
  useEffect(() => {
    router.prefetch('/chat');
    router.prefetch('/code');
  }, [router]);

  // Fetch quick access teams
  useEffect(() => {
    const fetchQuickAccess = async () => {
      try {
        setIsQuickAccessLoading(true);
        const response = await userApis.getQuickAccess();
        setQuickAccessTeams(response.teams);
      } catch (error) {
        console.error('Failed to fetch quick access teams:', error);
        // Fallback: use first few teams from the teams list
        setQuickAccessTeams([]);
      } finally {
        setIsQuickAccessLoading(false);
      }
    };

    fetchQuickAccess();
  }, []);

  // Filter out teams with empty bind_mode array (teams that are not available in any mode)
  const filteredTeams = teams.filter(team => {
    // If bind_mode is an empty array, filter it out
    if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false;
    return true;
  });

  // Get display teams: quick access teams matched with full team data
  const displayTeams: DisplayTeam[] =
    quickAccessTeams.length > 0
      ? quickAccessTeams
          .map(qa => {
            const fullTeam = filteredTeams.find(t => t.id === qa.id);
            if (fullTeam) {
              return {
                ...fullTeam,
                is_system: qa.is_system,
                recommended_mode: qa.recommended_mode || fullTeam.recommended_mode,
              } as DisplayTeam;
            }
            return null;
          })
          .filter((t): t is DisplayTeam => t !== null)
      : // Fallback: show first 4 filtered teams if no quick access configured
        filteredTeams.slice(0, 4).map(t => ({ ...t, is_system: false }) as DisplayTeam);

  // Determine the target mode for a team based on recommended_mode or bind_mode
  const getTeamTargetMode = (team: DisplayTeam): 'chat' | 'code' | 'both' => {
    // First check recommended_mode (from quick access config)
    if (team.recommended_mode && team.recommended_mode !== 'both') {
      return team.recommended_mode;
    }
    // Then check bind_mode - if only one mode is allowed, use that
    if (team.bind_mode && team.bind_mode.length === 1) {
      return team.bind_mode[0];
    }
    // Default to both (no mode switch needed)
    return 'both';
  };

  const handleTeamClick = useCallback(
    (team: DisplayTeam) => {
      const targetMode = getTeamTargetMode(team);

      // Check if we need to switch mode
      const needsModeSwitch = targetMode !== 'both' && targetMode !== currentMode;

      // Always trigger click animation
      setClickedTeamId(team.id);

      if (needsModeSwitch) {
        setSwitchingToMode(targetMode);

        // When switching mode, save the team preference to the TARGET mode's localStorage
        // This ensures the new page will restore the correct team
        saveLastTeamByMode(team.id, targetMode);

        // Use startTransition for smoother navigation without blocking UI
        // Delay slightly to allow animation to start
        setTimeout(() => {
          const targetPath = targetMode === 'code' ? '/code' : '/chat';
          startTransition(() => {
            router.push(targetPath);
          });
        }, 200);
      } else {
        // No mode switch needed, just select the team in current page after animation
        // First let the animation play, then select the team
        setTimeout(() => {
          onTeamSelect(team);
        }, 300);

        // Reset the clicked state after animation completes
        setTimeout(() => {
          setClickedTeamId(null);
          setSwitchingToMode(null);
        }, 400);
      }
    },
    [currentMode, router, onTeamSelect, startTransition]
  );

  if (isLoading || isQuickAccessLoading) {
    return (
      <div className="flex flex-wrap gap-3 mt-4">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-surface animate-pulse"
          >
            <div className="w-5 h-5 bg-muted rounded" />
            <div className="w-20 h-4 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (displayTeams.length === 0) {
    return null;
  }

  return (
    <>
      <style jsx>{`
        @keyframes pulse-glow {
          0% {
            box-shadow: 0 0 0 0 rgba(20, 184, 166, 0.4);
          }
          50% {
            box-shadow: 0 0 0 8px rgba(20, 184, 166, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(20, 184, 166, 0);
          }
        }

        @keyframes scale-bounce {
          0% {
            transform: scale(1);
          }
          30% {
            transform: scale(0.95);
          }
          60% {
            transform: scale(1.02);
          }
          100% {
            transform: scale(1);
          }
        }

        @keyframes slide-fade {
          0% {
            opacity: 0;
            transform: translateX(-8px);
          }
          100% {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .switching-card {
          animation:
            pulse-glow 0.4s ease-out,
            scale-bounce 0.4s ease-out;
        }

        .mode-indicator {
          animation: slide-fade 0.2s ease-out forwards;
        }
      `}</style>
      <div className="grid grid-cols-4 gap-3 mt-4">
        {displayTeams.map(team => {
          const isSelected = selectedTeam?.id === team.id;
          const isClicked = clickedTeamId === team.id;
          const targetMode = getTeamTargetMode(team);
          const willSwitchMode = targetMode !== 'both' && targetMode !== currentMode;

          return (
            <div
              key={team.id}
              onClick={() => !isClicked && !isPending && handleTeamClick(team)}
              className={`
                group relative flex items-center gap-2 px-4 py-2
                rounded-lg border cursor-pointer transition-all duration-200
                ${
                  isClicked || isPending
                    ? 'switching-card border-primary bg-primary/10 ring-2 ring-primary/50'
                    : isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-border bg-surface hover:bg-hover hover:border-border-strong'
                }
                ${isClicked || isPending ? 'pointer-events-none' : ''}
              `}
              title={team.description || undefined}
            >
              <FaUsers
                className={`w-4 h-4 flex-shrink-0 transition-colors duration-200 ${
                  isClicked || isSelected ? 'text-primary' : 'text-text-muted'
                }`}
              />
              <div className="flex flex-col min-w-0">
                <span
                  className={`text-sm font-medium transition-colors duration-200 ${
                    isClicked || isSelected ? 'text-primary' : 'text-text-secondary'
                  }`}
                >
                  {team.name}
                </span>
                {team.description && (
                  <span className="text-xs text-text-muted truncate max-w-[150px]">
                    {team.description}
                  </span>
                )}
              </div>

              {/* Mode switch indicator */}
              {isClicked && switchingToMode && (
                <div className="mode-indicator flex items-center gap-1 ml-1 text-primary">
                  <span className="text-xs">→</span>
                  {switchingToMode === 'code' ? (
                    <HiOutlineCode className="w-4 h-4" />
                  ) : (
                    <HiOutlineChatAlt2 className="w-4 h-4" />
                  )}
                </div>
              )}

              {/* Hover hint for mode switch - absolute positioned to prevent width change */}
              {!isClicked && willSwitchMode && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center text-text-muted opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  {targetMode === 'code' ? (
                    <HiOutlineCode className="w-3.5 h-3.5" />
                  ) : (
                    <HiOutlineChatAlt2 className="w-3.5 h-3.5" />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
