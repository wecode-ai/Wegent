import type { CSSProperties } from 'react'
import type { GlobalToken } from 'antd/es/theme/interface'

/**
 * Get shared tag style
 * Used for status tags, share badges and other common tag styles
 */
export const getSharedTagStyle = (token: GlobalToken): CSSProperties => ({
  fontSize: 11,
  padding: '0 4px',
  lineHeight: '16px',
  backgroundColor: token.colorPrimaryBg,
  color: token.colorPrimaryText,
  borderColor: token.colorPrimaryBorder ?? token.colorBorder,
})

/**
 * Get workflow tag style
 */
export const getWorkflowTagStyle = (token: GlobalToken): CSSProperties => ({
  backgroundColor: token.colorFillSecondary,
  color: token.colorTextSecondary,
  border: `1px solid ${token.colorBorderSecondary ?? token.colorBorder}`,
  lineHeight: '16px',
})

/**
 * Get subtle badge style
 */
export const getSubtleBadgeStyle = (token: GlobalToken): CSSProperties => ({
  backgroundColor: token.colorFillTertiary,
  color: token.colorTextSecondary,
  border: `1px solid ${token.colorBorderSecondary ?? token.colorBorder}`,
  lineHeight: '16px',
})

/**
 * Prompt badge variant type
 */
export type PromptBadgeVariant = 'configured' | 'pending' | 'none'

/**
 * Get prompt badge style
 */
export const getPromptBadgeStyle = (
  token: GlobalToken,
  variant: PromptBadgeVariant,
): CSSProperties => {
  const base: CSSProperties = {
    fontSize: 11,
    lineHeight: '16px',
  }

  if (variant === 'configured') {
    return {
      ...base,
      backgroundColor: token.colorPrimaryBg,
      color: token.colorPrimaryText,
      border: `1px solid ${token.colorPrimaryBorder ?? token.colorBorder}`,
    }
  }

  if (variant === 'pending') {
    return {
      ...base,
      backgroundColor: token.colorWarningBg,
      color: token.colorWarningText,
      border: `1px solid ${token.colorWarningBorder ?? token.colorBorder}`,
    }
  }

  return {
    ...base,
    backgroundColor: token.colorFillTertiary,
    color: token.colorTextSecondary,
    border: `1px solid ${token.colorBorderSecondary ?? token.colorBorder}`,
  }
}