// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Drawer, Divider, Button, Input, Typography } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'

import { Bot } from '@/types/api'
import BotEdit from './BotEdit'

import { useTranslation } from 'react-i18next'

interface TeamEditDrawerProps {
  bots: Bot[]
  editingBotId: number | null
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  visible: boolean
  setVisible: React.Dispatch<React.SetStateAction<boolean>>
  message: MessageInstance
}

export default function TeamEditDrawer(props: TeamEditDrawerProps) {
  const {
    bots,
    editingBotId,
    setEditingBotId,
    visible,
    setVisible,
    message,
  } = props

  const { t } = useTranslation('common')
  const handleClose = () => {
    setVisible(false)
    setEditingBotId(null)
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
        header: { display: "none", backgroundColor: '#161b22', color: 'white', borderBottom: '1px solid #30363d' },
        body: { backgroundColor: '#0d1117', padding: 0 },
      }}
    >
      {editingBotId !== null && (
        <>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <BotEdit
              bots={bots}
              setBots={() => {
                // Bot编辑完成后，不直接修改props，而是关闭抽屉
                // 用户可以通过刷新页面获取最新的bots数据
                message.success('Bot已更新，请刷新页面查看最新数据')
              }}
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
          
          <Divider style={{ margin: '24px 0', borderColor: '#30363d' }} />
          
          <div style={{ padding: '0 24px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px'
            }}>
              <Typography.Title level={4} style={{ color: 'white', margin: 0 }}>
                  {t("team.bot_prompt")}
              </Typography.Title>
              <Button
                type="primary"
                size="small"
                onClick={() => {
                  message.success('Bot Prompt saved!');
                }}
              >
                {t('bot.save_prompt')}
              </Button>
            </div>
            <Input.TextArea
              rows={6}
              placeholder={t('team.input_bot_prompt')}
              style={{
                backgroundColor: '#161b22',
                color: 'white',
                borderColor: '#30363d',
                fontSize: '16px' // 增大 placeholder 字体大小
              }}
            />
          </div>
        </>
      )}
    </Drawer>
  )
}