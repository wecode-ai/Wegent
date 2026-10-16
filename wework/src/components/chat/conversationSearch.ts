import type { Root, RootContent } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { AsyncRequestUserInputReply } from '@wegent/chat-core/runtime-user-input'
import {
  getAssistantSearchTextSources,
  getUserMessageTextContent,
} from '@wegent/collaboration/conversation'
import { stripUnsupportedContentReferenceCitations } from '@wegent/collaboration/markdown'

const parser = unified().use(remarkParse).use(remarkGfm)
const BLOCK_TYPES = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow'])

export interface ConversationSearchMatch {
  messageId: string
  occurrence: number
}

const MAX_NAVIGABLE_MATCHES = 250

function nodeText(node: Root | RootContent): string {
  if (node.type === 'image' || node.type === 'imageReference' || node.type === 'html') return ''
  if ('value' in node) return node.value
  if (!('children' in node)) return ''
  return node.children
    .map(child => nodeText(child as RootContent))
    .join(BLOCK_TYPES.has(node.type) ? '\n' : '')
}

export function conversationSearchText(
  message: WorkbenchMessage,
  replyQuestions?: AsyncRequestUserInputReply[]
): string {
  if (message.role === 'system') return ''
  if (message.role === 'user' && replyQuestions?.length) {
    return replyQuestions.map(row => `${row.question}\n${row.answer}`).join('\n')
  }
  const sources =
    message.role === 'user'
      ? [getUserMessageTextContent(message.content)]
      : getAssistantSearchTextSources(message).map(stripUnsupportedContentReferenceCitations)
  return sources.map(text => nodeText(parser.parse(text))).join('\n')
}

export function findConversationMatches(
  index: Array<{ messageId: string; text: string }>,
  query: string
): { matches: ConversationSearchMatch[]; totalMatches: number; isCapped: boolean } {
  const needle = query.trim().toLowerCase()
  const matches: ConversationSearchMatch[] = []
  let totalMatches = 0
  if (!needle) return { matches, totalMatches, isCapped: false }
  for (const entry of index) {
    const text = entry.text.toLowerCase()
    let occurrence = 0
    for (
      let offset = text.indexOf(needle);
      offset >= 0;
      offset = text.indexOf(needle, offset + needle.length)
    ) {
      if (matches.length < MAX_NAVIGABLE_MATCHES) {
        matches.push({ messageId: entry.messageId, occurrence })
      }
      occurrence += 1
      totalMatches += 1
    }
  }
  return { matches, totalMatches, isCapped: totalMatches > matches.length }
}
