// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Drawer, Form, Input, Button } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'
import { teamApis } from '@/apis/team'
import { useTranslation } from 'react-i18next'

import { Bot, Team, TeamBot } from '@/types/api'
import BotEdit from './BotEdit'

interface TeamEditDrawerProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  editingBotId: number | null
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  visible: boolean
  setVisible: React.Dispatch<React.SetStateAction<boolean>>
  message: MessageInstance
  mode: 'edit' | 'prompt'
  editingTeam: Team | null
  onTeamUpdate: (updatedTeam: Team) => void
  cloningBot: Bot | null
  setCloningBot: React.Dispatch<React.SetStateAction<Bot | null>>
}

function PromptEdit({
  team,
  allBots,
  onClose,
  message,
  onTeamUpdate,
  setBots,
}: {
  team: Team,
  allBots: Bot[],
  onClose: () => void,
  message: MessageInstance,
  onTeamUpdate: (updatedTeam: Team) => void,
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
}) {
  const { t } = useTranslation('common')
  const [form] = Form.useForm()
  const [loading, setLoading] = React.useState(false)

  const handleBack = React.useCallback(() => {
    onClose()
  }, [onClose])

  const teamBotsWithDetails = React.useMemo(() => {
    if (!team) return []
    return team.bots
      .map(teamBot => {
        const botDetails = allBots.find(b => b.id === teamBot.bot_id)
        return {
          ...teamBot,
          name: botDetails?.name || `Bot ID: ${teamBot.bot_id}`,
          isLeader: teamBot.role === 'leader',
        }
      })
      .sort((a, b) => {
        if (a.isLeader && !b.isLeader) return -1
        if (!a.isLeader && b.isLeader) return 1
        return 0
      })
  }, [team, allBots])

  React.useEffect(() => {
    const initialValues: Record<string, string> = {}
    if (teamBotsWithDetails) {
      teamBotsWithDetails.forEach(bot => {
        initialValues[`prompt-${bot.bot_id}`] = bot.bot_prompt
      })
      form.setFieldsValue(initialValues)
    }
  }, [teamBotsWithDetails, form])

  React.useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return

      const activeElement = document.activeElement as HTMLElement | null
      if (activeElement && (
        activeElement.getAttribute('role') === 'combobox' ||
        activeElement.closest('.ant-select-dropdown')
      )) {
        return
      }

      handleBack()
    }

    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [handleBack])

  const handleSave = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      const updatedBots: TeamBot[] = team.bots.map(teamBot => ({
        ...teamBot,
        bot_prompt: values[`prompt-${teamBot.bot_id}`] || '',
      }))

      const response = await teamApis.updateTeam(team.id, {
        name: team.name,
        workflow: team.workflow,
        bots: updatedBots,
      })

      // 更新team状态
      onTeamUpdate({ ...team, bots: updatedBots })
      
      // 更新全局bots状态
      // 注意：这里我们不需要更新全局bots，因为bot_prompt是team特有的属性
      // 但如果将来需要同步其他bot属性，可以在这里添加

      message.success('Prompts updated successfully!')
      onClose()
    } catch (error) {
      message.error('Failed to update prompts.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>
        <Button type="primary" onClick={handleSave} loading={loading}>
          {t('actions.save')}
        </Button>
      </div>

      <h2 className="text-lg font-semibold mb-4">Team '{team.name}'</h2>
      <Form form={form} layout="vertical" className="flex-grow overflow-y-auto custom-scrollbar pr-4">
        {teamBotsWithDetails.map(bot => (
          <Form.Item
            key={bot.bot_id}
            label={
              <span className="font-medium">
                {bot.name}
                {bot.isLeader && <span className="text-gray-400 ml-2 font-semibold">(Leader)</span>}
              </span>
            }
            name={`prompt-${bot.bot_id}`}
          >
            <Input.TextArea rows={4} placeholder={`Enter Team prompt for every bot work better`} />
          </Form.Item>
        ))}
      </Form>
    </div>
  )
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
    mode,
    editingTeam,
    onTeamUpdate,
    cloningBot,
    setCloningBot,
  } = props

  const handleClose = () => {
    setVisible(false)
    setEditingBotId(null)
    setCloningBot(null)
  }

  return (
    <Drawer
      placement="right"
      width={860}
      onClose={handleClose}
      open={visible}
      destroyOnClose={true}
      styles={{
        header: {
          display: "none",
        },
        body: { backgroundColor: 'rgb(var(--color-bg-base))', padding: 0 },
      }}
    >
      <div style={{ height: '100%', overflowY: 'auto' }}>
        {mode === 'edit' && editingBotId !== null && (
          <BotEdit
            bots={bots}
            setBots={setBots}
            editingBotId={editingBotId}
            cloningBot={cloningBot}
            onClose={() => {
              setEditingBotId(null)
              setCloningBot(null)
              setVisible(false)
            }}
            message={message}
          />
        )}
        {mode === 'prompt' && editingTeam && (
          <PromptEdit
            team={editingTeam}
            allBots={bots}
            onClose={handleClose}
            message={message}
            onTeamUpdate={onTeamUpdate}
            setBots={setBots}
          />
        )}
      </div>
    </Drawer>
  )
}
