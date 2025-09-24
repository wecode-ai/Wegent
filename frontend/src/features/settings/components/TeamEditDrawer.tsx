// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Drawer, Divider, Button, Input, Typography } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'

import { Bot, Team, TeamBot } from '@/types/api'
import BotEdit from './BotEdit'
import { updateTeam } from '../services/teams'

import { useTranslation } from 'react-i18next'

interface TeamEditDrawerProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>> // 添加 setBots 属性
  editingBotId: number | null
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  visible: boolean
  setVisible: React.Dispatch<React.SetStateAction<boolean>>
  message: MessageInstance
  team: Team | null
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>
}

export default function TeamEditDrawer(props: TeamEditDrawerProps) {
  const {
    bots,
    setBots,
    editingBotId,
    setEditingBotId,
    visible,
    setVisible,
    message,
    team,
    setTeams,
  } = props

  const { t } = useTranslation('common')
  // 添加 botPrompt 状态来存储 TextArea 中的值
  const [botPrompt, setBotPrompt] = useState('')

  // 当 editingBotId 变化时，初始化 botPrompt
  useEffect(() => {
    if (editingBotId !== null && team) {
      // 查找当前编辑的 bot 在 team 中的 bot_prompt
      const teamBot = team.bots.find((b: TeamBot) => b.bot_id === editingBotId)
      setBotPrompt(teamBot?.bot_prompt || '')
    }
  }, [editingBotId, team])

  const handleClose = () => {
    setVisible(false)
    setEditingBotId(null)
  }

  // 保存 bot prompt 的函数
  const handleSavePrompt = async () => {
    if (editingBotId === null || !team) return

    try {
      // 准备更新的 bots 数据，保留原有的 bot 数据，只更新当前编辑的 bot 的 prompt
      const updatedBots = team.bots.map((b: TeamBot) => {
        if (b.bot_id === editingBotId) {
          // 更新当前编辑的 bot
          return {
            bot_id: b.bot_id,
            bot_prompt: botPrompt,
            // 如果是 leader，保持 'leader'，否则设为 'member'
            role: b.role || undefined
          }
        }
        // 对于其他 bot，确保 role 不为 null
        return {
          ...b,
          role: b.role ||  undefined
        }
      })

      // 调用 API 更新后端数据，只传递需要更新的字段
      const updated = await updateTeam(team.id, {
        bots: updatedBots
      })

      // 使用 API 返回的结果更新前端状态
      setTeams(prevTeams =>
        prevTeams.map(t => t.id === updated.id ? updated : t)
      )

      message.success('Bot Prompt saved!')
    } catch (error: any) {
      message.error(error?.message || 'Failed to save Bot Prompt')
      console.error('Failed to save Bot Prompt:', error)
    }
  }

  return (
    <Drawer
      title="Bot Edit"
      placement="right"
      width={800}
      onClose={handleClose}
      open={visible}
      destroyOnHidden={true}
      afterOpenChange={(open) => {
        if (!open) {
          // 在抽屉关闭后执行清理操作
          setEditingBotId(null);
        }
      }}
      styles={{
        header: {
          display: "none",
          backgroundColor: 'rgb(var(--color-bg-surface))',
          color: 'rgb(var(--color-text-primary))',
          borderBottom: '1px solid rgb(var(--color-border))'
        },
        body: { backgroundColor: 'rgb(var(--color-bg-base))', padding: 0 },
      }}
    >
      {editingBotId !== null && (
        <>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <BotEdit
              bots={bots}
              setBots={setBots}
              editingBotId={editingBotId}
              setEditingBotId={(id) => {
                setEditingBotId(id);
                if (id === null) {
                  setVisible(false);
                }
              }}
              message={message}
            />
          </div>
          
          <Divider style={{ margin: '24px 0', borderColor: 'rgb(var(--color-border))' }} />
          
          <div style={{ padding: '0 24px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px'
            }}>
              <Typography.Title level={4} style={{ color: 'rgb(var(--color-text-primary))', margin: 0 }}>
                  {t("team.bot_prompt")}
              </Typography.Title>
              <Button
                type="primary"
                size="small"
                onClick={handleSavePrompt}
              >
                {t('bot.save_prompt')}
              </Button>
            </div>
            <Input.TextArea
              rows={6}
              placeholder={t('team.input_bot_prompt')}
              value={botPrompt}
              onChange={(e) => setBotPrompt(e.target.value)}
              style={{
                backgroundColor: 'rgb(var(--color-bg-surface))',
                color: 'rgb(var(--color-text-primary))',
                borderColor: 'rgb(var(--color-border))',
                fontSize: '16px'
              }}
            />
          </div>
        </>
      )}
    </Drawer>
  )
}
