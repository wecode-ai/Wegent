// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import { useEffect, useState } from 'react'
import { Button } from 'antd'
import { PencilIcon, TrashIcon, PlusIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import LoadingState from '@/features/common/LoadingState'
import { Bot } from '@/types/api'
import { fetchBotsList, createBot, updateBot, deleteBot } from '../services/bots'
import { App } from 'antd'
import BotEdit from './BotEdit'
import { useTranslation } from '@/hooks/useTranslation'

export default function BotList() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [editingBotId, setEditingBotId] = useState<number | null>(null)


  useEffect(() => {
    async function loadBots() {
      setIsLoading(true)
      try {
        const botsData = await fetchBotsList()
        setBots(botsData)
      } catch (e) {
        message.error(t('bots.loading'))
      } finally {
        setIsLoading(false)
      }
    }
    loadBots()
  }, [])

  const handleCreateBot = () => {
    setEditingBotId(0) // 用 0 标记新建
  }

  const handleEditBot = (bot: Bot) => {
    setEditingBotId(bot.id)
  }


  const handleDeleteBot = async (botId: number) => {
    try {
      await deleteBot(botId)
      setBots(prev => prev.filter(b => b.id !== botId))
    } catch (e) {
      message.error(t('bots.delete'))
    }
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-white mb-1">{t('bots.title')}</h2>
          <p className="text-sm text-gray-400 mb-1">{t('bots.description')}</p>
        </div>
        <div className={`bg-[#161b22] border border-[#30363d] rounded-md p-2 space-y-1 overflow-y-auto custom-scrollbar ${editingBotId !== null ? 'md:min-h-[65vh] flex items-center justify-center' : ''}`}>
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('bots.loading')} />
          ) : (
            <>
              {/* 编辑/新建模式 */}
              {editingBotId !== null ? (
                <BotEdit
                  bots={bots}
                  setBots={setBots}
                  editingBotId={editingBotId}
                  setEditingBotId={setEditingBotId}
                  message={message}
                />
              ) : (
                <>
                  {bots.length > 0 ? (
                    bots.map((bot) => (
                      <div key={bot.id}>
                        <div className="flex items-center justify-between py-0.5">
                          <div className="flex items-center space-x-2">
                            <RiRobot2Line className="w-4 h-4 text-white" />
                            <div className="flex flex-col justify-center">
                              <div className="flex items-center space-x-1">
                                <h3 className="text-base font-medium text-white mb-0">{bot.name}</h3>
                                <div className="flex items-center h-4 space-x-0.5">
                                  <div className={`w-2 h-2 rounded-full ${bot.is_active ? 'bg-green-400' : 'bg-gray-400'}`}></div>
                                  <span className="text-xs text-gray-400 flex items-center justify-center">{bot.is_active ? t('bots.active') : t('bots.inactive')}</span>
                                </div>
                              </div>
                              <span className="inline-block px-1 py-0.5 text-xs rounded-full bg-gray-700 text-gray-300 capitalize self-start">{bot.agent_name}</span>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <Button
                              type="text"
                              size="small"
                              icon={<PencilIcon className="w-4 h-4 text-gray-400" />}
                              onClick={() => handleEditBot(bot)}
                              title={t('bots.edit')}
                              style={{ padding: '4px' }}
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={<TrashIcon className="w-4 h-4 text-gray-400" />}
                              onClick={() => handleDeleteBot(bot.id)}
                              title={t('bots.delete')}
                              style={{ padding: '4px' }}
                            />
                          </div>
                        </div>
                        {bots.length > 1 && bot.id !== bots[bots.length - 1].id && (
                          <div className="border-t border-[#30363d] mt-1 pt-1"></div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-gray-500 py-4">
                      <p className="text-sm">{t('bots.no_bots')}</p>
                    </div>
                  )}
                  <div className="border-t border-[#30363d]"></div>
                  <div className="flex justify-center ">
                    <Button
                      onClick={handleCreateBot}
                      type="primary"
                      size="small"
                      icon={<PlusIcon className="w-3 h-3" />}
                      style={{ margin: '8px 0' }}
                    >
                      {t('bots.new_bot')}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}