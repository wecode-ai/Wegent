// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { teamApis } from '@/apis/team';
import type { Team } from '@/types/api';
import TeamCard from './TeamCard';
import { Loader2 } from 'lucide-react';

interface TeamShowcaseProps {
  onSelectTeam: (team: Team) => void;
  className?: string;
}

export default function TeamShowcase({ onSelectTeam, className = '' }: TeamShowcaseProps) {
  const { t } = useTranslation('common');
  const [recommendedTeams, setRecommendedTeams] = useState<Team[]>([]);
  const [favoriteTeams, setFavoriteTeams] = useState<Team[]>([]);
  const [isLoadingRecommended, setIsLoadingRecommended] = useState(true);
  const [isLoadingFavorites, setIsLoadingFavorites] = useState(true);
  const [togglingFavoriteIds, setTogglingFavoriteIds] = useState<Set<number>>(new Set());

  // Fetch recommended teams
  useEffect(() => {
    const fetchRecommended = async () => {
      try {
        const teams = await teamApis.getRecommendedTeams(6);
        setRecommendedTeams(teams);
      } catch (error) {
        console.error('Failed to fetch recommended teams:', error);
      } finally {
        setIsLoadingRecommended(false);
      }
    };
    fetchRecommended();
  }, []);

  // Fetch favorite teams
  useEffect(() => {
    const fetchFavorites = async () => {
      try {
        const teams = await teamApis.getFavoriteTeams(6);
        setFavoriteTeams(teams);
      } catch (error) {
        console.error('Failed to fetch favorite teams:', error);
      } finally {
        setIsLoadingFavorites(false);
      }
    };
    fetchFavorites();
  }, []);

  // Toggle favorite status
  const handleToggleFavorite = useCallback(async (team: Team) => {
    if (togglingFavoriteIds.has(team.id)) return;

    setTogglingFavoriteIds(prev => new Set(prev).add(team.id));

    try {
      if (team.is_favorited) {
        await teamApis.removeTeamFromFavorites(team.id);
        // Update both lists
        setRecommendedTeams(prev =>
          prev.map(t => (t.id === team.id ? { ...t, is_favorited: false } : t))
        );
        setFavoriteTeams(prev => prev.filter(t => t.id !== team.id));
      } else {
        await teamApis.addTeamToFavorites(team.id);
        // Update recommended list
        setRecommendedTeams(prev =>
          prev.map(t => (t.id === team.id ? { ...t, is_favorited: true } : t))
        );
        // Add to favorites if not already there
        if (!favoriteTeams.some(t => t.id === team.id)) {
          setFavoriteTeams(prev => [{ ...team, is_favorited: true }, ...prev].slice(0, 6));
        }
      }
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    } finally {
      setTogglingFavoriteIds(prev => {
        const next = new Set(prev);
        next.delete(team.id);
        return next;
      });
    }
  }, [togglingFavoriteIds, favoriteTeams]);

  const hasContent = recommendedTeams.length > 0 || favoriteTeams.length > 0;
  const isLoading = isLoadingRecommended || isLoadingFavorites;

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center py-8 ${className}`}>
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!hasContent) {
    return null;
  }

  return (
    <div className={`space-y-6 mt-6 ${className}`}>
      {/* Recommended Teams Section */}
      {recommendedTeams.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-text-secondary mb-3">
            {t('teams.recommended')}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {recommendedTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                onSelect={onSelectTeam}
                onToggleFavorite={handleToggleFavorite}
                isTogglingFavorite={togglingFavoriteIds.has(team.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Favorite Teams Section */}
      {favoriteTeams.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-text-secondary mb-3">
            {t('teams.favorites')}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {favoriteTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                onSelect={onSelectTeam}
                onToggleFavorite={handleToggleFavorite}
                isTogglingFavorite={togglingFavoriteIds.has(team.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
