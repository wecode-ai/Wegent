// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import DingTalkChatCardFields, {
  emptyChatCard,
  readChatCardConfig,
  serializeChatCardConfig,
} from '@/features/admin/components/DingTalkChatCardFields'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Form() {
  const [value, setValue] = useState({ ...emptyChatCard })
  return (
    <>
      <DingTalkChatCardFields idPrefix="test" value={value} onChange={setValue} />
      <output data-testid="payload">{JSON.stringify(serializeChatCardConfig(value))}</output>
    </>
  )
}

test('template is optional and clearing it explicitly removes the saved configuration', () => {
  render(<Form />)
  fireEvent.click(screen.getByTestId('test-chat-card-settings'))
  expect(screen.getByTestId('payload')).toHaveTextContent('null')
  expect(screen.queryByTestId('test-chat-card-advanced')).not.toBeInTheDocument()
  const input = screen.getByTestId('test-chat-card-template')
  fireEvent.change(input, { target: { value: ' bot.schema ' } })
  expect(JSON.parse(screen.getByTestId('payload').textContent || '')).toEqual({
    ...emptyChatCard,
    template_id: 'bot.schema',
  })
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getByTestId('payload')).toHaveTextContent('null')
})

test('field mapping can vary and follow-ups can be disabled independently', () => {
  render(<Form />)
  fireEvent.click(screen.getByTestId('test-chat-card-settings'))
  fireEvent.change(screen.getByTestId('test-chat-card-template'), {
    target: { value: 'custom.schema' },
  })
  fireEvent.click(screen.getByTestId('test-chat-card-advanced'))
  fireEvent.change(screen.getByTestId('test-chat-card-content_key'), {
    target: { value: 'answer' },
  })
  fireEvent.change(screen.getByTestId('test-chat-card-follow_up_action'), {
    target: { value: 'continueConversation' },
  })
  fireEvent.change(screen.getByTestId('test-chat-card-follow_up_images_key'), {
    target: { value: ' photos ' },
  })
  fireEvent.click(screen.getByTestId('test-chat-card-follow-up'))
  const payload = JSON.parse(screen.getByTestId('payload').textContent || '')
  expect(payload.content_key).toBe('answer')
  expect(payload.follow_up_action).toBe('continueConversation')
  expect(payload.follow_up_images_key).toBe('photos')
  expect(payload.follow_up_enabled).toBe(false)
  expect(screen.queryByTestId('test-chat-card-follow_up_action')).not.toBeInTheDocument()
})

test('editing preserves template-specific initial data and adds omitted defaults', () => {
  const original = { template_id: 'custom.schema', initial_data: { heading: 'Assistant' } }
  const value = readChatCardConfig(original)
  expect(serializeChatCardConfig(value)?.initial_data).toEqual({ heading: 'Assistant' })
  expect(value.content_key).toBe('content')
  expect(value.follow_up_images_key).toBe('followUpImages')
  expect(readChatCardConfig(null)).toEqual(emptyChatCard)
  expect(original).toEqual({ template_id: 'custom.schema', initial_data: { heading: 'Assistant' } })
})

test('send feedback is optional and clearing its mapping disables updates', () => {
  render(<Form />)
  fireEvent.click(screen.getByTestId('test-chat-card-settings'))
  fireEvent.change(screen.getByTestId('test-chat-card-template'), {
    target: { value: 'custom.schema' },
  })
  fireEvent.click(screen.getByTestId('test-chat-card-advanced'))
  const input = screen.getByTestId('test-chat-card-follow_up_status_key')
  fireEvent.change(input, { target: { value: ' followUpStatus ' } })
  expect(JSON.parse(screen.getByTestId('payload').textContent || '').follow_up_status_key).toBe(
    'followUpStatus'
  )
  fireEvent.change(input, { target: { value: '' } })
  expect(
    JSON.parse(screen.getByTestId('payload').textContent || '').follow_up_status_key
  ).toBeNull()
})
