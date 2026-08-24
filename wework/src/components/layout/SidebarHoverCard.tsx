import type { ReactNode } from 'react'
import { HoverCard } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'

interface SidebarHoverCardProps {
  children: ReactNode
  content: ReactNode
  testId: string
  interactive?: boolean
  cardClassName?: string
}

export function SidebarHoverCard({
  children,
  content,
  testId,
  interactive = false,
  cardClassName,
}: SidebarHoverCardProps) {
  return (
    <HoverCard
      testId={testId}
      interactive={interactive}
      content={content}
      cardClassName={cn('w-[310px]', cardClassName)}
      estimatedWidth={cardClassName?.includes('w-[320px]') ? 320 : 310}
    >
      {children}
    </HoverCard>
  )
}
