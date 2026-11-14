import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  findNodeHandle,
  useWindowDimensions,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  implementationPlanQuestion,
  isPendingRequestUserInputBlock,
  requestUserInputPayloadKey,
  userInputQuestions,
  userInputResponse,
} from '@/domain/requestUserInput'
import type {
  ChatToolBlock,
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '@/types/runtime'
import { KeyboardSafeTextInput, KeyboardSafeView, useKeyboardVisible } from './KeyboardSafeInput'
import { ModelControlSurface } from './ModelControlSurface'

export interface RequestUserInputHandlers {
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => Promise<boolean>
  onRequestUserInputSkip?: (payload: RequestUserInputPayload) => Promise<boolean>
}

interface Props extends RequestUserInputHandlers {
  block: ChatToolBlock & { renderPayload: RequestUserInputPayload }
  active: boolean
}

export function RequestUserInputCard({
  block,
  active,
  onRequestUserInputSubmit,
  onRequestUserInputSkip,
}: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const keyboardVisible = useKeyboardVisible()
  const [availableHeight, setAvailableHeight] = useState(height)
  const bottomGap = keyboardVisible ? 8 : Math.max(insets.bottom, 12)
  const payload = block.renderPayload
  const questions = userInputQuestions(payload)
  const implementation = implementationPlanQuestion(questions)
  const [open, setOpen] = useState(false)
  const [activeQuestionId, setActiveQuestionId] = useState(
    () => implementation?.id ?? questions[0]?.id ?? null
  )
  const [customQuestionIds, setCustomQuestionIds] = useState<Set<string>>(() => new Set())
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map(question => [question.id, question.options[0]?.value ?? '']))
  )
  const selectedAnswers = {
    ...Object.fromEntries(
      questions.map(question => [question.id, question.options[0]?.value ?? ''])
    ),
    ...answers,
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localResponse, setLocalResponse] = useState<RequestUserInputResponse | null>(null)
  const [skipped, setSkipped] = useState(false)
  const [, refreshDeadline] = useState(0)
  const busyRef = useRef(false)
  const answerButtonRef = useRef<View>(null)
  const summaryHeadingRef = useRef<View>(null)
  const sheetHeadingRef = useRef<View>(null)
  const wasVisible = useRef(false)
  const response =
    localResponse ??
    payload.response ??
    payload.requestUserInputResponse ??
    payload.request_user_input_response
  const pending = active && !response && !skipped && isPendingRequestUserInputBlock(block)
  const supportsForm = (payload.interactionKind ?? payload.interaction_kind) !== 'mcp_url'
  const canAnswer =
    pending &&
    supportsForm &&
    questions.length > 0 &&
    Boolean(requestUserInputPayloadKey(payload)) &&
    Boolean(onRequestUserInputSubmit)
  const status =
    skipped ||
    payload.interactionStatus === 'cancelled' ||
    (response && Object.keys(response.answers).length === 0)
      ? '已跳过'
      : response || payload.interactionStatus === 'answered'
        ? '已回答'
        : payload.interactionStatus === 'expired' ||
            (payload.expiresAtUnixMs != null && payload.expiresAtUnixMs <= Date.now())
          ? '已过期'
          : block.status === 'error'
            ? '请求失败'
            : active
              ? '问题'
              : '历史问题'

  const restoreFocus = () => {
    const target = findNodeHandle(answerButtonRef.current ?? summaryHeadingRef.current)
    if (target != null) AccessibilityInfo.setAccessibilityFocus(target)
  }

  useEffect(() => {
    const visible = open && pending
    const closing = wasVisible.current && !visible
    wasVisible.current = visible
    if (!closing || Platform.OS !== 'android') return
    const frame = requestAnimationFrame(restoreFocus)
    return () => cancelAnimationFrame(frame)
  }, [open, pending])

  useEffect(() => {
    if (payload.expiresAtUnixMs == null) return
    const remaining = payload.expiresAtUnixMs - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(
      () => refreshDeadline(value => value + 1),
      Math.min(remaining, 2_147_483_647)
    )
    return () => clearTimeout(timer)
  }, [payload.expiresAtUnixMs])

  const submit = async (skip: boolean) => {
    if (busyRef.current || !pending) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const submitted = userInputResponse(payload, selectedAnswers, activeQuestionId)
    try {
      const accepted = skip
        ? await onRequestUserInputSkip?.(payload)
        : await onRequestUserInputSubmit?.(submitted)
      if (!accepted) {
        setError('操作未完成，请重试')
        return
      }
      if (skip) setSkipped(true)
      else setLocalResponse(submitted)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <View
        style={[
          styles.summary,
          {
            backgroundColor: theme.colors.surfaceVariant,
            borderColor: theme.colors.outlineVariant,
          },
        ]}
        testID="request-user-input-card"
      >
        <View ref={summaryHeadingRef} accessible accessibilityLabel={status} style={styles.heading}>
          <Ionicons
            color={theme.colors.onSurfaceVariant}
            name="chatbubble-ellipses-outline"
            size={20}
          />
          <Text style={[styles.headingLabel, { color: theme.colors.onSurfaceVariant }]}>
            {status}
          </Text>
        </View>
        {questions.map(question => (
          <View key={question.id} style={styles.summaryQuestion}>
            <Text style={styles.question}>{question.question}</Text>
            {response?.answers[question.id]?.answers.length ? (
              <Text style={{ color: theme.colors.onSurfaceVariant }}>
                {response.answers[question.id]!.answers.map(
                  answer =>
                    question.options.find(option => option.value === answer)?.label ?? answer
                ).join('\n')}
              </Text>
            ) : null}
          </View>
        ))}
        {!supportsForm ? <Text>请在电脑端完成此授权请求</Text> : null}
        {canAnswer ? (
          <Pressable
            ref={answerButtonRef}
            accessibilityRole="button"
            onPress={() => setOpen(true)}
            style={[styles.answerButton, { backgroundColor: theme.colors.surface }]}
            testID="request-user-input-open"
          >
            <Text style={styles.buttonLabel}>回答问题</Text>
          </Pressable>
        ) : null}
      </View>
      <Modal
        animationType="fade"
        navigationBarTranslucent
        statusBarTranslucent
        transparent
        visible={open && pending}
        onShow={() => {
          const target = findNodeHandle(sheetHeadingRef.current)
          if (target != null) AccessibilityInfo.setAccessibilityFocus(target)
        }}
        onDismiss={restoreFocus}
        onRequestClose={() => setOpen(false)}
      >
        <KeyboardSafeView
          style={styles.modal}
          onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}
        >
          <Pressable
            accessible={false}
            accessibilityLabel="收起问题"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
            testID="request-user-input-backdrop"
          />
          <ModelControlSurface
            style={[
              styles.sheet,
              {
                maxHeight: Math.max(
                  0,
                  Math.min(height, availableHeight) - insets.top - bottomGap - 16
                ),
                marginBottom: bottomGap,
              },
            ]}
            testID="request-user-input-sheet"
          >
            <View
              accessibilityViewIsModal
              onAccessibilityEscape={() => setOpen(false)}
              style={styles.sheetContent}
            >
              <View style={styles.heading}>
                <View
                  ref={sheetHeadingRef}
                  accessible
                  accessibilityLabel="问题"
                  accessibilityRole="header"
                  style={styles.heading}
                  testID="request-user-input-sheet-heading"
                >
                  <Ionicons
                    color={theme.colors.onSurfaceVariant}
                    name="chatbubble-ellipses-outline"
                    size={22}
                  />
                  <Text style={[styles.headingLabel, { color: theme.colors.onSurfaceVariant }]}>
                    问题
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="收起问题"
                  accessibilityRole="button"
                  onPress={() => setOpen(false)}
                  style={styles.closeButton}
                  testID="request-user-input-close"
                >
                  <Ionicons color={theme.colors.onSurfaceVariant} name="close" size={23} />
                </Pressable>
              </View>
              <ScrollView
                style={styles.questionScroller}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.questions}
              >
                {questions.map(question => (
                  <View key={question.id} style={styles.questionGroup}>
                    {questions.length > 1 && question.header ? (
                      <Text style={{ color: theme.colors.onSurfaceVariant }}>
                        {question.header}
                      </Text>
                    ) : null}
                    <Text style={styles.question}>{question.question}</Text>
                    <View accessibilityRole="radiogroup">
                      {question.options.map((option, index) => {
                        const selected =
                          !customQuestionIds.has(question.id) &&
                          selectedAnswers[question.id] === option.value
                        return (
                          <Pressable
                            key={`${option.value}:${index}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: selected, disabled: busy }}
                            disabled={busy}
                            onPress={() => {
                              setActiveQuestionId(question.id)
                              setCustomQuestionIds(current => {
                                const next = new Set(current)
                                next.delete(question.id)
                                return next
                              })
                              setAnswers(current => ({
                                ...current,
                                ...(implementation
                                  ? Object.fromEntries(
                                      questions
                                        .filter(item => item.allowCustom && !item.options.length)
                                        .map(item => [item.id, ''])
                                    )
                                  : {}),
                                [question.id]: option.value,
                              }))
                            }}
                            style={[
                              styles.option,
                              index > 0 && {
                                borderTopWidth: StyleSheet.hairlineWidth,
                                borderTopColor: theme.colors.outlineVariant,
                              },
                            ]}
                            testID={`request-user-input-option-${question.id}-${index}`}
                          >
                            <View
                              style={[
                                styles.radio,
                                {
                                  borderColor: selected
                                    ? theme.colors.onSurface
                                    : theme.colors.outline,
                                  backgroundColor: selected
                                    ? theme.colors.onSurface
                                    : 'transparent',
                                },
                              ]}
                            >
                              {selected ? (
                                <Ionicons color={theme.colors.surface} name="checkmark" size={16} />
                              ) : null}
                            </View>
                            <View style={styles.optionText}>
                              <Text style={styles.optionLabel}>{option.label}</Text>
                              {option.description ? (
                                <Text style={{ color: theme.colors.onSurfaceVariant }}>
                                  {option.description}
                                </Text>
                              ) : null}
                            </View>
                          </Pressable>
                        )
                      })}
                    </View>
                    {question.allowCustom ? (
                      <KeyboardSafeTextInput
                        accessibilityLabel={`${question.question}，自定义回答`}
                        editable={!busy}
                        multiline
                        onChangeText={value => {
                          setActiveQuestionId(question.id)
                          setCustomQuestionIds(current => new Set(current).add(question.id))
                          setAnswers(current => ({ ...current, [question.id]: value }))
                        }}
                        placeholder="回复…"
                        placeholderTextColor={theme.colors.onSurfaceVariant}
                        style={[
                          styles.customInput,
                          {
                            color: theme.colors.onSurface,
                            borderColor: theme.colors.outlineVariant,
                          },
                        ]}
                        testID={`request-user-input-custom-${question.id}`}
                        value={
                          customQuestionIds.has(question.id) || !question.options.length
                            ? (selectedAnswers[question.id] ?? '')
                            : ''
                        }
                      />
                    ) : null}
                  </View>
                ))}
              </ScrollView>
              {error ? (
                <Text
                  accessibilityRole="alert"
                  style={[styles.error, { color: theme.colors.error }]}
                  testID="request-user-input-error"
                >
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {busy ? (
                  <ActivityIndicator color={theme.colors.onSurfaceVariant} size={18} />
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !onRequestUserInputSkip }}
                  disabled={busy || !onRequestUserInputSkip}
                  onPress={() => void submit(true)}
                  style={[
                    styles.actionButton,
                    { borderColor: theme.colors.outlineVariant },
                    busy && styles.disabled,
                  ]}
                  testID="request-user-input-skip"
                >
                  <Text style={styles.buttonLabel}>跳过</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !canAnswer }}
                  disabled={busy || !canAnswer}
                  onPress={() => void submit(false)}
                  style={[
                    styles.actionButton,
                    {
                      backgroundColor: theme.colors.onSurface,
                      borderColor: theme.colors.onSurface,
                    },
                    busy && styles.disabled,
                  ]}
                  testID="request-user-input-submit"
                >
                  <Text style={[styles.buttonLabel, { color: theme.colors.surface }]}>
                    {error ? '重试' : '发送'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ModelControlSurface>
        </KeyboardSafeView>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  summary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 16,
    gap: 16,
    marginVertical: 8,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headingLabel: { fontSize: 16 },
  summaryQuestion: { gap: 8 },
  question: { fontSize: 17, lineHeight: 25, fontWeight: '500' },
  answerButton: {
    minHeight: 44,
    borderRadius: 14,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  modal: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.14)' },
  sheet: { marginHorizontal: 16, borderRadius: 28, overflow: 'hidden' },
  sheetContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, flexShrink: 1 },
  closeButton: {
    width: 44,
    height: 44,
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
  },
  questions: { gap: 24, paddingTop: 12, paddingBottom: 8 },
  questionScroller: { flexShrink: 1 },
  questionGroup: { gap: 16 },
  option: {
    minHeight: 52,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  optionText: { flex: 1, gap: 4 },
  optionLabel: { fontSize: 17, lineHeight: 24 },
  radio: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customInput: {
    minHeight: 48,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 17,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    paddingTop: 16,
  },
  actionButton: {
    minHeight: 44,
    minWidth: 72,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  disabled: { opacity: 0.5 },
  error: { paddingTop: 12 },
})
