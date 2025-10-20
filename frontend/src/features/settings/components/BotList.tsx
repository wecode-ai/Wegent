// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Dropdown, Modal, Tag, theme } from 'antd'
import { PencilIcon, TrashIcon, PlusIcon, DocumentDuplicateIcon, ChatBubbleLeftEllipsisIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import LoadingState from '@/features/common/LoadingState'
import { Bot } from '@/types/api'
import { fetchBotsList, deleteBot, isPredefinedModel, getModelFromConfig } from '../services/bots'
import BotEdit from './BotEdit'
import { useTranslation } from '@/hooks/useTranslation'
import { sortBotsByUpdatedAt } from '@/utils/bot'
import { getSubtleBadgeStyle } from '@/utils/styles'

export default function BotList() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // Unified error prompt using antd message.error, no local error state needed
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [cloningBot, setCloningBot] = useState<Bot | null>(null)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [botToDelete, setBotToDelete] = useState<number | null>(null)
  const isEditing = editingBotId !== null
  const subtleBadgeStyle = useMemo(() => getSubtleBadgeStyle(token), [token])

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
    setEditingBotId(0) // Use 0 to mark new creation
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


  const handleDeleteBot = (botId: number) => {
    setBotToDelete(botId)
    setDeleteConfirmVisible(true)
  }

  const handleConfirmDelete = async () => {
    if (!botToDelete) return

    try {
      await deleteBot(botToDelete)
      setBotsSorted(prev => prev.filter(b => b.id !== botToDelete))
      setDeleteConfirmVisible(false)
      setBotToDelete(null)
    } catch (e) {
      const errorMessage = e instanceof Error && e.message
        ? e.message
        : t('bots.delete')
      message.error(errorMessage)
    }
  }

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false)
    setBotToDelete(null)
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('bots.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('bots.description')}</p>
        </div>
        <div
          className={`bg-surface border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'md:min-h-[70vh] flex items-center justify-center overflow-y-auto custom-scrollbar'
              : 'max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
          }`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('bots.loading')} />
          ) : (
            <>
              {/* Edit/New mode */}
              {isEditing ? (
                <BotEdit
                  bots={bots}
                  setBots={setBotsSorted}
                  editingBotId={editingBotId}
                  cloningBot={cloningBot}
                  onClose={handleCloseEditor}
                  message={message}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
                    {bots.length > 0 ? (
                      bots.map((bot) => (
                        <div key={bot.id}>
                          <div className="flex items-center justify-between py-0.5 min-w-0">
                            <div className="flex items-center space-x-2 min-w-0 flex-1">
                              <RiRobot2Line className="w-4 h-4 text-text-primary flex-shrink-0" />
                              <div className="flex flex-col justify-center min-w-0 flex-1">
                                <div className="flex items-center space-x-1 min-w-0">
                                  <h3 className="text-base font-medium text-text-primary mb-0 truncate">{bot.name}</h3>
                                  <div className="flex items-center h-4 space-x-0.5 flex-shrink-0">
                                    <div
                                      className="w-2 h-2 rounded-full"
                                      style={{ backgroundColor: bot.is_active ? 'rgb(var(--color-success))' : 'rgb(var(--color-border))' }}
                                    ></div>
                                    <span className="text-xs text-text-muted flex items-center justify-center">{bot.is_active ? t('bots.active') : t('bots.inactive')}</span>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-1 mt-1 min-w-0">
                                  <Tag
                                    className="!m-0 !px-1.5 !py-0 text-xs leading-4 capitalize self-start"
                                    style={subtleBadgeStyle}
                                  >
                                    {bot.agent_name}
                                  </Tag>
                                  <Tag
                                    className="hidden sm:inline-block !m-0 !px-1.5 !py-0 text-xs leading-4 capitalize self-start"
                                    style={subtleBadgeStyle}
                                  >
                                    {isPredefinedModel(bot.agent_config)
                                      ? getModelFromConfig(bot.agent_config)
                                      : 'CustomModel'}
                                  </Tag>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center space-x-1 flex-shrink-0 ml-2">
                              <Button
                                type="text"
                                size="small"
                                icon={<PencilIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleEditBot(bot)}
                                title={t('bots.edit')}
                                style={{ padding: '2px' }}
                                className="!text-text-muted hover:!text-text-primary"
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<DocumentDuplicateIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleCloneBot(bot)}
                                title={t('bots.copy')}
                                style={{ padding: '2px' }}
                                className="!text-text-muted hover:!text-text-primary"
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<TrashIcon className="w-4 h-4 text-text-muted" />}
                                onClick={() => handleDeleteBot(bot?.id)}
                                title={t('bots.delete')}
                                style={{ padding: '2px' }}
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
                  </div>
                  <div className="border-t border-border pt-2 bg-surface">
                    <div className="flex justify-center">
                      <Button
                        onClick={handleCreateBot}
                        type="primary"
                        size="small"
                        style={{ margin: '8px 0' }}
                        className="flex items-center justify-center gap-1 text-base"
                      >
                        <PlusIcon className="h-4 w-4" aria-hidden="true" />
                        <span>{t('bots.new_bot')}</span>
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
        title={t('bots.delete_confirm_title')}
        open={deleteConfirmVisible}
        onOk={handleConfirmDelete}
        onCancel={handleCancelDelete}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
        centered
      >
        <p>{t('bots.delete_confirm_message')}</p>
      </Modal>
    </>
  )
}
