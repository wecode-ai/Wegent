// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import { useCallback, useEffect, useState } from 'react'
import { Button } from 'antd'
import { PencilIcon, TrashIcon, PlusIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import LoadingState from '@/features/common/LoadingState'
import { Bot } from '@/types/api'
import { fetchBotsList, deleteBot, isPredefinedModel, getModelFromConfig } from '../services/bots'
import { App } from 'antd'
import BotEdit from './BotEdit'
import { useTranslation } from '@/hooks/useTranslation'
import { sortBotsByUpdatedAt } from '@/utils/bot'

export default function BotList() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [cloningBot, setCloningBot] = useState<Bot | null>(null)

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>((updater) => {
    setBots(prev => {
      const next = typeof updater === 'function'
        ? (updater as (value: Bot[]) => Bot[])(prev)
        : updater
      return sortBotsByUpdatedAt(next)
    })
  }, [setBots])


  useEffect(() => {
    async function loadBots() {
      setIsLoading(true)
      try {
        const botsData = await fetchBotsList()
        setBotsSorted(botsData)
      } catch (e) {
        message.error(t('bots.loading'))
      } finally {
        setIsLoading(false)
      }
    }
    loadBots()
  }, [])

  const handleCreateBot = () => {
    setCloningBot(null)
    setEditingBotId(0) // 用 0 标记新建
  }

  const handleEditBot = (bot: Bot) => {
    setCloningBot(null)
    setEditingBotId(bot.id)
  }

  const handleCloneBot = (bot: Bot) => {
    setCloningBot(bot)
    setEditingBotId(0)
  }

  const handleCloseEditor = () => {
    setEditingBotId(null)
    setCloningBot(null)
  }


  const handleDeleteBot = async (botId: number) => {
    try {
      await deleteBot(botId)
      setBotsSorted(prev => prev.filter(b => b.id !== botId))
    } catch (e) {
      message.error(t('bots.delete'))
    }
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('bots.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('bots.description')}</p>
        </div>
        <div
          className={`bg-surface border border-border rounded-md p-2 ${editingBotId !== null
            ? 'md:min-h-[70vh] flex items-center justify-center overflow-y-auto custom-scrollbar'
            : ''}`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('bots.loading')} />
          ) : (
            <>
              {/* 编辑/新建模式 */}
              {editingBotId !== null ? (
                <BotEdit
                  bots={bots}
                  setBots={setBotsSorted}
                  editingBotId={editingBotId}
                  cloningBot={cloningBot}
                  onClose={handleCloseEditor}
                  message={message}
                />
              ) : (
                <div className="relative">
                  <div className="max-h-[70vh] overflow-y-auto custom-scrollbar pr-1">
                    {bots.length > 0 ? (
                      bots.map((bot) => (
                        <div key={bot.id}>
                          <div className="flex items-center justify-between py-0.5">
                            <div className="flex items-center space-x-2">
                              <RiRobot2Line className="w-4 h-4 text-text-primary" />
                              <div className="flex flex-col justify-center">
                                <div className="flex items-center space-x-1">
                                  <h3 className="text-base font-medium text-text-primary mb-0">{bot.name}</h3>
                                  <div className="flex items-center h-4 space-x-0.5">
                                    <div
                                      className="w-2 h-2 rounded-full"
                                      style={{ backgroundColor: bot.is_active ? 'rgb(var(--color-success))' : 'rgb(var(--color-border))' }}
                                    ></div>
                                    <span className="text-xs text-text-muted flex items-center justify-center">{bot.is_active ? t('bots.active') : t('bots.inactive')}</span>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-1 mt-1">
                                  <span className="inline-block px-1 py-0.5 text-xs rounded-full bg-muted text-text-secondary capitalize self-start">{bot.agent_name}</span>
                                  <span className="inline-block px-1 py-0.5 text-xs rounded-full bg-muted text-text-secondary capitalize self-start">
                                    {isPredefinedModel(bot.agent_config)
                                      ? getModelFromConfig(bot.agent_config)
                                      : 'CustomModel'}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center space-x-2">
                              <Button
                                type="text"
                                size="small"
                                icon={<PencilIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleEditBot(bot)}
                                title={t('bots.edit')}
                                style={{ padding: '4px' }}
                                className="!text-text-muted hover:!text-text-primary"
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<DocumentDuplicateIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleCloneBot(bot)}
                                title={t('bots.copy')}
                                style={{ padding: '4px' }}
                                className="!text-text-muted hover:!text-text-primary"
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<TrashIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleDeleteBot(bot.id)}
                                title={t('bots.delete')}
                                style={{ padding: '4px' }}
                                className="!text-text-muted hover:!text-text-primary"
                              />
                            </div>
                          </div>
                          {bots.length > 1 && bot.id !== bots[bots.length - 1].id && (
                            <div className="border-t border-border mt-1 pt-1"></div>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-center text-text-muted py-4">
                        <p className="text-sm">{t('bots.no_bots')}</p>
                      </div>
                    )}
                    <div className="sticky bottom-0 -mx-2 mt-2 flex items-center justify-center bg-surface px-2 py-2 border-t border-border">
                      <Button
                        onClick={handleCreateBot}
                        type="primary"
                        size="small"
                        style={{ margin: '4px 0' }}
                        className="flex items-center justify-center gap-1 text-base"
                      >
                        <PlusIcon className="h-4 w-4" aria-hidden="true" />
                        <span className="relative top-[0.5px]">{t('bots.new_bot')}</span>
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
