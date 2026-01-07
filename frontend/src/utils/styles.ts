import type { CSSProperties } from 'react'

/**
 * Get shared tag style
 * Used for status tags, share badges and other common tag styles
 */
export const getSharedTagStyle = (): CSSProperties => ({
  fontSize: 11,
  padding: '0 4px',
  lineHeight: '16px',
  backgroundColor: 'hsl(var(--primary) / 0.1)',
  color: 'hsl(var(--primary))',
  borderColor: 'hsl(var(--primary) / 0.2)',
})

/**
 * Get workflow tag style
 */
export const getWorkflowTagStyle = (): CSSProperties => ({
  backgroundColor: 'hsl(var(--muted))',
  color: 'hsl(var(--muted-foreground))',
  border: '1px solid hsl(var(--border))',
  lineHeight: '16px',
})

/**
 * Get subtle badge style
 */
export const getSubtleBadgeStyle = (): CSSProperties => ({
  backgroundColor: 'hsl(var(--muted))',
  color: 'hsl(var(--muted-foreground))',
  border: '1px solid hsl(var(--border))',
  lineHeight: '16px',
})

/**
 * Prompt badge variant type
 */
export type PromptBadgeVariant = 'configured' | 'pending' | 'none'

/**
 * Get prompt badge style
 */
export const getPromptBadgeStyle = (variant: PromptBadgeVariant): CSSProperties => {
  const base: CSSProperties = {
    fontSize: 11,
    lineHeight: '16px',
  }

  if (variant === 'configured') {
    return {
      ...base,
      backgroundColor: 'hsl(var(--primary) / 0.1)',
      color: 'hsl(var(--primary))',
      border: '1px solid hsl(var(--primary) / 0.2)',
    }
  }

  if (variant === 'pending') {
    return {
      ...base,
      backgroundColor: 'hsl(var(--warning) / 0.1)',
      color: 'hsl(var(--warning))',
      border: '1px solid hsl(var(--warning) / 0.2)',
    }
  }

  return {
    ...base,
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: '1px solid hsl(var(--border))',
  }
}
