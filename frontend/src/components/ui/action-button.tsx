// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Button } from '@/components/ui/button'

interface ActionButtonProps {
  onClick?: () => void
  disabled?: boolean
  title?: string
  icon: React.ReactNode
  /** Optional text label to display next to the icon */
  label?: string
  variant?: 'default' | 'outline' | 'loading'
  className?: string
  asChild?: boolean
}

/**
 * ActionButton Component
 *
 * A unified circular action button component with consistent size (36px) and styling.
 * Designed for use across the application wherever a circular icon button is needed.
 * Supports clickable, outline, and loading/static states.
 *
 * @param onClick - Click handler (not needed for loading variant)
 * @param disabled - Whether the button is disabled
 * @param title - Tooltip text
 * @param icon - Icon element to display (can be any React node, including loading spinners)
 * @param variant - 'default' for ghost button, 'outline' for outlined button, 'loading' for static loading/display state
 * @param className - Additional CSS classes to customize appearance
 * @param asChild - Pass through to Button component for Radix UI composition
 *
 * @example
 * // Clickable action button (ghost style)
 * <ActionButton
 *   onClick={handleClick}
 *   icon={<Send className="h-4 w-4" />}
 *   title="Send message"
 * />
 *
 * @example
 * // Outline button (with border)
 * <ActionButton
 *   variant="outline"
 *   onClick={handleClick}
 *   icon={<Sparkles className="h-4 w-4" />}
 *   className="border-primary bg-primary/10"
 * />
 *
 * @example
 * // Loading state with spinner
 * <ActionButton
 *   variant="loading"
 *   icon={
 *     <>
 *       <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
 *       <CircleStop className="h-4 w-4 text-orange-500" />
 *     </>
 *   }
 * />
 */
export function ActionButton({
  onClick,
  disabled = false,
  title,
  icon,
  label,
  variant = 'default',
  className = '',
}: ActionButtonProps) {
  // Determine if this is an icon-only button or has a label
  const hasLabel = Boolean(label)

  // Base styles - different for icon-only vs with-label buttons
  // Design spec: height 36px, border-radius 24px, border 1px #E4E4E4, bg white
  // With label: padding 10px 12px 10px 10px, gap 4px
  // Icon only: 36x36 circle with centered icon
  const baseStyles = hasLabel
    ? 'h-9 rounded-[24px] flex-shrink-0 pl-2.5 pr-3 py-2.5 gap-1 inline-flex items-center'
    : 'h-9 w-9 rounded-full flex-shrink-0'

  if (variant === 'loading') {
    // Static loading state (non-clickable)
    return (
      <div
        className={`relative ${baseStyles} flex items-center justify-center border border-border bg-base ${className}`}
      >
        {icon}
        {label && <span className="text-sm text-text-primary">{label}</span>}
      </div>
    )
  }

  // Clickable button (default or outline)
  const buttonVariant = variant === 'outline' ? 'outline' : 'ghost'
  // No border for default variant, create clean flat button style
  const defaultClassName = variant === 'outline' ? 'border border-border' : ''

  return (
    <Button
      variant={buttonVariant}
      size={hasLabel ? 'default' : 'icon'}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${baseStyles} ${defaultClassName} ${className}`}
    >
      {icon}
      {label && <span className="text-sm text-text-primary">{label}</span>}
    </Button>
  )
}

export default ActionButton
