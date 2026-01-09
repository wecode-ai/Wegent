// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Send, ChevronDown, Check } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { userApis } from '@/apis/user'
import { useToast } from '@/hooks/use-toast'
import type { UserPreferences } from '@/types/api'
import LoadingDots from '../message/LoadingDots'

interface SendButtonProps {
  onClick: () => void
  disabled?: boolean
  isLoading?: boolean
  className?: string
  /** Hide dropdown toggle for mobile */
  compact?: boolean
}

type SendKeyOption = 'enter' | 'cmd_enter'

export default function SendButton({
  onClick,
  disabled = false,
  isLoading = false,
  className = '',
  compact = false,
}: SendButtonProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user, refresh } = useUser()
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Get current send key preference from user context
  const sendKey: SendKeyOption = (user?.preferences?.send_key as SendKeyOption) || 'enter'

  // Detect if Mac or Windows for display
  const isMac = useMemo(() => {
    return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Handle send key change
  const handleSendKeyChange = useCallback(
    async (value: SendKeyOption) => {
      if (value === sendKey) {
        setIsDropdownOpen(false)
        return
      }

      setIsSaving(true)
      try {
        const preferences: UserPreferences = { send_key: value }
        await userApis.updateUser({ preferences })
        await refresh()
        toast({
          title: t('chat:send_button.preference_saved'),
        })
      } catch (error) {
        console.error('Failed to save send key preference:', error)
        toast({
          variant: 'destructive',
          title: t('chat:send_button.preference_save_failed'),
        })
      } finally {
        setIsSaving(false)
        setIsDropdownOpen(false)
      }
    },
    [sendKey, refresh, toast, t]
  )

  // Handle main button click (send message)
  const handleMainClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled && !isLoading) {
        onClick()
      }
    },
    [disabled, isLoading, onClick]
  )

  // Handle dropdown toggle click
  const handleDropdownToggle = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!isSaving) {
        setIsDropdownOpen(prev => !prev)
      }
    },
    [isSaving]
  )

  // Get shortcut display text
  const getShortcutText = useCallback(
    (option: SendKeyOption): string => {
      if (option === 'enter') {
        return 'Enter'
      }
      return isMac ? '⌘ Enter' : 'Ctrl Enter'
    },
    [isMac]
  )

  // Get option label
  const getOptionLabel = useCallback(
    (option: SendKeyOption): string => {
      if (option === 'enter') {
        return t('chat:send_button.option_enter')
      }
      return isMac
        ? t('chat:send_button.option_cmd_enter_mac')
        : t('chat:send_button.option_cmd_enter_win')
    },
    [isMac, t]
  )

  return (
    <div className={`relative inline-flex ${className}`}>
      {/* Main button container with pill shape - 36px height to match Figma */}
      <div className="inline-flex items-center rounded-full bg-base border border-border overflow-hidden h-9">
        {/* Send button - icon only */}
        <button
          ref={buttonRef}
          type="button"
          onClick={handleMainClick}
          disabled={disabled || isLoading}
          data-tour="send-button"
          data-testid="send-button"
          className={`
            flex items-center justify-center h-full
            transition-colors duration-150
            ${compact ? 'px-3' : 'px-2.5'}
            ${
              disabled || isLoading
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:text-text-primary hover:bg-hover'
            }
          `}
        >
          {isLoading ? <LoadingDots /> : <Send className="h-4 w-4" />}
        </button>

        {/* Divider and Dropdown toggle - hidden in compact mode */}
        {!compact && (
          <>
            <div className="w-px h-4 bg-border" />
            <button
              type="button"
              onClick={handleDropdownToggle}
              disabled={isSaving}
              className={`
                flex items-center justify-center px-1.5 h-full
                transition-colors duration-150
                ${
                  isSaving
                    ? 'text-text-muted cursor-not-allowed'
                    : 'text-text-muted hover:text-text-primary hover:bg-hover'
                }
              `}
              aria-label={t('chat:send_button.change_shortcut')}
              aria-expanded={isDropdownOpen}
              aria-haspopup="true"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </>
        )}
      </div>

      {/* Dropdown menu */}
      {isDropdownOpen && !compact && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-border bg-surface shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <div className="p-1">
            <div className="px-2 py-1.5 text-xs font-medium text-text-muted">
              {t('chat:send_button.shortcut_title')}
            </div>
            {(['enter', 'cmd_enter'] as SendKeyOption[]).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => handleSendKeyChange(option)}
                disabled={isSaving}
                className={`
                  w-full flex items-center justify-between px-2 py-2 rounded-md text-sm
                  transition-colors duration-150
                  ${
                    sendKey === option
                      ? 'bg-primary/10 text-primary'
                      : 'text-text-primary hover:bg-hover'
                  }
                  ${isSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span>{getOptionLabel(option)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted px-1.5 py-0.5 rounded bg-muted">
                    {getShortcutText(option)}
                  </span>
                  {sendKey === option && <Check className="h-4 w-4 text-primary" />}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
