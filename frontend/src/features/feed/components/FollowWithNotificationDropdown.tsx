'use client'

// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Follow with notification level dropdown component.
 * Allows users to select notification level when following a subscription.
 * Supports hover-to-expand behavior on desktop and click on mobile.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Bell,
  BellOff,
  BellRing,
  Check,
  ChevronLeft,
  Loader2,
  MessageSquare,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { subscriptionApis } from '@/apis/subscription'
import type { NotificationLevel, NotificationChannelInfo } from '@/types/subscription'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'

type DropdownStep = 'level' | 'channels'

interface FollowWithNotificationDropdownProps {
  /** Subscription ID to follow */
  subscriptionId: number
  /** Whether user is already following */
  isFollowing?: boolean
  /** Callback when follow/unfollow succeeds */
  onSuccess?: (isFollowing: boolean) => void
  /** Button variant */
  variant?: 'default' | 'ghost' | 'outline' | 'primary'
  /** Button size */
  size?: 'default' | 'sm' | 'lg' | 'icon'
  /** Additional class name */
  className?: string
  /** Whether to show as compact text button (for discover cards) */
  compact?: boolean
}

export function FollowWithNotificationDropdown({
  subscriptionId,
  isFollowing: initialIsFollowing = false,
  onSuccess,
  variant = 'default',
  size = 'sm',
  className,
  compact = false,
}: FollowWithNotificationDropdownProps) {
  const { t } = useTranslation('feed')
  const isMobile = useIsMobile()

  // State
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [step, setStep] = useState<DropdownStep>('level')
  const [_selectedLevel, setSelectedLevel] = useState<NotificationLevel>('default')
  const [selectedChannels, setSelectedChannels] = useState<number[]>([])
  const [availableChannels, setAvailableChannels] = useState<NotificationChannelInfo[]>([])
  const [channelsLoading, setChannelsLoading] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Sync with prop changes
  useEffect(() => {
    setIsFollowing(initialIsFollowing)
  }, [initialIsFollowing])

  // Load available channels
  const loadAvailableChannels = useCallback(async () => {
    try {
      setChannelsLoading(true)
      const response = await subscriptionApis.getFollowSettings(subscriptionId)
      setAvailableChannels(response.available_channels)
    } catch (error) {
      console.error('Failed to load available channels:', error)
    } finally {
      setChannelsLoading(false)
    }
  }, [subscriptionId])

  // Check if user has any bound channels
  const hasBoundChannels = availableChannels.some(c => c.is_bound)

  // Handle mouse enter (desktop only)
  const handleMouseEnter = useCallback(() => {
    if (isMobile || isFollowing) return

    // Clear any pending close timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }

    setIsOpen(true)
    if (availableChannels.length === 0) {
      loadAvailableChannels()
    }
  }, [isMobile, isFollowing, availableChannels.length, loadAvailableChannels])

  // Handle mouse leave (desktop only)
  const handleMouseLeave = useCallback(() => {
    if (isMobile) return

    // Delay close to allow moving to dropdown
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(false)
      setStep('level')
      setSelectedChannels([])
    }, 150)
  }, [isMobile])

  // Handle click on follow button
  const handleButtonClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()

      if (isFollowing) {
        // Unfollow
        try {
          setIsLoading(true)
          await subscriptionApis.unfollowSubscription(subscriptionId)
          setIsFollowing(false)
          toast.success(t('unfollow_success'))
          onSuccess?.(false)
        } catch (error) {
          console.error('Failed to unfollow:', error)
          toast.error(t('unfollow_failed'))
        } finally {
          setIsLoading(false)
        }
        return
      }

      // On mobile, toggle dropdown
      if (isMobile) {
        setIsOpen(!isOpen)
        if (!isOpen && availableChannels.length === 0) {
          loadAvailableChannels()
        }
      }
    },
    [
      isFollowing,
      isMobile,
      isOpen,
      subscriptionId,
      availableChannels.length,
      loadAvailableChannels,
      onSuccess,
      t,
    ]
  )

  // Handle level selection
  const handleLevelSelect = useCallback(
    async (level: NotificationLevel) => {
      if (level === 'notify') {
        // Move to channel selection step
        setSelectedLevel(level)
        setStep('channels')
        return
      }

      // Follow with selected level
      try {
        setIsLoading(true)
        await subscriptionApis.followSubscription(subscriptionId, {
          notification_level: level,
        })
        setIsFollowing(true)
        setIsOpen(false)
        setStep('level')
        toast.success(t('follow_success'))
        onSuccess?.(true)
      } catch (error) {
        console.error('Failed to follow:', error)
        toast.error(t('follow_failed'))
      } finally {
        setIsLoading(false)
      }
    },
    [subscriptionId, onSuccess, t]
  )

  // Handle channel toggle
  const handleChannelToggle = useCallback((channelId: number, checked: boolean) => {
    setSelectedChannels(prev =>
      checked ? [...prev, channelId] : prev.filter(id => id !== channelId)
    )
  }, [])

  // Handle confirm follow with notify level
  const handleConfirmNotify = useCallback(async () => {
    try {
      setIsLoading(true)
      await subscriptionApis.followSubscription(subscriptionId, {
        notification_level: 'notify',
        notification_channel_ids: selectedChannels,
      })
      setIsFollowing(true)
      setIsOpen(false)
      setStep('level')
      setSelectedChannels([])
      toast.success(t('follow_success'))
      onSuccess?.(true)
    } catch (error) {
      console.error('Failed to follow:', error)
      toast.error(t('follow_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [subscriptionId, selectedChannels, onSuccess, t])

  // Handle back button
  const handleBack = useCallback(() => {
    setStep('level')
    setSelectedChannels([])
  }, [])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Close dropdown when clicking outside (mobile)
  useEffect(() => {
    if (!isMobile || !isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setStep('level')
        setSelectedChannels([])
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMobile, isOpen])

  // Get channel type icon
  const getChannelIcon = (_channelType: string) => {
    return <MessageSquare className="h-4 w-4" />
  }

  // Render compact text button (for discover cards)
  if (compact) {
    return (
      <div
        ref={containerRef}
        className="relative"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          onClick={handleButtonClick}
          disabled={isLoading}
          className={cn(
            'text-xs font-medium shrink-0 transition-colors',
            isFollowing
              ? 'text-text-muted hover:text-destructive'
              : 'text-primary hover:text-primary/80',
            className
          )}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isFollowing ? (
            t('following')
          ) : (
            <span className="flex items-center gap-0.5">+ {t('follow')}</span>
          )}
        </button>

        {/* Dropdown */}
        {isOpen && !isFollowing && (
          <div
            className="absolute right-0 top-full mt-1 z-50 w-60 rounded-lg border border-border bg-surface shadow-lg"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {step === 'level' ? (
              <LevelSelectionContent
                t={t}
                isLoading={isLoading}
                hasBoundChannels={hasBoundChannels}
                channelsLoading={channelsLoading}
                onSelect={handleLevelSelect}
              />
            ) : (
              <ChannelSelectionContent
                t={t}
                isLoading={isLoading}
                availableChannels={availableChannels}
                selectedChannels={selectedChannels}
                onToggle={handleChannelToggle}
                onBack={handleBack}
                onConfirm={handleConfirmNotify}
                getChannelIcon={getChannelIcon}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  // Render standard button
  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Button
        variant={isFollowing ? 'ghost' : variant === 'default' ? 'default' : variant}
        size={size}
        onClick={handleButtonClick}
        disabled={isLoading}
        className={cn(
          isFollowing ? 'text-text-muted hover:text-destructive hover:bg-destructive/10' : '',
          className
        )}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
        ) : isFollowing ? (
          <Check className="h-4 w-4 mr-1.5" />
        ) : (
          <Plus className="h-4 w-4 mr-1.5" />
        )}
        {isFollowing ? t('following') : t('follow')}
      </Button>

      {/* Dropdown */}
      {isOpen && !isFollowing && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-60 rounded-lg border border-border bg-surface shadow-lg"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {step === 'level' ? (
            <LevelSelectionContent
              t={t}
              isLoading={isLoading}
              hasBoundChannels={hasBoundChannels}
              channelsLoading={channelsLoading}
              onSelect={handleLevelSelect}
            />
          ) : (
            <ChannelSelectionContent
              t={t}
              isLoading={isLoading}
              availableChannels={availableChannels}
              selectedChannels={selectedChannels}
              onToggle={handleChannelToggle}
              onBack={handleBack}
              onConfirm={handleConfirmNotify}
              getChannelIcon={getChannelIcon}
            />
          )}
        </div>
      )}
    </div>
  )
}

// Level selection step content
interface LevelSelectionContentProps {
  t: (key: string) => string
  isLoading: boolean
  hasBoundChannels: boolean
  channelsLoading: boolean
  onSelect: (level: NotificationLevel) => void
}

function LevelSelectionContent({
  t,
  isLoading,
  hasBoundChannels,
  channelsLoading,
  onSelect,
}: LevelSelectionContentProps) {
  const notifyDisabled = !hasBoundChannels && !channelsLoading

  return (
    <div className="p-2">
      <div className="px-2 py-1.5 text-xs font-medium text-text-muted">
        {t('follow_dropdown.select_level')}
      </div>
      <div className="space-y-0.5">
        {/* Silent */}
        <button
          className="w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-hover transition-colors text-left"
          onClick={() => onSelect('silent')}
          disabled={isLoading}
        >
          <BellOff className="h-4 w-4 text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{t('follow_dropdown.level_silent')}</div>
            <div className="text-xs text-text-muted truncate">
              {t('follow_dropdown.level_silent_desc')}
            </div>
          </div>
        </button>

        {/* Default */}
        <button
          className="w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-hover transition-colors text-left"
          onClick={() => onSelect('default')}
          disabled={isLoading}
        >
          <Bell className="h-4 w-4 text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium flex items-center gap-1.5">
              {t('follow_dropdown.level_default')}
              <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {t('default')}
              </span>
            </div>
            <div className="text-xs text-text-muted truncate">
              {t('follow_dropdown.level_default_desc')}
            </div>
          </div>
        </button>

        {/* Notify */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <button
                className={cn(
                  'w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-left',
                  notifyDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-hover cursor-pointer'
                )}
                onClick={() => !notifyDisabled && onSelect('notify')}
                disabled={isLoading || notifyDisabled}
              >
                <BellRing className="h-4 w-4 text-text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{t('follow_dropdown.level_notify')}</div>
                  <div className="text-xs text-text-muted truncate">
                    {t('follow_dropdown.level_notify_desc')}
                  </div>
                </div>
              </button>
            </div>
          </TooltipTrigger>
          {notifyDisabled && (
            <TooltipContent side="left" className="max-w-[200px]">
              {t('follow_dropdown.notify_disabled_hint')}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </div>
  )
}

// Channel selection step content
interface ChannelSelectionContentProps {
  t: (key: string) => string
  isLoading: boolean
  availableChannels: NotificationChannelInfo[]
  selectedChannels: number[]
  onToggle: (channelId: number, checked: boolean) => void
  onBack: () => void
  onConfirm: () => void
  getChannelIcon: (channelType: string) => React.ReactNode
}

function ChannelSelectionContent({
  t,
  isLoading,
  availableChannels,
  selectedChannels,
  onToggle,
  onBack,
  onConfirm,
  getChannelIcon,
}: ChannelSelectionContentProps) {
  const boundChannels = availableChannels.filter(c => c.is_bound)
  const hasSelection = selectedChannels.length > 0

  return (
    <div className="p-2">
      {/* Header with back button */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          className="p-1 rounded hover:bg-hover transition-colors"
          onClick={onBack}
          disabled={isLoading}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-xs font-medium text-text-muted">
          {t('follow_dropdown.select_channels')}
        </div>
      </div>

      {/* Channel list */}
      <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
        {boundChannels.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-text-muted">
            {t('notification_settings.no_channels')}
          </div>
        ) : (
          boundChannels.map(channel => (
            <label
              key={channel.id}
              className="w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-hover transition-colors cursor-pointer"
            >
              <Checkbox
                checked={selectedChannels.includes(channel.id)}
                onCheckedChange={checked => onToggle(channel.id, checked as boolean)}
                disabled={isLoading}
              />
              {getChannelIcon(channel.channel_type)}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{channel.name}</div>
                <div className="text-xs text-text-muted">{channel.channel_type}</div>
              </div>
            </label>
          ))
        )}
      </div>

      {/* Hint */}
      <div className="px-2 py-1.5 text-xs text-text-muted">
        {t('follow_dropdown.select_channels_hint')}
      </div>

      {/* Confirm button */}
      <div className="px-2 pt-1 pb-1 border-t border-border mt-1">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={onConfirm}
          disabled={isLoading || !hasSelection}
        >
          {isLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
          {t('follow_dropdown.confirm_follow')}
        </Button>
      </div>
    </div>
  )
}

// Export for use in invitation component
export interface AcceptWithNotificationDropdownProps {
  /** Invitation ID */
  invitationId: number
  /** Subscription ID (for loading channels) */
  subscriptionId: number
  /** Callback when accept succeeds */
  onSuccess?: () => void
  /** Additional class name */
  className?: string
}

export function AcceptWithNotificationDropdown({
  invitationId,
  subscriptionId,
  onSuccess,
  className,
}: AcceptWithNotificationDropdownProps) {
  const { t } = useTranslation('feed')
  const isMobile = useIsMobile()

  // State
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [step, setStep] = useState<DropdownStep>('level')
  const [_selectedLevel, setSelectedLevel] = useState<NotificationLevel>('default')
  const [selectedChannels, setSelectedChannels] = useState<number[]>([])
  const [availableChannels, setAvailableChannels] = useState<NotificationChannelInfo[]>([])
  const [channelsLoading, setChannelsLoading] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Load available channels
  const loadAvailableChannels = useCallback(async () => {
    try {
      setChannelsLoading(true)
      const response = await subscriptionApis.getFollowSettings(subscriptionId)
      setAvailableChannels(response.available_channels)
    } catch (error) {
      console.error('Failed to load available channels:', error)
    } finally {
      setChannelsLoading(false)
    }
  }, [subscriptionId])

  // Check if user has any bound channels
  const hasBoundChannels = availableChannels.some(c => c.is_bound)

  // Handle mouse enter (desktop only)
  const handleMouseEnter = useCallback(() => {
    if (isMobile) return

    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }

    setIsOpen(true)
    if (availableChannels.length === 0) {
      loadAvailableChannels()
    }
  }, [isMobile, availableChannels.length, loadAvailableChannels])

  // Handle mouse leave (desktop only)
  const handleMouseLeave = useCallback(() => {
    if (isMobile) return

    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(false)
      setStep('level')
      setSelectedChannels([])
    }, 150)
  }, [isMobile])

  // Handle click on accept button (mobile)
  const handleButtonClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      if (isMobile) {
        setIsOpen(!isOpen)
        if (!isOpen && availableChannels.length === 0) {
          loadAvailableChannels()
        }
      }
    },
    [isMobile, isOpen, availableChannels.length, loadAvailableChannels]
  )

  // Handle level selection
  const handleLevelSelect = useCallback(
    async (level: NotificationLevel) => {
      if (level === 'notify') {
        setSelectedLevel(level)
        setStep('channels')
        return
      }

      // Accept with selected level
      try {
        setIsLoading(true)
        await subscriptionApis.acceptInvitation(invitationId, {
          notification_level: level,
        })
        setIsOpen(false)
        setStep('level')
        toast.success(t('invitation_accepted'))
        onSuccess?.()
      } catch (error) {
        console.error('Failed to accept invitation:', error)
        toast.error(t('invitation_accept_failed'))
      } finally {
        setIsLoading(false)
      }
    },
    [invitationId, onSuccess, t]
  )

  // Handle channel toggle
  const handleChannelToggle = useCallback((channelId: number, checked: boolean) => {
    setSelectedChannels(prev =>
      checked ? [...prev, channelId] : prev.filter(id => id !== channelId)
    )
  }, [])

  // Handle confirm accept with notify level
  const handleConfirmNotify = useCallback(async () => {
    try {
      setIsLoading(true)
      await subscriptionApis.acceptInvitation(invitationId, {
        notification_level: 'notify',
        notification_channel_ids: selectedChannels,
      })
      setIsOpen(false)
      setStep('level')
      setSelectedChannels([])
      toast.success(t('invitation_accepted'))
      onSuccess?.()
    } catch (error) {
      console.error('Failed to accept invitation:', error)
      toast.error(t('invitation_accept_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [invitationId, selectedChannels, onSuccess, t])

  // Handle back button
  const handleBack = useCallback(() => {
    setStep('level')
    setSelectedChannels([])
  }, [])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Close dropdown when clicking outside (mobile)
  useEffect(() => {
    if (!isMobile || !isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setStep('level')
        setSelectedChannels([])
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMobile, isOpen])

  // Get channel type icon
  const getChannelIcon = (_channelType: string) => {
    return <MessageSquare className="h-4 w-4" />
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Button size="sm" onClick={handleButtonClick} disabled={isLoading} className={className}>
        {isLoading ? (
          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
        ) : (
          <Check className="h-4 w-4 mr-1" />
        )}
        {t('invitation_accept')}
      </Button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-60 rounded-lg border border-border bg-surface shadow-lg"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {step === 'level' ? (
            <LevelSelectionContent
              t={t}
              isLoading={isLoading}
              hasBoundChannels={hasBoundChannels}
              channelsLoading={channelsLoading}
              onSelect={handleLevelSelect}
            />
          ) : (
            <ChannelSelectionContent
              t={t}
              isLoading={isLoading}
              availableChannels={availableChannels}
              selectedChannels={selectedChannels}
              onToggle={handleChannelToggle}
              onBack={handleBack}
              onConfirm={handleConfirmNotify}
              getChannelIcon={getChannelIcon}
            />
          )}
        </div>
      )}
    </div>
  )
}
