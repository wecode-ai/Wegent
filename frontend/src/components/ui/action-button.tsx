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
  variant = 'default',
  className = '',
}: ActionButtonProps) {
  // Base styles shared by all variants
  const baseStyles = 'h-9 w-9 rounded-full flex-shrink-0'

  if (variant === 'loading') {
    // Static loading state (non-clickable)
    return (
      <div
        className={`relative ${baseStyles} flex items-center justify-center border border-border bg-base ${className}`}
      >
        {icon}
      </div>
    )
  }

  // Clickable button (default or outline)
  const buttonVariant = variant === 'outline' ? 'outline' : 'ghost'
  const defaultClassName = variant === 'outline' ? '' : 'border border-border'

  return (
    <Button
      variant={buttonVariant}
      size="icon"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${baseStyles} ${defaultClassName} ${className}`}
    >
      {icon}
    </Button>
  )
}

export default ActionButton
