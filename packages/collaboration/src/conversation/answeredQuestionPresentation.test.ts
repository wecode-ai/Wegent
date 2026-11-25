import type { ProcessingBlock, WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import {
  resolveAsyncRequestUserInputAnswers,
  resolveAsyncRequestUserInputReplies,
  type RequestUserInputBlock,
} from '@wegent/chat-core/runtime-user-input'
import { expect, test } from 'vitest'
import { hideAnsweredQuestionSummaries } from './answeredQuestionPresentation'

function question(id: string, answered = true): RequestUserInputBlock {
  return {
    id,
    type: 'tool',
    subtaskId: 'turn',
    toolName: 'request_user_input',
    status: answered ? 'done' : 'pending',
    createdAt: 1,
    renderPayload: {
      kind: 'request_user_input',
      itemId: id,
      questions: [{ id: 'scope', question: 'Which project?' }],
      ...(answered ? { response: { itemId: id, answers: { scope: { answers: ['Local'] } } } } : {}),
    },
  }
}

function assistant(
  id: string,
  content = '',
  blocks: ProcessingBlock[] = [],
  turnId = 'turn'
): WorkbenchMessage {
  return { id, role: 'assistant', status: 'done', createdAt: '', content, blocks, turnId }
}

test('hides only answered questions followed by a result in their own turn', () => {
  const answered = question('answered')
  const pending = question('pending', false)
  const approval = question('approval')
  approval.renderPayload.interactionKind = 'approval'
  const message = assistant('questions', '', [answered, pending, approval])
  const source = [assistant('ack', 'I will check'), message]
  expect(hideAnsweredQuestionSummaries(source)[1]).toBe(message)
  expect(
    hideAnsweredQuestionSummaries([
      ...source,
      assistant('unrelated', 'Other reply', [], 'other'),
    ])[1]
  ).toBe(message)

  const result = assistant('result', 'Here is the outcome')
  const visible = hideAnsweredQuestionSummaries([...source, result])
  expect(visible[1].blocks).toEqual([pending, approval])
  expect(visible[2]).toBe(result)
  expect(message.blocks).toEqual([answered, pending, approval])
})

test('honors the order of text and questions in a single assistant message', () => {
  const answered = question('answered')
  const text = { type: 'assistant_text' as const, id: 'text', content: 'A reply' }
  const block = { type: 'block' as const, id: answered.id }
  const message = {
    ...assistant('mixed', text.content, [answered]),
    runtimeDisplayItems: [text, block],
  }
  expect(hideAnsweredQuestionSummaries([message])[0]).toBe(message)
  expect(
    hideAnsweredQuestionSummaries([{ ...message, runtimeDisplayItems: [block, text] }])[0]
  ).toMatchObject({ blocks: [], runtimeDisplayItems: [text], content: text.content })
})

test('preserves the async answer pairing while hiding the redundant summary after a later turn', () => {
  const asyncQuestion = question('async', false)
  asyncQuestion.renderPayload.delivery = 'async'
  const response: WorkbenchMessage = {
    id: 'answer',
    role: 'user',
    content: 'Local',
    createdAt: '',
    status: 'done',
    turnId: 'next',
  }
  const commentary = assistant('commentary', 'I will wait for your answer')
  const beforeResult = [assistant('question', '', [asyncQuestion]), commentary, response]
  const resolved = resolveAsyncRequestUserInputAnswers(beforeResult)
  expect(resolved[0].blocks?.[0]).toMatchObject({ status: 'done' })
  expect(hideAnsweredQuestionSummaries(resolved)[0]).toBe(resolved[0])
  expect(hideAnsweredQuestionSummaries([resolved[0], commentary])[0]).toBe(resolved[0])
  const unrelated = resolveAsyncRequestUserInputAnswers([
    ...beforeResult,
    assistant('other', 'Unrelated result', [], 'other'),
  ])
  expect(hideAnsweredQuestionSummaries(unrelated)[0]).toBe(unrelated[0])
  const source = [...beforeResult, assistant('result', 'Finished', [], 'next')]
  const visible = hideAnsweredQuestionSummaries(resolveAsyncRequestUserInputAnswers(source))
  expect(visible[0].blocks).toEqual([])
  expect(visible[2]).toBe(response)
  expect(resolveAsyncRequestUserInputReplies(source).get(response.id)).toEqual([
    { question: 'Which project?', answer: 'Local' },
  ])
})

test('recognizes completed image-only results in their original order', () => {
  const answered = question('answered')
  const image: ProcessingBlock = {
    id: 'image',
    type: 'tool',
    subtaskId: 'turn',
    toolName: 'image_generation',
    status: 'done',
    createdAt: 1,
    renderPayload: {
      kind: 'image_generation',
      source: {
        type: 'workspace_file',
        deviceId: 'device',
        workspacePath: 'workspace',
        path: 'image.png',
      },
    },
  }
  const questionMessage = assistant('question', '', [answered])
  expect(
    hideAnsweredQuestionSummaries([questionMessage, assistant('result', '', [image])])[0].blocks
  ).toEqual([])
  const beforeQuestion = assistant('mixed', '', [image, answered])
  expect(hideAnsweredQuestionSummaries([beforeQuestion])[0]).toBe(beforeQuestion)
  expect(
    hideAnsweredQuestionSummaries([assistant('mixed', '', [answered, image])])[0].blocks
  ).toEqual([image])
})
