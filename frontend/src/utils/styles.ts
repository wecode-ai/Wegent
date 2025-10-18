import type { CSSProperties } from 'react'
import type { GlobalToken } from 'antd/es/theme/interface'

/**
 * 获取共享标签样式
 * 用于状态标签、共享徽章等通用标签样式
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
 * 获取工作流标签样式
 */
export const getWorkflowTagStyle = (token: GlobalToken): CSSProperties => ({
  backgroundColor: token.colorFillSecondary,
  color: token.colorTextSecondary,
  border: `1px solid ${token.colorBorderSecondary ?? token.colorBorder}`,
  lineHeight: '16px',
})

/**
 * 获取 subtle 徽章样式
 */
export const getSubtleBadgeStyle = (token: GlobalToken): CSSProperties => ({
  backgroundColor: token.colorFillTertiary,
  color: token.colorTextSecondary,
  border: `1px solid ${token.colorBorderSecondary ?? token.colorBorder}`,
  lineHeight: '16px',
})

/**
 * 提示徽章变体类型
 */
export type PromptBadgeVariant = 'configured' | 'pending' | 'none'

/**
 * 获取提示徽章样式
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