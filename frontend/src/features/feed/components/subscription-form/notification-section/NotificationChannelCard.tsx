'use client'

import { MessageCircleMore } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { NotificationChannelInfo } from '@/types/subscription'
import { cn } from '@/lib/utils'

interface NotificationChannelCardProps {
  channel: NotificationChannelInfo
  selected: boolean
  disabled?: boolean
  onToggle: () => void
}

export function NotificationChannelCard({
  channel,
  selected,
  disabled = false,
  onToggle,
}: NotificationChannelCardProps) {
  const statusVariant = channel.is_bound ? 'success' : 'info'
  const statusLabel = channel.is_bound ? '已绑定' : '未绑定'
  const description = channel.is_bound ? '可用于接收即时通知' : '需要先完成绑定'

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-colors',
        selected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'
      )}
      data-testid={`notification-channel-card-${channel.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-primary">
              <MessageCircleMore className="h-4 w-4" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-text-primary">{channel.name}</p>
              <Badge variant={statusVariant} size="sm">
                {statusLabel}
              </Badge>
            </div>
          </div>
          <p className="text-xs text-text-muted">{description}</p>
        </div>

        <Button
          type="button"
          variant={selected ? 'primary' : 'outline'}
          size="sm"
          className="h-9 min-w-[88px] shrink-0"
          onClick={onToggle}
          disabled={disabled}
        >
          {selected ? '已启用' : channel.is_bound ? '启用通知' : '启用并配置'}
        </Button>
      </div>
    </div>
  )
}
