// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import '@/features/common/scrollbar.css';
import { AiOutlineTeam } from 'react-icons/ai';
import { RiRobot2Line } from 'react-icons/ri';
import LoadingState from '@/features/common/LoadingState';
import {
  PencilIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ChatBubbleLeftEllipsisIcon,
  ShareIcon,
} from '@heroicons/react/24/outline';
import { Bot, Team } from '@/types/api';
import { fetchTeamsList, deleteTeam, shareTeam } from '../services/teams';
import { fetchBotsList } from '../services/bots';
import TeamEdit from './TeamEdit';
import BotList from './BotList';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import TeamShareModal from './TeamShareModal';
import { useTranslation } from '@/hooks/useTranslation';
import { useToast } from '@/hooks/use-toast';
import { sortTeamsByUpdatedAt } from '@/utils/team';
import { sortBotsByUpdatedAt } from '@/utils/bot';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function TeamList() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [teams, setTeams] = useState<Team[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null);
  const [prefillTeam, setPrefillTeam] = useState<Team | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<number | null>(null);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareData, setShareData] = useState<{ teamName: string; shareUrl: string } | null>(null);
  const [sharingId, setSharingId] = useState<number | null>(null);
  const [_deletingId, setDeletingId] = useState<number | null>(null);
  const [botListVisible, setBotListVisible] = useState(false);
  const router = useRouter();
  const isEditing = editingTeamId !== null;
  const isMobile = useMediaQuery('(max-width: 639px)');

  const setTeamsSorted = useCallback<React.Dispatch<React.SetStateAction<Team[]>>>(
    updater => {
      setTeams(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Team[]) => Team[])(prev) : updater;
        return sortTeamsByUpdatedAt(next);
      });
    },
    [setTeams]
  );

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>(
    updater => {
      setBots(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Bot[]) => Bot[])(prev) : updater;
        return sortBotsByUpdatedAt(next);
      });
    },
    [setBots]
  );

  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      try {
        const [teamsData, botsData] = await Promise.all([fetchTeamsList(), fetchBotsList()]);
        setTeamsSorted(teamsData);
        setBotsSorted(botsData);
      } catch {
        toast({
          variant: 'destructive',
          title: t('teams.loading'),
        });
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, [toast, setBotsSorted, setTeamsSorted, t]);

  useEffect(() => {
    if (editingTeamId === null) {
      setPrefillTeam(null);
    }
  }, [editingTeamId]);

  const handleCreateTeam = () => {
    setPrefillTeam(null);
    setEditingTeamId(0); // Use 0 to mark new creation
  };

  const handleEditTeam = (team: Team) => {
    setEditingTeamId(team.id);
  };

  const handleCopyTeam = (team: Team) => {
    const clone: Team = {
      ...team,
      bots: team.bots.map(bot => ({ ...bot })),
      workflow: team.workflow ? { ...team.workflow } : {},
    };
    setPrefillTeam(clone);
    setEditingTeamId(0);
  };

  const handleChatTeam = (team: Team) => {
    const params = new URLSearchParams();
    params.set('teamId', String(team.id));
    router.push(`/chat?${params.toString()}`);
  };

  const handleDelete = (teamId: number) => {
    setTeamToDelete(teamId);
    setDeleteConfirmVisible(true);
  };

  const handleConfirmDelete = async () => {
    if (!teamToDelete) return;

    setDeletingId(teamToDelete);
    try {
      await deleteTeam(teamToDelete);
      setTeamsSorted(prev => prev.filter(team => team.id !== teamToDelete));
      setDeleteConfirmVisible(false);
      setTeamToDelete(null);
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.delete'),
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false);
    setTeamToDelete(null);
  };

  const handleShareTeam = async (team: Team) => {
    setSharingId(team.id);
    try {
      const response = await shareTeam(team.id);
      setShareData({
        teamName: team.name,
        shareUrl: response.share_url,
      });
      setShareModalVisible(true);
      // Update team status to sharing
      setTeamsSorted(prev => prev.map(t => (t.id === team.id ? { ...t, share_status: 1 } : t)));
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.share_failed'),
      });
    } finally {
      setSharingId(null);
    }
  };

  const handleCloseShareModal = () => {
    setShareModalVisible(false);
    setShareData(null);
  };

  // Get team status label
  const getTeamStatusLabel = (team: Team) => {
    if (team.share_status === 1) {
      return <Tag variant="info">{t('teams.sharing')}</Tag>;
    } else if (team.share_status === 2 && team.user?.user_name) {
      return <Tag variant="success">{t('teams.shared_by', { author: team.user.user_name })}</Tag>;
    }
    return null;
  };

  // Check if edit and delete buttons should be shown
  const shouldShowEditDelete = (team: Team) => {
    return team.share_status !== 2; // Shared teams don't show edit and delete buttons
  };

  // Check if share button should be shown
  const shouldShowShare = (team: Team) => {
    return !team.share_status || team.share_status === 0 || team.share_status === 1; // Personal teams (no share_status or share_status=0) show share button
  };

  return (
    <>
      <div className="flex flex-col h-full min-h-0">
        <div className="flex-shrink-0 mb-3">
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('teams.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('teams.description')}</p>
        </div>
        <div
          className={`bg-base border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'flex-1 flex flex-col min-h-0 overflow-hidden'
              : isMobile
                ? 'max-h-[calc(100vh-200px)] flex flex-col overflow-y-auto custom-scrollbar'
                : 'max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
          }`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('teams.loading')} />
          ) : (
            <>
              {/* Edit/New mode */}
              {isEditing ? (
                <TeamEdit
                  teams={teams}
                  setTeams={setTeamsSorted}
                  editingTeamId={editingTeamId}
                  setEditingTeamId={setEditingTeamId}
                  initialTeam={prefillTeam}
                  bots={bots}
                  setBots={setBotsSorted}
                  toast={toast}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
                    {teams.length > 0 ? (
                      teams.map(team => (
                        <Card
                          key={team.id}
                          className="p-4 bg-base hover:bg-hover transition-colors"
                        >
                          <div className="flex items-center justify-between min-w-0">
                            <div className="flex items-center space-x-3 min-w-0 flex-1">
                              <AiOutlineTeam className="w-5 h-5 text-primary flex-shrink-0" />
                              <div className="flex flex-col justify-center min-w-0 flex-1">
                                <div className="flex items-center space-x-2 min-w-0">
                                  <h3 className="text-base font-medium text-text-primary mb-0 truncate">
                                    {team.name}
                                  </h3>
                                  <div className="flex items-center space-x-1 flex-shrink-0">
                                    <div
                                      className="w-2 h-2 rounded-full"
                                      style={{
                                        backgroundColor: team.is_active
                                          ? 'rgb(var(--color-success))'
                                          : 'rgb(var(--color-border))',
                                      }}
                                    ></div>
                                    <span className="text-xs text-text-muted">
                                      {team.is_active ? t('teams.active') : t('teams.inactive')}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
                                  {team.workflow?.mode && (
                                    <Tag variant="default" className="capitalize">
                                      {t(`team_model.${String(team.workflow.mode)}`)}
                                    </Tag>
                                  )}
                                  {getTeamStatusLabel(team)}
                                  {team.bots.length > 0 && (
                                    <Tag variant="info" className="hidden sm:inline-flex">
                                      {team.bots.length} {team.bots.length === 1 ? 'Bot' : 'Bots'}
                                    </Tag>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleChatTeam(team)}
                                title={t('teams.chat')}
                                className="h-8 w-8"
                              >
                                <ChatBubbleLeftEllipsisIcon className="w-4 h-4" />
                              </Button>
                              {shouldShowEditDelete(team) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleEditTeam(team)}
                                  title={t('teams.edit')}
                                  className="h-8 w-8"
                                >
                                  <PencilIcon className="w-4 h-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleCopyTeam(team)}
                                title={t('teams.copy')}
                                className="h-8 w-8"
                              >
                                <DocumentDuplicateIcon className="w-4 h-4" />
                              </Button>
                              {shouldShowShare(team) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleShareTeam(team)}
                                  title={t('teams.share')}
                                  className="h-8 w-8"
                                  disabled={sharingId === team.id}
                                >
                                  <ShareIcon className="w-4 h-4" />
                                </Button>
                              )}
                              {shouldShowEditDelete(team) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDelete(team.id)}
                                  title={t('teams.delete')}
                                  className="h-8 w-8 hover:text-error"
                                >
                                  <TrashIcon className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      ))
                    ) : (
                      <div className="text-center text-text-muted py-8">
                        <p className="text-sm">{t('teams.no_teams')}</p>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border pt-3 mt-3 bg-base">
                    <div className="flex justify-center gap-3">
                      <UnifiedAddButton onClick={handleCreateTeam}>
                        {t('teams.new_team')}
                      </UnifiedAddButton>
                      <Button
                        variant="outline"
                        onClick={() => setBotListVisible(true)}
                        className="flex items-center gap-2"
                      >
                        <RiRobot2Line className="w-4 h-4" />
                        {t('bots.manage_bots')}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmVisible} onOpenChange={setDeleteConfirmVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('teams.delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('teams.delete_confirm_message')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share success dialog */}
      {shareData && (
        <TeamShareModal
          visible={shareModalVisible}
          onClose={handleCloseShareModal}
          teamName={shareData.teamName}
          shareUrl={shareData.shareUrl}
        />
      )}

      {/* Bot list dialog */}
      <Dialog open={botListVisible} onOpenChange={setBotListVisible}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('bots.title')}</DialogTitle>
            <DialogDescription>{t('bots.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <BotList />
          </div>
        </DialogContent>
      </Dialog>
      {/* Error prompt unified with antd message, no local rendering */}
    </>
  );
}
