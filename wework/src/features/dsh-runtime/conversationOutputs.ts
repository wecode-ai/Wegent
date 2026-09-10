import { classifyMarkdownLink } from '@/components/chat/assistantMarkdownLinks'
import { basename, getAssistantReferences } from '@/components/chat/codexReferences'
import type {
  ConversationOutput,
  ConversationOutputsSnapshot,
  ConversationOutputSource,
  ConversationSummaryResource,
} from './conversationHostServices'
import type { WorkbenchMessage } from '@/types/workbench'

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g

export function buildConversationOutputs(
  messages: readonly WorkbenchMessage[]
): ConversationOutputsSnapshot {
  const outputs = new Map<string, ConversationOutput>()
  const sources = new Map<string, ConversationOutputSource>()

  for (const message of messages) {
    if (message.role === 'user') {
      for (const attachment of message.attachments ?? []) {
        const resource = attachment.local_path
          ? ({ kind: 'file', path: attachment.local_path } as const)
          : undefined
        addLatest(sources, resource ? resourceKey(resource) : `attachment:${attachment.id}`, {
          id: `attachment:${attachment.id}`,
          kind: 'attachment',
          resource,
          title: attachment.filename,
        })
      }
      continue
    }
    if (message.role !== 'assistant') continue

    for (const reference of getAssistantReferences(
      message.references,
      message.content,
      message.fileChanges
    )) {
      const resource = { kind: 'file', path: reference.path } as const
      addLatest(outputs, resourceKey(resource), {
        id: `file:${reference.path}`,
        kind: /\.html?$/i.test(reference.path) ? 'website' : 'file',
        resource,
        title: reference.title?.trim() || basename(reference.path),
      })
    }

    for (const link of markdownLinks(message.content)) {
      const target = classifyMarkdownLink(link.href)
      if (target.kind === 'file' && /\.html?$/i.test(target.path)) {
        const resource = { kind: 'file', path: target.path } as const
        addLatest(outputs, resourceKey(resource), {
          id: `website:${target.path}`,
          kind: 'website',
          resource,
          title: link.title || basename(target.path),
        })
      } else if (target.kind === 'external') {
        const resource = { kind: 'url', url: link.href } as const
        addLatest(sources, resourceKey(resource), {
          id: `website:${link.href}`,
          kind: 'website',
          resource,
          title: link.title || hostname(link.href),
        })
      }
    }

    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool') continue
      if (block.toolName === 'image_generation') {
        const image = generatedImage(block)
        if (image) addLatest(outputs, resourceKey(image.resource), image)
      }
      if (block.toolName === 'web_search') {
        const url = webSearchUrl(block.toolInput)
        if (!url) continue
        const resource = { kind: 'url', url } as const
        addLatest(sources, resourceKey(resource), {
          id: `website:${url}`,
          kind: 'website',
          resource,
          title: hostname(url),
        })
      }
    }

    for (const citation of message.memoryCitations ?? []) {
      for (const entry of citation.entries ?? []) {
        if (!entry.path?.trim()) continue
        const resource = { kind: 'file', path: entry.path } as const
        addLatest(sources, resourceKey(resource), {
          id: `memory:${entry.path}`,
          kind: 'memory',
          resource,
          title: basename(entry.path),
        })
      }
    }
  }

  return {
    outputs: [...outputs.values()].reverse(),
    sources: [...sources.values()].reverse(),
  }
}

function generatedImage(
  block: NonNullable<WorkbenchMessage['blocks']>[number]
): ConversationOutput | null {
  const payload = block.type === 'tool' ? block.renderPayload : undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const source = Reflect.get(payload, 'source')
  const revisedPrompt = Reflect.get(payload, 'revisedPrompt')
  const title =
    typeof revisedPrompt === 'string' && revisedPrompt.trim() ? revisedPrompt : 'Generated image'

  if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
    const path = Reflect.get(source, 'path')
    if (
      Reflect.get(source, 'type') === 'workspace_file' &&
      typeof path === 'string' &&
      path.trim()
    ) {
      return {
        id: `image:${block.id}`,
        kind: 'image',
        resource: { kind: 'file', path },
        title,
      }
    }
  }

  return null
}

function webSearchUrl(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const key of ['url', 'query']) {
    const value = input[key]
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim()
  }
  return null
}

function markdownLinks(content: string): Array<{ href: string; title: string }> {
  return [...content.matchAll(MARKDOWN_LINK_PATTERN)].flatMap(match => {
    const href = match[2]?.trim().replace(/^<|>$/g, '')
    if (!href) return []
    return [{ href, title: match[1]?.trim() ?? '' }]
  })
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function resourceKey(resource: ConversationSummaryResource): string {
  return resource.kind === 'file'
    ? `file:${resource.path.replace(/\\/g, '/')}`
    : `url:${resource.url}`
}

function addLatest<T>(items: Map<string, T>, key: string, item: T): void {
  items.delete(key)
  items.set(key, item)
}
