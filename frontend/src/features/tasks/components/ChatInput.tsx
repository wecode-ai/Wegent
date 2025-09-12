// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import TextareaAutosize from 'react-textarea-autosize'
import { ArrowTurnDownLeftIcon } from '@heroicons/react/24/outline'

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
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !disabled) {
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
        placeholder="Ask Team to build, fix bugs, explore"
        className={`w-full p-3 bg-transparent custom-scrollbar text-white placeholder-gray-400 placeholder:text-base focus:outline-none data-[focus]:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={disabled}
        minRows={3}
        maxRows={8}
        style={{ resize: 'none', overflow: 'auto' }}
      />
    </div>
  )
}