import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { waitForPromise, waitForValue } from './collaboration-cloud-story-checks.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  selectedToolCall,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

const roundSummary = '两个评论线程的处理结果已分别回复。'

function guidedToolResult(body, callId) {
  let outputId = callId
  for (let waitIndex = 1; requestContainsToolOutput(body, outputId); waitIndex += 1) {
    const cellId = toolOutputText(body, outputId)?.match(/^Script running with cell ID (\S+)/)?.[1]
    if (!cellId) return { complete: true }
    outputId = `${callId}-wait-${waitIndex}`
    if (!requestContainsToolOutput(body, outputId)) {
      const wait = selectTool(body, 'wait', { cell_id: cellId, yield_time_ms: 1000 })
      return { complete: false, events: selectedToolCall(outputId, wait) }
    }
  }
  return { complete: false }
}

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
  let nativeTurns = 0

  function toolEvents(body, toolName, toolCallId, argumentsValue) {
    return mcpToolRequestEvents(body, {
      toolName,
      argumentsValue,
      searchCallId: `${toolCallId}-search`,
      toolCallId,
    }).events
  }

  return {
    get nativeTurns() {
      return nativeTurns
    },
    async modelEvents(body, requestText, scope, listComments) {
      if (!requestText.includes(firstQuestion)) return null
      const completedAnswer = guidedToolResult(body, answerA)
      if (completedAnswer.events) return completedAnswer.events
      if (completedAnswer.complete) {
        return [assistantMessage(roundSummary)]
      }
      const list = guidedToolResult(body, listCall)
      if (list.events) return list.events
      if (!list.complete) {
        const search = guidedToolResult(body, `${listCall}-search`)
        if (search.events) return search.events
        if (!search.complete) {
          enterFirstTurn()
          await listAllowed
        }
        return toolEvents(body, 'list_board_item_comments', listCall, scope)
      }
      assert.ok(requestText.includes(secondQuestion), 'B 楼引导必须进入已在运行的 A 楼主会话')
      const second = guidedToolResult(body, answerB)
      if (second.events) return second.events
      const rows = await listComments()
      const secondDone = second.complete
      if (secondDone) await answerAAllowed
      const question = secondDone ? firstQuestion : secondQuestion
      const target = readThreads(rows, question)
      assert.ok(target?.id, `找不到待回复的评论：${question}`)
      const replyCall = secondDone ? answerA : answerB
      const search = guidedToolResult(body, `${replyCall}-search`)
      if (search.events) return search.events
      return toolEvents(body, 'add_board_item_comment', replyCall, {
        ...scope,
        reply_to_comment_id: target.id,
        body: secondDone ? firstAnswer : secondAnswer,
      })
    },
    async verifyPublishedSummary(control, activity, listComments, timeoutMs) {
      const rows = (await listComments()).filter(row => row.body === roundSummary)
      assert.equal(rows.length, 1, '主讨论总结与执行状态重复发布')
      assert.ok(!rows[0].reply_to_comment_id, '总结应发布在 Issue 主讨论')
      await control.command('waitFor', activity, { text: roundSummary, timeoutMs })
      const timeline = await control.command('getText', activity)
      assert.equal(timeline.split(roundSummary).length - 1, 1, 'Issue 界面显示了重复总结')
    },
    async verify({
      control,
      reply,
      firstCard,
      secondCard,
      executorLog,
      memberTaskId,
      listComments,
      timeoutMs,
    }) {
      const offset = (await readFile(executorLog, 'utf8')).length
      try {
        await reply(firstCard, firstQuestion)
        await waitForPromise(firstTurn, timeoutMs, 'A 楼回复没有启动原成员会话')
        await reply(secondCard, secondQuestion)
        const taskRecords = async () =>
          (await readFile(executorLog, 'utf8'))
            .slice(offset)
            .split('\n')
            .filter(line => line.includes(`local_task_id=${memberTaskId} `))
        const guidance = await waitForValue(
          taskRecords,
          lines => lines.find(line => line.includes('runtime guidance accepted')),
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
        const records = await waitForValue(
          taskRecords,
          lines => lines.some(line => line.includes('method=turn/completed ')) && lines,
          '原成员会话没有完成当前回合',
          timeoutMs
        )
        const turns = records.filter(line => line.includes('method=turn/started '))
        nativeTurns = turns.length
        assert.equal(nativeTurns, 1, '两个评论发起了多个主会话轮次')
        const guidedTurn = guidance.match(/(?:^| )turn_id=(\S+)/)?.[1]
        assert.ok(guidedTurn, '原生引导没有返回回合 ID')
        assert.equal(turns[0].match(/(?:^| )turn_id=(\S+)/)?.[1], guidedTurn)
        for (const [card, text] of [
          [firstCard, firstAnswer],
          [secondCard, secondAnswer],
        ]) {
          await control.command('waitFor', `[data-testid="${card}"]`, { text, timeoutMs })
        }
        const secondRoot = secondCard.slice('cloud-task-activity-card-'.length)
        const secondReplies = await control.command(
          'getText',
          `[data-testid="cloud-task-activity-replies-${secondRoot}"]`
        )
        assert.ok(!secondReplies.includes('已完成'), 'B 楼的引导回执不应显示成一条已完成执行')
      } finally {
        releaseList()
        releaseAnswerA()
      }
    },
  }
}
