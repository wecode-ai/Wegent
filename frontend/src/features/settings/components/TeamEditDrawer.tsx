// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Drawer } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'

import { Bot } from '@/types/api'
import BotEdit from './BotEdit'

interface TeamEditDrawerProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>> // 添加 setBots 属性
  editingBotId: number | null
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  visible: boolean
  setVisible: React.Dispatch<React.SetStateAction<boolean>>
  message: MessageInstance
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
  } = props

  const handleClose = () => {
    setVisible(false)
    setEditingBotId(null)
  }
  return (
    <Drawer
      title="Bot Edit"
      placement="right"
      width={860}
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
        <div style={{ height: '100%', overflowY: 'auto' }}>
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
      )}
    </Drawer>
  )
}
