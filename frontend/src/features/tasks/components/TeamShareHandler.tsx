// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button, Alert, App } from 'antd';
import { teamApis, TeamShareInfoResponse } from '@/apis/team';
import { Team } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { useUser } from '@/features/common/UserContext';
import Modal from '@/features/common/Modal';

interface TeamShareHandlerProps {
  teams: Team[];
  onTeamSelected: (team: Team) => void;
  onRefreshTeams: () => Promise<Team[]>;
}

/**
 * Handle team sharing URL parameter detection, join logic, and modal display
 */
export default function TeamShareHandler({
  teams,
  onTeamSelected,
  onRefreshTeams,
}: TeamShareHandlerProps) {
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const { user } = useUser();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [shareInfo, setShareInfo] = useState<TeamShareInfoResponse | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [_isLoading, setIsLoading] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isTeamAlreadyJoined = shareInfo ? teams.some(team => team.id === shareInfo.team_id) : false;
  const isSelfShare = shareInfo && user && shareInfo.user_id === user.id;

  useEffect(() => {
    const teamShareToken = searchParams.get('teamShare');

    if (!teamShareToken) {
      return;
    }

    const fetchShareInfo = async () => {
      setIsLoading(true);
      try {
        const info = await teamApis.getTeamShareInfo(encodeURIComponent(teamShareToken));
        setShareInfo(info);
        setIsModalOpen(true);
      } catch {
        console.error('Failed to fetch team share info:', error);
        message.error(t('teams.share.fetch_info_failed'));
        cleanupUrlParams();
      } finally {
        setIsLoading(false);
      }
    };

    fetchShareInfo();
  }, [searchParams, message, t]);

  const cleanupUrlParams = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('teamShare');
    router.replace(url.pathname + url.search);
  };

  const handleConfirmJoin = async () => {
    if (!shareInfo) return;

    if (isSelfShare) {
      handleSelfShare();
      return;
    }

    if (isTeamAlreadyJoined) {
      // Find the existing team and select it
      const existingTeam = teams.find((team: Team) => team.id === shareInfo?.team_id);
      if (existingTeam) {
        onTeamSelected(existingTeam);
      }
      handleCloseModal();
      return;
    }

    setIsJoining(true);
    setError(null);
    try {
      await teamApis.joinSharedTeam({ share_token: searchParams.get('teamShare')! });

      message.success(t('teams.share.join_success', { teamName: shareInfo?.team_name || '' }));

      // First refresh team list, wait for refresh to complete and get latest team list
      const updatedTeams = await onRefreshTeams();

      // Find the newly joined team from the refreshed team list and select it
      const newTeam = updatedTeams.find(team => team.id === shareInfo.team_id);
      if (newTeam) {
        onTeamSelected(newTeam);
      }

      handleCloseModal();
    } catch (err) {
      console.error('Failed to join shared team:', err);
      const errorMessage = (err as Error)?.message || t('teams.share.join_failed');
      message.error(errorMessage);
      setError(errorMessage);
    } finally {
      setIsJoining(false);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setShareInfo(null);
    setError(null);
    cleanupUrlParams();
  };

  const handleSelfShare = () => {
    handleCloseModal();
  };

  const renderMessageWithHighlight = (messageKey: string, teamName: string, userName?: string) => {
    const highlightClass = 'text-lg font-semibold text-blue-600';

    const messageRenderers = {
      'teams.share.self_share_message': () => (
        <span>
          <span className={highlightClass}> {teamName} </span>
          {t('teams.share.self_share_suffix')}
        </span>
      ),
      'teams.share.already_joined_message': () => (
        <span>
          <span className={highlightClass}> {teamName} </span>
          {t('teams.share.already_joined_suffix')}
        </span>
      ),
      'teams.share.confirm_message': () =>
        userName ? (
          <span>
            {t('teams.share.confirm_prefix')}
            <span className={highlightClass}> {userName} </span>
            {t('teams.share.confirm_middle')}
            <span className={highlightClass}> {teamName} </span>
            {t('teams.share.confirm_suffix')}
          </span>
        ) : null,
      'teams.share.join_description': () => (
        <span>
          {t('teams.share.join_description_prefix')}
          <span className="font-semibold"> {teamName} </span>
          {t('teams.share.join_description_suffix')}
        </span>
      ),
    };

    const renderer = messageRenderers[messageKey as keyof typeof messageRenderers];
    return renderer ? renderer() : t(messageKey, { teamName, userName });
  };

  if (!shareInfo || !isModalOpen) return null;

  return (
    <Modal
      isOpen={isModalOpen}
      onClose={handleCloseModal}
      title={t('teams.share.title')}
      maxWidth="md"
    >
      <div className="space-y-4">
        {error && (
          <Alert message={error} type="error" showIcon closable onClose={() => setError(null)} />
        )}
        {isSelfShare ? (
          <>
            <Alert
              message={renderMessageWithHighlight(
                'teams.share.self_share_message',
                shareInfo.team_name
              )}
              type="warning"
              showIcon
            />
          </>
        ) : isTeamAlreadyJoined ? (
          <>
            <Alert
              message={renderMessageWithHighlight(
                'teams.share.already_joined_message',
                shareInfo.team_name
              )}
              type="warning"
              showIcon
            />
          </>
        ) : (
          <>
            <div className="text-center">
              <p className="text-text-primary text-base">
                {renderMessageWithHighlight(
                  'teams.share.confirm_message',
                  shareInfo.team_name,
                  shareInfo.user_name
                )}
              </p>
            </div>

            <Alert
              message={renderMessageWithHighlight(
                'teams.share.join_description',
                shareInfo.team_name
              )}
              type="info"
              showIcon
            />
          </>
        )}
      </div>

      <div className="flex space-x-3 mt-6">
        <Button
          onClick={handleCloseModal}
          type="default"
          size="small"
          style={{ flex: 1 }}
          disabled={isJoining}
        >
          {t('actions.cancel')}
        </Button>
        <Button
          onClick={handleConfirmJoin}
          type="primary"
          size="small"
          loading={isJoining}
          disabled={!!isSelfShare}
          style={{ flex: 1 }}
        >
          {isJoining ? t('teams.share.joining') : t('teams.share.confirm_join')}
        </Button>
      </div>
    </Modal>
  );
}
