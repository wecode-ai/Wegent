// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { RiRobot2Line } from 'react-icons/ri'
import { FiArrowRight } from 'react-icons/fi'
import { AiOutlineTeam } from 'react-icons/ai'
import LoadingState from '@/features/common/LoadingState'
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import { fetchTeamsList, deleteTeam } from '../services/teams'
import { fetchBotsList } from '../services/bots'
import TeamEdit from './TeamEdit'
import { App } from 'antd'
import { Button } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'

export default function TeamList() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null)

  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const [teamsData, botsData] = await Promise.all([fetchTeamsList(), fetchBotsList()])
        setTeams(teamsData)
        setBots(botsData)
      } catch (e) {
        message.error(t('teams.loading'))
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [])

  const handleCreateTeam = () => {
    setEditingTeamId(0) // 用 0 标记新建
  }

  const handleEditTeam = (team: Team) => {
    setEditingTeamId(team.id)
  }

  const handleDelete = async (teamId: number) => {
    setDeletingId(teamId)
    try {
      await deleteTeam(teamId)
      setTeams(prev => prev.filter(team => team.id !== teamId))
    } catch (e) {
      message.error(t('teams.delete'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('teams.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('teams.description')}</p>
        </div>
        <div className={`bg-surface border border-border rounded-md p-2 space-y-1 overflow-y-auto custom-scrollbar ${editingTeamId !== null ? 'md:min-h-[65vh] flex items-center justify-center' : 'max-w-5xl max-h-[70vh]'}`}>
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('teams.loading')} />
          ) : (
            <>
              {/* 编辑/新建模式 */}
              {editingTeamId !== null ? (
                <TeamEdit
                  teams={teams}
                  setTeams={setTeams}
                  editingTeamId={editingTeamId}
                  setEditingTeamId={setEditingTeamId}
                  bots={bots}
                  setBots={setBots}
                  message={message}
                />
              ) : (
                <>
                  {teams.length > 0 ? (
                    teams.map((team) => (
                      <div key={team.id}>
                        <div className="flex items-center justify-between py-0.5">
                          <div className="flex items-center space-x-2 flex-1 overflow-hidden">
                            <AiOutlineTeam className="w-4 h-4 flex-shrink-0" />
                            <div className="flex flex-col justify-center flex-1 overflow-hidden">
                              <div className="flex items-center space-x-1">
                                <h3 className="text-base font-medium text-text-primary mb-0">{team.name}</h3>
                                <div className="flex items-center h-4 space-x-0.5">
                                  <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: team.is_active ? 'rgb(var(--color-success))' : 'rgb(var(--color-border))' }}
                                  ></div>
                                  <span className="text-xs text-text-muted flex items-center justify-center">{team.is_active ? t('teams.active') : t('teams.inactive')}</span>
                                </div>
                              </div>
                              <div className="flex items-center space-x-1 mt-0">
                                {team.workflow?.mode && (
                                  <>
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-muted text-text-secondary capitalize">
                                      {team.workflow.mode}
                                    </span>
                                    <span className="mx-2"></span>
                                  </>
                                )}
                                {team.bots.length > 0 ? (
                                  <div className="flex items-center max-w-[80%] overflow-hidden whitespace-nowrap text-ellipsis ml-4">
                                    {team.bots.map((bot, idx) => (
                                      <span key={`${bot.bot_id}-${idx}`} className="flex items-center">
                                        <RiRobot2Line className="w-4 h-4 mr-0.5 text-text-muted" />
                                        <span className="text-xs text-text-muted mr-0.5">
                                          {bots.find(b => b.id === bot.bot_id)?.name || bot.bot_id}
                                        </span>
                                        {team.workflow?.mode === 'pipeline'
                                          ? (idx < team.bots.length - 1 && (
                                              <FiArrowRight className="w-4 h-4 text-text-muted mx-2" />
                                            ))
                                          : (idx < team.bots.length - 1 && (
                                              <span className="text-text-muted mx-1"> </span>
                                            ))
                                        }
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-text-muted">{t('teams.no_bots')}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <Button
                              type="text"
                              size="small"
                              icon={<PencilIcon className="w-4 h-4 text-text-muted" />}
                              onClick={() => handleEditTeam(team)}
                              title={t('teams.edit')}
                              style={{ padding: '4px' }}
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={<TrashIcon className="w-4 h-4 text-text-muted" />}
                              onClick={() => handleDelete(team.id)}
                              disabled={deletingId === team.id}
                              title={t('teams.delete')}
                              style={{ padding: '4px' }}
                            />
                          </div>
                        </div>
                        {teams.length > 1 && team.id !== teams[teams.length - 1].id && (
                          <div className="border-t border-border mt-1 pt-1"></div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-text-muted py-4">
                      <p className="text-sm">{t('teams.no_teams')}</p>
                    </div>
                  )}
                  <div className="border-t border-border"></div>
                  <div className="flex justify-center">
                    <Button
                      onClick={handleCreateTeam}
                      type="primary"
                      size="small"
                      icon={
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      }
                      style={{ margin: '8px 0' }}
                    >
                      {t('teams.new_team')}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {/* 错误提示已用 antd message 统一，不再本地渲染 */}
    </>
  )
}
