import type { CollaborationLocale } from '../i18n'
export const contextUsageMessages: Record<CollaborationLocale, Readonly<Record<string, string>>> = {
  'zh-CN': {
    'workbench.context_usage_title': '背景信息窗口：',
    'workbench.context_usage_percent': '{{usedPercent}}% 已用（剩余 {{remainingPercent}}%）',
    'workbench.context_usage_tokens': '已用 {{usedTokens}} 标记，共 {{totalTokens}}',
    'workbench.context_usage_aria': '上下文窗口已用 {{usedPercent}}%，剩余 {{remainingPercent}}%',
    'workbench.context_usage_compact_hint': '上下文过长，点击压缩上下文',
    'workbench.compact_context': '压缩',
    'workbench.compact_context_prompt': '是否压缩上下文？',
    'workbench.compact_context_hint': '将当前长对话压缩成更短的上下文。',
    'workbench.cancel': '取消',
  },
  en: {
    'workbench.context_usage_title': 'Context window:',
    'workbench.context_usage_percent': '{{usedPercent}}% used ({{remainingPercent}}% remaining)',
    'workbench.context_usage_tokens': '{{usedTokens}} tokens used of {{totalTokens}}',
    'workbench.context_usage_aria':
      'Context window {{usedPercent}}% used, {{remainingPercent}}% remaining',
    'workbench.context_usage_compact_hint': 'Context is long — click to compact.',
    'workbench.compact_context': 'Compact',
    'workbench.compact_context_prompt': 'Compact context?',
    'workbench.compact_context_hint': 'Compress the long conversation into shorter context.',
    'workbench.cancel': 'Cancel',
  },
}
