import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { waitForPromise, waitForValue } from './collaboration-cloud-story-checks.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  requestContainsToolOutput,
} from './response-protocol.mjs'

const roundSummary = '两个评论线程的处理结果已分别回复。'

export function createGuidedReplies({
  marker,
  firstQuestion,
  firstAnswer,
  secondQuestion,
  secondAnswer,
}) {
  const call = name => `${marker}-guided-${name}`
  const listCall = call('list')
  const answerA = call('answer-a')
  const answerB = call('answer-b')
  const readThreads = (rows, question) => rows.find(row => row.body === question)
  let enterFirstTurn
  let releaseList
  let releaseAnswerA
  const firstTurn = new Promise(resolve => {
    enterFirstTurn = resolve
  })
  const listAllowed = new Promise(resolve => {
    releaseList = resolve
  })
  const answerAAllowed = new Promise(resolve => {
    releaseAnswerA = resolve
  })
  let starts = 0

  function toolEvents(body, toolName, toolCallId, argumentsValue) {
    return mcpToolRequestEvents(body, {
      toolName,
      argumentsValue,
      searchCallId: `${toolCallId}-search`,
      toolCallId,
    }).events
  }

  return {
    get starts() {
      return starts
    },
    async modelEvents(body, requestText, scope, listComments) {
      if (!requestText.includes(firstQuestion)) return null
      if (requestContainsToolOutput(body, answerA)) {
        return [assistantMessage(roundSummary)]
      }
      if (!requestContainsToolOutput(body, listCall)) {
        if (!requestContainsToolOutput(body, `${listCall}-search`)) {
          starts += 1
          enterFirstTurn()
          await listAllowed
        }
        return toolEvents(body, 'list_board_item_comments', listCall, scope)
      }
      assert.ok(requestText.includes(secondQuestion), 'B 楼引导必须进入已在运行的 A 楼主会话')
      const rows = await listComments()
      const secondDone = requestContainsToolOutput(body, answerB)
      if (secondDone) await answerAAllowed
      const question = secondDone ? firstQuestion : secondQuestion
      const target = readThreads(rows, question)
      assert.ok(target?.id, `找不到待回复的评论：${question}`)
      return toolEvents(body, 'add_board_item_comment', secondDone ? answerA : answerB, {
        ...scope,
        reply_to_comment_id: target.id,
        body: secondDone ? firstAnswer : secondAnswer,
      })
    },
    async verify({ control, reply, firstCard, secondCard, executorLog, listComments, timeoutMs }) {
      const offset = (await readFile(executorLog, 'utf8')).length
      try {
        await reply(firstCard, firstQuestion)
        await waitForPromise(firstTurn, timeoutMs, 'A 楼回复没有启动原成员会话')
        await reply(secondCard, secondQuestion)
        await waitForValue(
          async () =>
            (await readFile(executorLog, 'utf8'))
              .slice(offset)
              .includes('runtime guidance accepted'),
          Boolean,
          'B 楼未被送入正在运行的主会话',
          timeoutMs
        )
        releaseList()
        const resultInThread = (rows, question, answer) => {
          const target = readThreads(rows, question)
          return (
            target &&
            rows.find(
              row =>
                row.body === answer &&
                row.reply_to_comment_id === target.id &&
                row.root_comment_id === target.root_comment_id
            )
          )
        }
        const afterB = await waitForValue(
          listComments,
          rows => resultInThread(rows, secondQuestion, secondAnswer) && rows,
          'B 楼回复未在 A 楼结束前回到 B 楼',
          timeoutMs
        )
        assert.ok(!afterB.some(row => row.body === firstAnswer), 'A 楼应保持单独的处理进度')
        releaseAnswerA()
        await waitForValue(
          listComments,
          rows => resultInThread(rows, firstQuestion, firstAnswer),
          'A 楼回复没有回到 A 楼',
          timeoutMs
        )
        await waitForValue(
          listComments,
          rows => rows.find(row => row.body === roundSummary && !row.reply_to_comment_id),
          '未指定楼层的总结没有发到 Issue 主讨论',
          timeoutMs
        )
        for (const [card, text] of [
          [firstCard, firstAnswer],
          [secondCard, secondAnswer],
        ]) {
          await control.command('waitFor', `[data-testid="${card}"]`, { text, timeoutMs })
        }
      } finally {
        releaseList()
        releaseAnswerA()
      }
    },
  }
}
