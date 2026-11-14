import React from 'react'
import { Keyboard } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatToolBlock, RequestUserInputPayload } from '@/types/runtime'
import { RequestUserInputCard } from './RequestUserInputCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
  Keyboard: { dismiss: vi.fn() },
  findNodeHandle: (node: { testID?: string } | null) =>
    node?.testID === 'request-user-input-sheet-heading' ? 2 : node ? 1 : null,
  Platform: { OS: 'ios' },
  ActivityIndicator: 'ActivityIndicator',
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <>{children}</> : null,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34 }),
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: {
      surface: '#fff',
      onSurface: '#111',
      surfaceVariant: '#eee',
      onSurfaceVariant: '#777',
      outline: '#ddd',
      outlineVariant: '#eee',
      error: '#b00',
    },
  }),
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: 'KeyboardAwareScrollView',
}))
vi.mock('./ModelControlSurface', () => ({ ModelControlSurface: 'ModelControlSurface' }))

describe('native request-user-input card', () => {
  let renderer: ReactTestRenderer
  const payload: RequestUserInputPayload = {
    kind: 'request_user_input',
    requestId: 0,
    interactionScope: 'turn-one',
    questions: [
      {
        id: 'choice',
        question: 'What should we do?',
        is_other: true,
        options: [
          { label: 'One', value: 'one' },
          { label: 'Two', value: 'two', description: 'Second option' },
        ],
      },
    ],
  }
  const block: ChatToolBlock & { renderPayload: RequestUserInputPayload } = {
    id: 'question',
    subtaskId: 'turn-one',
    type: 'tool',
    toolName: 'request_user_input',
    status: 'pending',
    createdAt: 1,
    renderPayload: payload,
  }
  const find = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  async function render(
    overrides: Partial<React.ComponentProps<typeof RequestUserInputCard>> = {}
  ) {
    const props = {
      block,
      active: true,
      onRequestUserInputSubmit: vi.fn().mockResolvedValue(true),
      onRequestUserInputSkip: vi.fn().mockResolvedValue(true),
      ...overrides,
    }
    await act(() => {
      renderer = create(<RequestUserInputCard {...props} />, {
        createNodeMock: element => ({ testID: (element.props as { testID?: string }).testID }),
      })
    })
    return props
  }
  async function open() {
    await act(() => find('request-user-input-open')[0]!.props.onPress())
    expect(Keyboard.dismiss).toHaveBeenCalled()
  }

  it('opens a question sheet and selects a radio option without sending it automatically', async () => {
    const props = await render()
    await open()
    expect(find('request-user-input-sheet')).toHaveLength(1)
    expect(find('request-user-input-option-choice-0')[0]!.props.accessibilityState.checked).toBe(
      true
    )
    await act(() => find('request-user-input-option-choice-1')[0]!.props.onPress())
    expect(props.onRequestUserInputSubmit).not.toHaveBeenCalled()
    await act(() => find('request-user-input-submit')[0]!.props.onPress())
    expect(props.onRequestUserInputSubmit).toHaveBeenCalledWith({
      requestId: 0,
      itemId: undefined,
      interactionScope: 'turn-one',
      answers: { choice: { answers: ['two'] } },
    })
    expect(find('request-user-input-sheet')).toHaveLength(0)
  })

  it('preserves a custom draft when closing and reopening the sheet', async () => {
    const props = await render()
    await open()
    await act(() =>
      find('request-user-input-custom-choice')[0]!.props.onChangeText('Different direction')
    )
    await act(() => find('request-user-input-close')[0]!.props.onPress())
    await open()
    expect(find('request-user-input-custom-choice')[0]!.props.value).toBe('Different direction')
    await act(() => find('request-user-input-submit')[0]!.props.onPress())
    expect(props.onRequestUserInputSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { choice: { answers: ['Different direction'] } } })
    )
  })

  it('keeps every question and the submit actions in one keyboard-aware scroll area', async () => {
    await render({
      block: {
        ...block,
        renderPayload: {
          ...payload,
          questions: [
            ...payload.questions!,
            { id: 'details', question: 'Describe the details', is_other: true },
          ],
        },
      },
    })
    await open()
    const scroll = find('request-user-input-form-scroll')[0]!
    expect(scroll.type).toBe('KeyboardAwareScrollView')
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled')
    expect(scroll.props.bottomOffset).toBeGreaterThan(0)
    expect(scroll.findByProps({ testID: 'request-user-input-custom-choice' })).toBeDefined()
    expect(scroll.findByProps({ testID: 'request-user-input-custom-details' })).toBeDefined()
    expect(scroll.findByProps({ testID: 'request-user-input-submit' })).toBeDefined()
    expect(scroll.findAllByType('ScrollView' as never)).toHaveLength(0)
  })

  it('keeps failed answers editable and exposes an explicit retry', async () => {
    const onRequestUserInputSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Device offline'))
      .mockResolvedValue(true)
    await render({ onRequestUserInputSubmit })
    await open()
    await act(() =>
      find('request-user-input-custom-choice')[0]!.props.onChangeText('Keep this answer')
    )
    await act(() => find('request-user-input-submit')[0]!.props.onPress())
    expect(find('request-user-input-error')[0]!.props.children).toBe('Device offline')
    expect(find('request-user-input-custom-choice')[0]!.props.value).toBe('Keep this answer')
    await act(() => find('request-user-input-submit')[0]!.props.onPress())
    expect(onRequestUserInputSubmit).toHaveBeenCalledTimes(2)
  })

  it('keeps custom text when it matches an option value while typing', async () => {
    const props = await render()
    await open()
    await act(() => find('request-user-input-custom-choice')[0]!.props.onChangeText('one'))
    expect(find('request-user-input-custom-choice')[0]!.props.value).toBe('one')
    expect(find('request-user-input-option-choice-0')[0]!.props.accessibilityState.checked).toBe(
      false
    )
    await act(() =>
      find('request-user-input-custom-choice')[0]!.props.onChangeText('one more detail')
    )
    await act(() => find('request-user-input-submit')[0]!.props.onPress())
    expect(props.onRequestUserInputSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { choice: { answers: ['one more detail'] } } })
    )
  })

  it.each(['adjustment', 'implement'] as const)(
    'submits only the active %s question for an implementation plan',
    async activeQuestion => {
      const props = await render({
        block: {
          ...block,
          renderPayload: {
            ...payload,
            questions: [
              {
                id: 'implement',
                question: 'Implement this plan?',
                options: [{ label: 'Yes', value: 'yes' }],
              },
              { id: 'adjustment', question: 'What should change?', is_other: true },
            ],
          },
        },
      })
      await open()
      await act(() =>
        find('request-user-input-custom-adjustment')[0]!.props.onChangeText('Change it first')
      )
      if (activeQuestion === 'implement')
        await act(() => find('request-user-input-option-implement-0')[0]!.props.onPress())
      await act(() => find('request-user-input-submit')[0]!.props.onPress())
      expect(props.onRequestUserInputSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            [activeQuestion]: {
              answers: [activeQuestion === 'implement' ? 'yes' : 'Change it first'],
            },
          },
        })
      )
    }
  )

  it('moves screen-reader focus into the sheet and restores it after closing', async () => {
    const { Modal, AccessibilityInfo } = await import('react-native')
    await render()
    await open()
    await act(() => renderer.root.findByType(Modal).props.onShow())
    expect(AccessibilityInfo.setAccessibilityFocus).toHaveBeenLastCalledWith(2)
    await act(() => find('request-user-input-close')[0]!.props.onPress())
    await act(() => renderer.root.findByType(Modal).props.onDismiss())
    expect(AccessibilityInfo.setAccessibilityFocus).toHaveBeenLastCalledWith(1)
  })

  it('disables repeated sends while awaiting acknowledgement', async () => {
    let resolve!: (accepted: boolean) => void
    const submit = vi.fn(
      () =>
        new Promise<boolean>(done => {
          resolve = done
        })
    )
    await render({ onRequestUserInputSubmit: submit })
    await open()
    await act(() => {
      find('request-user-input-submit')[0]!.props.onPress()
    })
    expect(find('request-user-input-submit')[0]!.props.disabled).toBe(true)
    expect(find('request-user-input-option-choice-0')[0]!.props.disabled).toBe(true)
    await act(async () => {
      resolve(true)
    })
  })

  it('sends skip through its cancellation callback without manufacturing an answer', async () => {
    const props = await render()
    await open()
    await act(() => find('request-user-input-skip')[0]!.props.onPress())
    expect(props.onRequestUserInputSkip).toHaveBeenCalledWith(payload)
    expect(props.onRequestUserInputSubmit).not.toHaveBeenCalled()
  })

  it.each(['historical', 'answered', 'expired'] as const)(
    'shows %s requests as read-only summaries',
    async state => {
      await render({
        active: state !== 'historical',
        block: {
          ...block,
          renderPayload: {
            ...payload,
            ...(state === 'answered'
              ? { response: { requestId: 0, answers: { choice: { answers: ['One'] } } } }
              : state === 'expired'
                ? { expiresAtUnixMs: 1 }
                : {}),
          },
        },
      })
      expect(find('request-user-input-card')).toHaveLength(1)
      expect(find('request-user-input-open')).toHaveLength(0)
    }
  )

  it('retires an open question when its deadline expires', async () => {
    vi.useFakeTimers()
    await render({
      block: { ...block, renderPayload: { ...payload, expiresAtUnixMs: Date.now() + 1000 } },
    })
    await open()
    await act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(find('request-user-input-sheet')).toHaveLength(0)
    expect(find('request-user-input-open')).toHaveLength(0)
  })
})
