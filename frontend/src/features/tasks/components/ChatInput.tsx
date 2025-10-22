// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { ArrowTurnDownLeftIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'

interface ChatInputProps {
  message: string
  setMessage: (message: string) => void
  handleSendMessage: () => void
  isLoading: boolean
  disabled?: boolean
}

export default function ChatInput({
  message,
  setMessage,
  handleSendMessage,
  isLoading,
  disabled = false,
}: ChatInputProps) {
  const { t } = useTranslation('common')
  const [isComposing, setIsComposing] = useState(false)

  const handleCompositionStart = () => {
    setIsComposing(true)
  }

  const handleCompositionEnd = () => {
    setIsComposing(false)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !disabled && !isComposing) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="w-full">
      <TextareaAutosize
        value={message}
        onChange={(e) => {
          if (!disabled) setMessage(e.target.value)
        }}
        onKeyDown={handleKeyPress}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={t('chat.placeholder')}
        className={`w-full p-3 bg-transparent custom-scrollbar text-text-primary text-base placeholder:text-text-muted placeholder:text-base focus:outline-none data-[focus]:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={disabled}
        minRows={3}
        maxRows={8}
        style={{ resize: 'none', overflow: 'auto' }}
      />
    </div>
  )
}
