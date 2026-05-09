// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getMessageBubbleClassNames } from '@/features/tasks/components/message/messageBubbleStyles'

describe('getMessageBubbleClassNames', () => {
  it('uses compact padding for user message bubbles', () => {
    const { baseClasses, typeClasses } = getMessageBubbleClassNames(true)

    expect(baseClasses).toContain('px-4')
    expect(baseClasses).toContain('py-3')
    expect(baseClasses).not.toContain('p-5')
    expect(typeClasses).toContain('rounded-2xl')
    expect(typeClasses).toContain('border')
    expect(typeClasses).toContain('bg-surface')
  })

  it('keeps the roomier layout for ai message bubbles', () => {
    const { baseClasses, typeClasses } = getMessageBubbleClassNames(false)

    expect(baseClasses).toContain('px-5')
    expect(baseClasses).toContain('pt-5')
    expect(baseClasses).toContain('pb-10')
    expect(typeClasses).toBe('')
  })
})
