import type { Attachment, RequestUserInputQuestion } from '@wegent/chat-core/runtime'
import { hasImplementationPlanText } from '@wegent/chat-core/runtime-user-input'

export function normalizeQuestions(questions: RequestUserInputQuestion[] | undefined) {
  return (questions ?? []).map((question, index) => {
    const id = question.id?.trim() || `question_${index + 1}`
    const options = (question.options ?? [])
      .map((option) => ({
        label: option.label?.trim() ?? '',
        description: option.description?.trim() ?? '',
        value: option.value?.trim() || option.label?.trim() || '',
      }))
      .filter((option) => option.label)
    return {
      id,
      header: question.header?.trim() ?? '',
      question: question.question?.trim() || id,
      options,
      allowCustom: Boolean(
        question.is_other ?? question.isOther ?? options.length === 0,
      ),
    }
  })
}

export function sameOptionDrafts(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (left === right) return true
  const leftEntries = Object.entries(left ?? {})
  return (
    leftEntries.length === Object.keys(right ?? {}).length &&
    leftEntries.every(([id, value]) => right?.[id] === value)
  )
}

export function sameAttachmentDrafts(
  left: Attachment[] | undefined,
  right: Attachment[] | undefined,
): boolean {
  if (left === right) return true
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false
  return (left ?? []).every((attachment, index) => {
    const other = right?.[index]
    if (!other) return false
    if (attachment === other) return true
    const keys = Object.keys(attachment) as Array<keyof Attachment>
    if (keys.length !== Object.keys(other).length) return false
    return keys.every((key) => {
      if (key !== 'workspace_file') return attachment[key] === other[key]
      const file = attachment.workspace_file
      const otherFile = other.workspace_file
      return (
        file === otherFile ||
        (file?.device_id === otherFile?.device_id &&
          file?.workspace_path === otherFile?.workspace_path &&
          file?.path === otherFile?.path)
      )
    })
  })
}

export function initialAnswers(
  questions: ReturnType<typeof normalizeQuestions>,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      question.options[0]?.value ?? '',
    ]),
  )
}

export function initialActiveQuestionId(
  questions: ReturnType<typeof normalizeQuestions>,
  draftAnswers?: Record<string, string>,
  draftAttachments?: Record<string, Attachment[]>,
): string | null {
  return (
    customDraftQuestionId(questions, draftAnswers) ??
    questions.find(
      (question) =>
        question.allowCustom && draftAttachments?.[question.id]?.length,
    )?.id ??
    implementationPlanOptionQuestion(questions)?.id ??
    questions[0]?.id ??
    null
  )
}

export function implementationPlanOptionQuestion(
  questions: ReturnType<typeof normalizeQuestions>,
): ReturnType<typeof normalizeQuestions>[number] | undefined {
  return questions.find((question) => {
    if (question.id.trim().toLowerCase() === 'implement') return true
    if (hasImplementationPlanText(question.question)) return true
    return question.options.some((option) =>
      hasImplementationPlanText(option.label),
    )
  })
}

function customDraftQuestionId(
  questions: ReturnType<typeof normalizeQuestions>,
  draftAnswers?: Record<string, string>,
): string | undefined {
  return questions.find(
    (question) =>
      question.allowCustom &&
      draftAnswers?.[question.id]?.trim() &&
      !question.options.some(
        (option) => option.value === draftAnswers[question.id],
      ),
  )?.id
}
