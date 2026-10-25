import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeConversationItem } from '@wegent/chat-core/runtime-conversation'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import {
  matchConversationText,
  type ConversationSearchRegion,
} from '@wegent/chat-core/conversation-search'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
  UserMessage,
} from '@wegent/collaboration/conversation'
import contract from '../../../../packages/chat-core/test-fixtures/conversation-search-contract.json'
import { conversationSearchRanges } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'
import { getConversationSearchProjection } from './conversationSearch'
import '@/i18n'

type ContractCase = (typeof contract.cases)[number]
function projectMessages(fixture: ContractCase) {
  const items = fixture.items.map<RuntimeConversationItem>((item, index) => {
    if (item.kind === 'user')
      return {
        id: item.id,
        type: 'user_message',
        message: {
          id: `client:${item.id}`,
          role: 'user',
          content: item.content,
          status: 'done',
          createdAt: '2026-10-23T00:00:00Z',
        },
      }
    if (item.kind === 'final')
      return {
        id: item.id,
        type: 'assistant_text',
        content: item.content,
        createdAt: '2026-10-23T00:00:00Z',
      }
    return {
      id: item.id,
      type: 'block',
      block: {
        id: item.id,
        status: 'done',
        createdAt: index,
        ...(item.kind === 'narrative'
          ? { type: 'text', content: item.content }
          : { type: 'tool', toolName: 'shell', toolInput: {}, toolOutput: item.content }),
      },
    }
  })
  return projectRuntimeConversationTurns([
    {
      id: fixture.id,
      status: fixture.status as 'done' | 'failed' | 'cancelled',
      ...('error' in fixture ? { error: fixture.error } : {}),
      items,
    },
  ])
}

function rawSpans(region: ConversationSearchRegion, start: number, end: number) {
  const spans: { itemId: string; sourceStart: number; sourceEnd: number }[] = []
  for (const source of region.sources) {
    const from = Math.max(start, source.start)
    const to = Math.min(end, source.end)
    if (from >= to) continue
    const direct = source.end - source.start === source.sourceEnd - source.sourceStart
    const span = {
      itemId: source.itemId,
      sourceStart: direct ? source.sourceStart + from - source.start : source.sourceStart,
      sourceEnd: direct ? source.sourceStart + to - source.start : source.sourceEnd,
    }
    const previous = spans.at(-1)
    if (previous?.itemId === span.itemId && previous.sourceEnd === span.sourceStart)
      previous.sourceEnd = span.sourceEnd
    else spans.push(span)
  }
  return spans
}

afterEach(cleanup)

describe('shared conversation search contract', () => {
  test.each(contract.cases)('$id: visible text, identities and UTF-16 source mappings', fixture => {
    const messages = projectMessages(fixture)
    const regions = messages.flatMap(message => getConversationSearchProjection(message))
    expect(regions.map(({ id, text }) => ({ id, text }))).toEqual(fixture.regions)
    for (const region of regions) {
      for (const source of region.sources) {
        const original = fixture.items.find(item => item.id === source.itemId)
        expect(original, `Source item ${source.itemId} must survive projection`).toBeDefined()
        expect(source.start).toBeGreaterThanOrEqual(0)
        expect(source.end).toBeLessThanOrEqual(region.text.length)
        expect(source.start).toBeLessThanOrEqual(source.end)
        expect(source.sourceStart).toBeGreaterThanOrEqual(0)
        expect(source.sourceEnd).toBeLessThanOrEqual(original!.content.length)
        expect(source.sourceStart).toBeLessThanOrEqual(source.sourceEnd)
      }
    }
    if ('mappingAssertions' in fixture)
      for (const mapping of fixture.mappingAssertions) {
        const { regionId, start, end, itemId, sourceStart, sourceEnd } = mapping
        const region = regions.find(region => region.id === regionId)!
        const mapped = rawSpans(region, start, end)
        const expected = { itemId, sourceStart, sourceEnd }
        if ('rawEnvelope' in mapping && mapping.rawEnvelope) {
          // Entity and escape parsers may emit different leaf sizes, but must retain the real source.
          expect(mapped.length).toBeGreaterThan(0)
          expect([...new Set(mapped.map(source => source.itemId))]).toEqual([itemId])
          expect({
            itemId,
            sourceStart: Math.min(...mapped.map(source => source.sourceStart)),
            sourceEnd: Math.max(...mapped.map(source => source.sourceEnd)),
          }).toEqual(expected)
        } else expect(mapped, `${fixture.id}: ${regionId} ${start}:${end}`).toEqual([expected])
        for (let offset = start; offset < end; offset += 1)
          expect(region.sources.some(source => source.start <= offset && source.end > offset)).toBe(
            true
          )
      }
    for (const { query, matches } of fixture.queries) {
      expect(
        regions.flatMap(region =>
          matchConversationText(region.text, query).map(({ start, end }) => ({
            regionId: region.id,
            start,
            end,
            text: region.text.slice(start, end),
          }))
        ),
        query
      ).toEqual(matches)
    }
  })

  test.each(contract.cases)(
    '$id: actual rendered Markdown resolves every match to its text',
    fixture => {
      const messages = projectMessages(fixture)
      const images = {
        identity: (image: { id?: number }) => String(image.id),
        load: vi.fn(),
        download: vi.fn(),
      }
      const { container } = render(
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          {messages.map(message => (
            <article key={message.id} data-message-id={message.id}>
              {message.role === 'user' ? (
                <UserMessage message={message} services={{ images }} />
              ) : (
                <AssistantMessage message={message} devices={[]} imageServices={images} />
              )}
            </article>
          ))}
        </ConversationTranslationProvider>
      )
      for (const { query, matches } of fixture.queries) {
        const ranges = conversationSearchRanges(container, query, 250)
        expect(
          ranges.map(range => range.toString()),
          query
        ).toEqual(matches.map(match => match.text))
        for (const [index, range] of ranges.entries()) {
          expect(range.collapsed).toBe(false)
          expect(
            range.startContainer.parentElement
              ?.closest('[data-search-region-id]')
              ?.getAttribute('data-search-region-id')
          ).toBe(matches[index].regionId)
          expect(
            range.endContainer.parentElement
              ?.closest('[data-search-region-id]')
              ?.getAttribute('data-search-region-id')
          ).toBe(matches[index].regionId)
        }
      }
    }
  )
})
