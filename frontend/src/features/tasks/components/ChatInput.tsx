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
    <div className="relative w-full">
      <TextareaAutosize
        value={message}
        onChange={(e) => {
          if (!disabled) setMessage(e.target.value)
        }}
        onKeyDown={handleKeyPress}
        placeholder="Ask BotTeam to build, fix bugs, explore"
        className={`w-full p-3 pb-10 pr-8 bg-[#161b22] border border-[#30363d] rounded-xl custom-scrollbar text-white placeholder-gray-400 focus:outline-none data-[focus]:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={disabled}
        minRows={3}
        maxRows={8}
        style={{ resize: 'none', overflow: 'auto' }}
      />
      
      {/* Send Button - absolute right bottom */}
      <button
        type="button"
        onClick={handleSendMessage}
        disabled={isLoading || disabled}
        className="absolute bottom-3 right-3 p-1 text-gray-500 hover:text-white transition-colors duration-200 disabled:opacity-50"
      >
        <ArrowTurnDownLeftIcon className="w-4 h-4" />
      </button>
    </div>
  )
}