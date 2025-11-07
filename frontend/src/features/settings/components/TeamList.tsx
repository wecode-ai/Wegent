// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import '@/features/common/scrollbar.css'
import { RiRobot2Line } from 'react-icons/ri'
import { FiArrowRight } from 'react-icons/fi'
import { AiOutlineTeam } from 'react-icons/ai'
import LoadingState from '@/features/common/LoadingState'
import { PencilIcon, TrashIcon, DocumentDuplicateIcon, ChatBubbleLeftEllipsisIcon, EllipsisVerticalIcon, ShareIcon } from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import { fetchTeamsList, deleteTeam, shareTeam } from '../services/teams'
import { fetchBotsList } from '../services/bots'
import TeamEdit from './TeamEdit'
import TeamShareModal from './TeamShareModal'
import { App, Button, Dropdown, Modal, Tag, theme } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import { sortTeamsByUpdatedAt } from '@/utils/team'
import { sortBotsByUpdatedAt } from '@/utils/bot'
import { useRouter } from 'next/navigation'
import { getSharedTagStyle as getStatusTagStyle, getWorkflowTagStyle } from '@/utils/styles'

export default function TeamList() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
    // Unified error prompt using antd message.error, no local error state needed
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null)
  const [prefillTeam, setPrefillTeam] = useState<Team | null>(null)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [teamToDelete, setTeamToDelete] = useState<number | null>(null)
  const [shareModalVisible, setShareModalVisible] = useState(false)
  const [shareData, setShareData] = useState<{ teamName: string; shareUrl: string } | null>(null)
  const [sharingId, setSharingId] = useState<number | null>(null)
  const router = useRouter()
  const isEditing = editingTeamId !== null
  const isDesktop = useMediaQuery('(min-width: 640px)')
  const isMobile = useMediaQuery('(max-width: 639px)')
  const statusTagStyle = useMemo<React.CSSProperties>(() => getStatusTagStyle(token), [token])
  const workflowTagStyle = useMemo<React.CSSProperties>(() => getWorkflowTagStyle(token), [token])

  const setTeamsSorted = useCallback<React.Dispatch<React.SetStateAction<Team[]>>>((updater) => {
    setTeams(prev => {
      const next = typeof updater === 'function'
        ? (updater as (value: Team[]) => Team[])(prev)
        : updater
      return sortTeamsByUpdatedAt(next)
    })
  }, [setTeams])

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>((updater) => {
    setBots(prev => {
      const next = typeof updater === 'function'
        ? (updater as (value: Bot[]) => Bot[])(prev)
        : updater
      return sortBotsByUpdatedAt(next)
    })
  }, [setBots])

  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const [teamsData, botsData] = await Promise.all([fetchTeamsList(), fetchBotsList()])
        setTeamsSorted(teamsData)
        setBotsSorted(botsData)
      } catch (e) {
        message.error(t('teams.loading'))
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [])

  useEffect(() => {
    if (editingTeamId === null) {
      setPrefillTeam(null)
    }
  }, [editingTeamId])

  const handleCreateTeam = () => {
    setPrefillTeam(null)
    setEditingTeamId(0) // Use 0 to mark new creation
  }

  const handleEditTeam = (team: Team) => {
    setEditingTeamId(team.id)
  }

  const handleCopyTeam = (team: Team) => {
    const clone: Team = {
      ...team,
      bots: team.bots.map(bot => ({ ...bot })),
      workflow: team.workflow ? { ...team.workflow } : {},
    }
    setPrefillTeam(clone)
    setEditingTeamId(0)
  }

  const handleChatTeam = (team: Team) => {
    const params = new URLSearchParams()
    params.set('teamId', String(team.id))
    router.push(`/chat?${params.toString()}`)
  }

  const handleDelete = (teamId: number) => {
    setTeamToDelete(teamId)
    setDeleteConfirmVisible(true)
  }

  const handleConfirmDelete = async () => {
    if (!teamToDelete) return

    setDeletingId(teamToDelete)
    try {
      await deleteTeam(teamToDelete)
      setTeamsSorted(prev => prev.filter(team => team.id !== teamToDelete))
      setDeleteConfirmVisible(false)
      setTeamToDelete(null)
    } catch (e) {
      message.error(t('teams.delete'))
    } finally {
      setDeletingId(null)
    }
  }

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false)
    setTeamToDelete(null)
  }

  const handleShareTeam = async (team: Team) => {
    setSharingId(team.id)
    try {
      const response = await shareTeam(team.id)
      setShareData({
        teamName: team.name,
        shareUrl: response.share_url
      })
      setShareModalVisible(true)
      // Update team status to sharing
      setTeamsSorted(prev => prev.map(t =>
        t.id === team.id ? { ...t, share_status: 1 } : t
      ))
    } catch (e) {
      message.error(t('teams.share_failed'))
    } finally {
      setSharingId(null)
    }
  }

  const handleCloseShareModal = () => {
    setShareModalVisible(false)
    setShareData(null)
  }

  // Get team status label
  const getTeamStatusLabel = (team: Team) => {
    if (team.share_status === 1) {
      return (
        <Tag className="!m-0" style={statusTagStyle}>
          {t('teams.sharing')}
        </Tag>
      )
    } else if (team.share_status === 2 && team.user?.user_name) {
      return (
        <Tag className="!m-0" style={statusTagStyle}>
          {t('teams.shared_by', { author: team.user.user_name })}
        </Tag>
      )
    }
    return null
  }

  // Check if edit and delete buttons should be shown
  const shouldShowEditDelete = (team: Team) => {
    return team.share_status !== 2 // Shared teams don't show edit and delete buttons
  }

  // Check if share button should be shown
  const shouldShowShare = (team: Team) => {
    return !team.share_status || team.share_status === 0 || team.share_status === 1 // Personal teams (no share_status or share_status=0) show share button
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('teams.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('teams.description')}</p>
        </div>
        <div
          className={`bg-surface border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'md:min-h-[70vh] flex items-center justify-center overflow-y-auto custom-scrollbar'
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
                  message={message}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {teams.length > 0 ? (
                      <div className="space-y-1">
                        {teams.map((team) => (
                          <div key={team.id}>
                            <div className={`flex ${isMobile ? 'items-start' : 'items-center'} justify-between py-0.5 min-w-0`}>
                              <div className={`flex ${isMobile ? 'items-start' : 'items-center'} space-x-2 min-w-0 flex-1`}>
                                <AiOutlineTeam className={`w-4 h-4 flex-shrink-0 ${isMobile ? 'mt-1' : ''}`} />
                                <div className="flex flex-col justify-center min-w-0 flex-1">
                                  <div className="flex items-center space-x-1 min-w-0">
                                    <h3
                                      className="text-base font-medium text-text-primary mb-0 truncate"
                                      title={team.name.length > 20 ? team.name : undefined}
                                      style={{
                                        maxWidth: isMobile ? '180px' : 'none'
                                      }}
                                    >
                                      {team.name.length > 20 ? `${team.name.substring(0, 20)}...` : team.name}
                                    </h3>
                                    <div className="flex items-center h-4 space-x-0.5 flex-shrink-0">
                                      <div
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: team.is_active ? 'rgb(var(--color-success))' : 'rgb(var(--color-border))' }}
                                      ></div>
                                      <span className="text-xs text-text-muted flex items-center justify-center">{team.is_active ? t('teams.active') : t('teams.inactive')}</span>
                                      {getTeamStatusLabel(team) && (
                                        <>
                                          <span className="text-xs text-text-muted mx-1">•</span>
                                          {getTeamStatusLabel(team)}
                                        </>
                                      )}
                                    </div>
                                  </div>
                                  <div className={`flex ${isMobile ? 'flex-col space-y-1' : 'items-center'} space-x-1 mt-0 min-w-0`}>
                                    {team.workflow?.mode && (
                                      <span
                                        className="inline-block w-fit px-2 py-0.5 text-xs rounded-full capitalize"
                                        style={workflowTagStyle}
                                      >
                                        {t(`team_model.${team.workflow.mode}`)}
                                      </span>
                                    )}
                                    {!isMobile && <span className="mx-2 hidden sm:inline"></span>}
                                    {team.bots.length > 0 ? (
                                      <div className="flex items-center min-w-0 flex-1">
                                        {isMobile ? (
                                          <div className="flex flex-wrap items-center gap-1">
                                            {team.bots.slice(0, 1).map((bot, idx) => (
                                              <span
                                                key={`${bot.bot_id}-${idx}`}
                                                className="flex items-center shrink min-w-0 bg-muted px-2 py-1 rounded"
                                              >
                                                <RiRobot2Line className="w-3 h-3 mr-1 text-text-muted" />
                                                <span className="text-xs text-text-muted min-w-0 overflow-hidden text-ellipsis whitespace-nowrap max-w-[60px] sm:max-w-[100px] lg:max-w-[140px]">
                                                  {bots.find(b => b.id === bot.bot_id)?.name || bot.bot_id}
                                                </span>
                                              </span>
                                            ))}
                                            {team.bots.length > 1 && (
                                              <span className="text-xs text-text-muted bg-muted px-2 py-1 rounded">
                                                +{team.bots.length - 1}
                                              </span>
                                            )}
                                          </div>
                                        ) : (
                                          <div className="flex items-center overflow-hidden whitespace-nowrap text-ellipsis">
                                            {team.bots.slice(0, 3).map((bot, idx) => (
                                              <span key={`${bot.bot_id}-${idx}`} className="flex items-center shrink min-w-0">
                                                <RiRobot2Line className="w-4 h-4 mr-0.5 text-text-muted" />
                                                <span className="text-xs text-text-muted mr-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap max-w-[80px] sm:max-w-[120px] lg:max-w-[160px]">
                                                  {bots.find(b => b.id === bot.bot_id)?.name || bot.bot_id}
                                                </span>
                                                {idx < team.bots.slice(0, 3).length - 1 && <span className="text-text-muted mx-1"> </span>}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-xs text-text-muted">{t('teams.no_bots')}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div className={`${isMobile ? 'flex-col items-end space-y-1' : 'flex items-center'} space-x-1 flex-shrink-0 ${isMobile ? 'ml-2' : ''}`}>
                                {isMobile ? (
                                  <div className="grid grid-cols-2 gap-1 w-full">
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<ChatBubbleLeftEllipsisIcon className="w-3 h-3" />}
                                      onClick={() => handleChatTeam(team)}
                                      title={t('teams.chat')}
                                      style={{ padding: '1px' }}
                                      className="!text-text-muted hover:!text-text-primary"
                                    />
                                    {shouldShowEditDelete(team) && (
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<PencilIcon className="w-3 h-3 text-text-muted" />}
                                        onClick={() => handleEditTeam(team)}
                                        title={t('teams.edit')}
                                        style={{ padding: '1px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                      />
                                    )}
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<DocumentDuplicateIcon className="w-3 h-3 text-text-muted" />}
                                      onClick={() => handleCopyTeam(team)}
                                      title={t('teams.copy')}
                                      style={{ padding: '1px' }}
                                      className="!text-text-muted hover:!text-text-primary"
                                    />
                                    {shouldShowShare(team) && (
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<ShareIcon className="w-3 h-3 text-text-muted" />}
                                        onClick={() => handleShareTeam(team)}
                                        title={t('teams.share')}
                                        style={{ padding: '1px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                        loading={sharingId === team.id}
                                      />
                                    )}
                                    <Dropdown
                                      menu={{
                                        items: [
                                          {
                                            key: 'delete',
                                            label: t('teams.delete'),
                                            icon: <TrashIcon className="w-4 h-4" />,
                                            onClick: () => handleDelete(team.id),
                                            danger: true
                                          }
                                        ]
                                      }}
                                      trigger={['click']}
                                      placement="bottomRight"
                                    >
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<EllipsisVerticalIcon className="w-3 h-3 text-text-muted" />}
                                        title={t('teams.more')}
                                        style={{ padding: '1px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                      />
                                    </Dropdown>
                                  </div>
                                ) : (
                                  <>
                                    {/* Desktop: All buttons in one row */}
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<ChatBubbleLeftEllipsisIcon className="w-4 h-4" />}
                                      onClick={() => handleChatTeam(team)}
                                      title={t('teams.chat')}
                                      style={{ padding: '2px' }}
                                      className="!text-text-muted hover:!text-text-primary"
                                    />
                                    {shouldShowEditDelete(team) && (
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<PencilIcon className="w-4 h-4 text-text-muted" />}
                                        onClick={() => handleEditTeam(team)}
                                        title={t('teams.edit')}
                                        style={{ padding: '2px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                      />
                                    )}
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<DocumentDuplicateIcon className="w-4 h-4 text-text-muted" />}
                                      onClick={() => handleCopyTeam(team)}
                                      title={t('teams.copy')}
                                      style={{ padding: '2px' }}
                                      className="!text-text-muted hover:!text-text-primary"
                                    />
                                    {shouldShowShare(team) && (
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<ShareIcon className="w-4 h-4 text-text-muted" />}
                                        onClick={() => handleShareTeam(team)}
                                        title={t('teams.share')}
                                        style={{ padding: '2px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                        loading={sharingId === team.id}
                                      />
                                    )}
                                    <Dropdown
                                      menu={{
                                        items: [
                                          {
                                            key: 'delete',
                                            label: t('teams.delete'),
                                            icon: <TrashIcon className="w-4 h-4" />,
                                            onClick: () => handleDelete(team.id),
                                            danger: true
                                          }
                                        ]
                                      }}
                                      trigger={['click']}
                                      placement="bottomRight"
                                    >
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<EllipsisVerticalIcon className="w-4 h-4 text-text-muted" />}
                                        title={t('teams.more')}
                                        style={{ padding: '2px' }}
                                        className="!text-text-muted hover:!text-text-primary"
                                      />
                                    </Dropdown>
                                  </>
                                )}
                              </div>
                            </div>
                            {teams.length > 1 && team.id !== teams[teams.length - 1].id && (
                              <div className="border-t border-border mt-1 pt-1"></div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center text-text-muted py-4">
                        <p className="text-sm">{t('teams.no_teams')}</p>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border pt-2 bg-surface">
                    <div className="flex justify-center">
                      <Button
                        onClick={handleCreateTeam}
                        type="primary"
                        size="small"
                        icon={
                          <svg className="h-4 w-4 align-middle" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                          </svg>
                        }
                        style={{ margin: '8px 0' }}
                        className="!text-base"
                      >
                        {t('teams.new_team')}
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
      <Modal
        title={t('teams.delete_confirm_title')}
        open={deleteConfirmVisible}
        onOk={handleConfirmDelete}
        onCancel={handleCancelDelete}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
        centered
      >
        <p>{t('teams.delete_confirm_message')}</p>
      </Modal>

      {/* Share success dialog */}
      {shareData && (
        <TeamShareModal
          visible={shareModalVisible}
          onClose={handleCloseShareModal}
          teamName={shareData.teamName}
          shareUrl={shareData.shareUrl}
        />
      )}
      {/* Error prompt unified with antd message, no local rendering */}
    </>
  )
}
