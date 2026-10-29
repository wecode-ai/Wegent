import { afterEach, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { getMessageLayoutSignature } from '@wegent/collaboration/conversation/messagePretextLayout'
import {
  cacheConversationVirtualMeasurements,
  clearConversationViewportCache,
  getConversationVirtualMeasurements,
  migrateConversationViewport,
  evictConversationViewport,
} from '../../../../packages/collaboration/src/conversation/conversationViewportCache'

afterEach(clearConversationViewportCache)
const rows = [
  { key: 'a', index: 0, start: 32, end: 132, size: 100, lane: 0 },
  { key: 'b', index: 1, start: 148, end: 448, size: 300, lane: 0 },
]
const layout = {
  key: 'width=700;font=14;metrics=1',
  messages: new Map([
    ['a', 'text A'],
    ['b', 'text B'],
  ]),
}

test('restores only measurements with matching typography, width and row content', () => {
  cacheConversationVirtualMeasurements('chat', rows, layout)
  expect(getConversationVirtualMeasurements('chat', layout)).toEqual(rows)
  expect(
    getConversationVirtualMeasurements('chat', { ...layout, key: 'width=400;font=16;metrics=2' })
  ).toBeUndefined()
  expect(
    getConversationVirtualMeasurements('chat', {
      ...layout,
      messages: new Map([
        ['a', 'text A'],
        ['b', 'changed'],
      ]),
    })
  ).toEqual([rows[0]])
  expect(getConversationVirtualMeasurements('chat', { ...layout, messages: new Map() })).toEqual([])
})

test('canonical device aliases move measurement validity together with row heights', () => {
  cacheConversationVirtualMeasurements('alias:task', rows, layout)
  migrateConversationViewport('alias:task', 'device:task')
  expect(getConversationVirtualMeasurements('alias:task', layout)).toBeUndefined()
  expect(getConversationVirtualMeasurements('device:task', layout)).toEqual(rows)
  evictConversationViewport('device:task')
  expect(getConversationVirtualMeasurements('device:task', layout)).toBeUndefined()
})

test('does not reuse a row when block text changes without changing its length', () => {
  const message: WorkbenchMessage = {
    id: 'a',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '',
    blocks: [{ id: 'text', type: 'text', status: 'done', content: 'abcdefgh' }],
  }
  const original = { ...layout, messages: new Map([['a', getMessageLayoutSignature(message)]]) }
  cacheConversationVirtualMeasurements('chat', [rows[0]], original)
  const changed: WorkbenchMessage = {
    ...message,
    blocks: [{ id: 'text', type: 'text', status: 'done', content: 'a\nb\nc\nd\n' }],
  }
  expect(
    getConversationVirtualMeasurements('chat', {
      ...original,
      messages: new Map([['a', getMessageLayoutSignature(changed)]]),
    })
  ).toEqual([])
})

test('eviction also removes measurement layout metadata', () => {
  for (let index = 0; index <= 50; index += 1)
    cacheConversationVirtualMeasurements(`chat-${index}`, rows, layout)
  expect(getConversationVirtualMeasurements('chat-0', layout)).toBeUndefined()
  cacheConversationVirtualMeasurements('chat-0', rows)
  expect(getConversationVirtualMeasurements('chat-0', layout)).toBeUndefined()
})
