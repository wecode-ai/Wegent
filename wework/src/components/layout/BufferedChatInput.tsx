import {
  memo,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  useImperativeHandle,
} from 'react'
import { ChatInput, type ChatInputHandle, type ChatInputProps } from '@/components/chat/ChatInput'
import {
  focusEditorTarget,
  useDOMEvent,
  useEditorFocusRequest,
} from '@wegent/collaboration/dom-events'
import {
  consumeWorkbenchComposerFocusRequest,
  hasWorkbenchComposerFocusRequest,
  WORKBENCH_COMPOSER_FOCUS_EVENT,
  type WorkbenchComposerFocusDetail,
} from '@/lib/workbenchComposerFocus'
import {
  BUFFERED_COMPOSER_AUTO_FOCUS_GUARD,
  BUFFERED_COMPOSER_FOCUS_GUARD,
  createBufferedComposerModel,
} from './bufferedComposerModel'
import type { Ref } from 'react'
export interface BufferedChatInputInsertion {
  id: number
  text: string
}

interface BufferedChatInputProps extends ChatInputProps {
  // Return { appliedSynchronously: true } when the owner queues the value before returning.
  onChange: (value: string) => unknown
  inputRef?: Ref<ChatInputHandle>
  autoFocus?: boolean
  clearOnSubmit?: boolean
  insertion?: BufferedChatInputInsertion | null
  // Increment for every explicit external restore, even when the value is unchanged.
  // Without a new key, values matching pending publications are acknowledgements.
  replaceDraftKey?: number
  onDraftEdit?: (draft: string) => void
}

export const BufferedChatInput = memo(function BufferedChatInput({
  value,
  onChange,
  onSubmit,
  autoFocus,
  clearOnSubmit = true,
  insertion,
  replaceDraftKey,
  onDraftEdit,
  inputRef,
  onCompositionStart: onParentCompositionStart,
  onCompositionEnd: onParentCompositionEnd,
  ...props
}: BufferedChatInputProps) {
  const scopeKey = props.projectChat?.scopeKey
  const input = useMemo(
    () => ({
      value,
      scopeKey,
      replaceDraftKey,
      insertion,
      onChange,
      onSubmit,
      onDraftEdit,
      onParentCompositionStart,
      onParentCompositionEnd,
      clearOnSubmit,
      autoFocus,
      disabled: props.disabled,
    }),
    [
      value,
      scopeKey,
      replaceDraftKey,
      insertion,
      onChange,
      onSubmit,
      onDraftEdit,
      onParentCompositionStart,
      onParentCompositionEnd,
      clearOnSubmit,
      autoFocus,
      props.disabled,
    ]
  )
  const [model] = useState(() => createBufferedComposerModel(input))
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  const bindComposer = useCallback(
    (handle: ChatInputHandle | null) => {
      model.bind(handle, input, snapshot.revision)
      return () => model.bind(null, input, snapshot.revision)
    },
    [model, input, snapshot.revision]
  )
  useImperativeHandle(
    inputRef,
    () => ({
      get element() {
        return model.target.current?.element ?? null
      },
      focus: () => model.target.current?.focus(),
      getValue: () => model.target.current?.getValue() ?? model.getDraft(),
      insertReference: reference => model.target.current?.insertReference(reference),
      setValue: (nextValue, offset) => model.target.current?.setValue(nextValue, offset),
    }),
    [model]
  )
  const [consumer] = useState(() => Symbol('workbench-composer-focus'))
  const eligibleRequest = useCallback(
    () => Boolean(scopeKey && hasWorkbenchComposerFocusRequest(scopeKey, consumer)),
    [scopeKey, consumer]
  )
  const consumeRequest = useCallback(() => {
    if (scopeKey) consumeWorkbenchComposerFocusRequest(scopeKey, consumer)
  }, [scopeKey, consumer])
  useEditorFocusRequest(model.target, scopeKey, {
    ...BUFFERED_COMPOSER_FOCUS_GUARD,
    enabled: !props.disabled && Boolean(scopeKey),
    eligible: eligibleRequest,
    onFocused: consumeRequest,
  })
  useEditorFocusRequest(model.target, scopeKey, {
    ...BUFFERED_COMPOSER_AUTO_FOCUS_GUARD,
    enabled: Boolean(autoFocus && !props.disabled),
  })
  useDOMEvent<CustomEvent<WorkbenchComposerFocusDetail>>(
    'window',
    WORKBENCH_COMPOSER_FOCUS_EVENT,
    event => {
      if (props.disabled || !scopeKey || event.detail?.scopeKey !== scopeKey || !eligibleRequest())
        return
      if (focusEditorTarget(model.target.current, BUFFERED_COMPOSER_FOCUS_GUARD)) consumeRequest()
    }
  )
  return (
    <ChatInput
      {...props}
      ref={bindComposer}
      value={model.preview(input)}
      onChange={model.setDraft}
      onBlur={model.handleBlur}
      onCompositionStart={model.handleCompositionStart}
      onCompositionEnd={model.handleCompositionEnd}
      onSubmit={model.handleSubmit}
    />
  )
})
