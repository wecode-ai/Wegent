import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  modelMessageText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectedToolCall,
} from './response-protocol.mjs'
import { STORY_CHAT, STORY_USER, storyUntil } from './stand-in-source-story-evidence.mjs'

const TITLE = '我的工作素材和决策记录'
const RECORD = '工作素材附录\n'
const WEEKLY_TITLE = '周五 AI 会话复盘'
const WEEKLY_WORK = '复盘本周一至运行时刻的原始 AI 会话并引用证据'
const KNOWLEDGE_ROLE = 'welcome-personal-knowledge'
const KNOWLEDGE_NAME = '个人知识助理'
const KNOWLEDGE_QUESTION = '请确认知识归档的会话范围、本地目录和运行时间。'
const KNOWLEDGE_CONFIGURE = '归档我的工作素材和决策记录'
const KNOWLEDGE_ARRANGE = '请给个人知识助理安排这个归档计划'
const KNOWLEDGE_WORK = '读取得到授权的工作素材并保存可复用知识'
const KEEP_NOTE = '# 发布复盘\n\n我的手写记录：保留这行。\n'
const WEEKLY_RESULT = '下周 AI 改进建议'
const assistant = `${STORY_CHAT} [data-testid="message-assistant"]`
const send = `${STORY_CHAT} [data-testid="send-message-button"]`

const materials = {
  brief: {
    first: '给周宁确认采购报价',
    deadline: '今天 15:00',
    second: '把评审意见发给小杨',
    third: '回复客户的上线时间',
    conflict: '日历 14:00 / 聊天 14:30',
    resolved: '已归档的旧报价',
  },
  recap: {
    action: '周宁补发回滚演练记录',
    time: '周四 18:00',
    unresolved: '小杨下周查看客户通知',
    proposal: '切换发布工具只是会上建议',
    dependency: '通知要等演练完成',
  },
  launch: {
    blocker: '迁移回放失败，周宁今晚 20:00 前确认',
    rollback: '小杨负责回滚',
    customer: '客户通知未确认',
    deferred: '更新辅助文档可在上线后做',
    conflict: '清单标通过，回归报告标失败',
  },
  handoff: {
    due: '周二前把发版说明给客户成功',
    owner: '小林可直接跟进验收',
    decision: '休假前先确认回滚负责人',
    sources: '发布清单第 3 节',
  },
  weekly: {
    launch: '完成首轮发布回归',
    customer: '交付客户二期测试包',
    hiring: '完成两位候选人的初筛',
    blocker: '采购等周宁提供新报价',
    next: '下周完成迁移演练、客户回访和候选人复试',
  },
  reply: {
    confirmed: '当前确认月底交付',
    requested: '客户问能否提前到下周三',
    scope: '范围为验收包和部署文档',
    missing: '提前日期、额外费用和资源还未确认',
  },
  decision: {
    decided: '把通知入口放到工具栏右侧',
    quote: '最终决定：用右侧入口，下个版本上',
    preference: '把搜索也挪过去目前只有两个人同意',
    owner: '请小杨确认键盘焦点顺序',
  },
}

const report = {
  brief: data =>
    `今天优先：${data.first}（${data.deadline}）、${data.second}、${data.third}。开会时间冲突：${data.conflict}，请你确认。稍后可看：${data.resolved}。`,
  recap: data =>
    `行动：${data.action}，截止${data.time}。${data.unresolved}（日期待确认）。${data.proposal}。依赖：${data.dependency}。转发草稿：请各位核对负责人、截止和依赖。`,
  launch: data =>
    `发布阻塞：${data.blocker}。${data.conflict}。${data.rollback}，${data.customer}。可延后：${data.deferred}。请先确认迁移结果再决定是否发布。`,
  handoff: data =>
    `交接给小林：${data.due}，${data.owner}。我须先决定：${data.decision}。资料：${data.sources}。请先核对这份交接草稿。`,
  weekly: data =>
    `本周结果：${data.launch}、${data.customer}、${data.hiring}。卡点：${data.blocker}。${data.next}。`,
  reply: data =>
    `草稿：收到你希望下周三交付的请求。${data.confirmed}，${data.scope}。我会核对能否提前后再回复。发出前请确认：${data.missing}。原始请求：${data.requested}。`,
  decision: data =>
    `已决定：${data.decided}（原话「${data.quote}」）。仍只是倾向：${data.preference}。下一步：${data.owner}。`,
}

/** The renderer, transcript reads and delivery are real. Only inference is scripted. */
export function createWelcomeMaterialStories(options, examples) {
  const sourceTaskId = `welcome-materials-${process.pid}`
  const diskFixture = join(options.workspacePath, 'disk-space-sample')
  let active = false
  let current
  let outcome
  let weeklySchedule
  let knowledgeSchedule
  const notes = join(options.workspacePath, 'release-knowledge.md')
  const has = requestContainsToolOutput
  const call = (body, id, name, args, server = 'wework_stand_in') =>
    mcpToolRequestEvents(body, {
      toolName: name,
      directToolName: `mcp__${server}__${name}`,
      argumentsValue: args,
      searchCallId: `${id}-search`,
      toolCallId: id,
    }).events

  function diskReport(body) {
    const id = 'welcome-disk-space-measure'
    if (!has(body, id)) {
      const script = `
        const fs = require('node:fs')
        const path = require('node:path')
        const directory = ${JSON.stringify(diskFixture)}
        const disk = fs.statfsSync(directory)
        const rows = fs.readdirSync(directory).map(name => {
          const info = fs.statSync(path.join(directory, name))
          return { name, bytes: info.size, allocated: info.blocks * 512 }
        }).sort((a, b) => b.allocated - a.allocated || b.bytes - a.bytes)
        console.log('DISK_RESULT:' + JSON.stringify({
          total: disk.blocks * disk.bsize,
          available: disk.bavail * disk.bsize,
          used: Math.round((1 - disk.bfree / disk.blocks) * 100),
          rows,
        }))
      `
      const encoded = Buffer.from(script).toString('base64')
      const command = `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`
      return selectedToolCall(id, selectShellToolCommand(body, command, options.workspacePath))
    }
    const text = readMcpToolOutput(body, id)
    const measurement = text.match(/DISK_RESULT:([^\r\n]+)/)
    assert.ok(measurement, 'The report needs actual filesystem measurements')
    const result = JSON.parse(measurement[1])
    assert.ok(result.total > 0 && result.available >= 0 && result.available <= result.total)
    assert.ok(result.used >= 0 && result.used <= 100)
    assert.deepEqual(
      result.rows.map(file => [file.name, file.bytes]),
      [
        ['video-export.bin', 262144],
        ['notes.bin', 8192],
      ]
    )
    outcome = `磁盘容量 ${result.total} 字节，可用 ${result.available} 字节，已用 ${result.used}%。检查目录：${diskFixture}。优先检查 ${result.rows.map(file => `${file.name}（${file.bytes} 字节，占用 ${file.allocated} 字节）`).join('、')}。范围限于测试目录。`
    return [assistantMessage(outcome)]
  }

  function proposeKnowledge(body) {
    if (!has(body, 'welcome-knowledge-profile'))
      return call(body, 'welcome-knowledge-profile', 'get_profile', {})
    if (!has(body, 'welcome-knowledge-example'))
      return call(body, 'welcome-knowledge-example', 'read_task', {
        taskId: sourceTaskId,
        limit: 10,
      })
    const source = JSON.parse(readMcpToolOutput(body, 'welcome-knowledge-example'))
    assert.ok(source.messages.some(message => message.content?.includes(materials.launch.rollback)))
    if (!has(body, 'welcome-knowledge-proposal')) {
      const profile = JSON.parse(readMcpToolOutput(body, 'welcome-knowledge-profile'))
      return call(body, 'welcome-knowledge-proposal', 'propose_profile', {
        summary: '创建个人知识助理。样例：把核对回滚负责人写入发布复盘，保留原手写笔记。',
        settings: {
          ...profile,
          roles: [
            ...profile.roles,
            {
              id: KNOWLEDGE_ROLE,
              name: KNOWLEDGE_NAME,
              enabled: true,
              version: 0,
              executionDeviceId: profile.executionDeviceId,
              model: profile.primary.model,
              workspace: {
                projectKey: 'welcome-knowledge-workspace',
                executionMode: 'current_workspace',
                workspacePath: options.workspacePath,
              },
              prompt: `只整理已授权的《${TITLE}》，更新 ${notes} 并保留手写记录。`,
              collaboration: {
                enabled: false,
                allProjects: false,
                projects: [],
                excludedProjects: [],
                tags: [],
              },
            },
          ],
        },
      })
    }
    return [assistantMessage('请核对知识助理的归档范围和样例。')]
  }

  function arrangeKnowledge(body) {
    const id = 'welcome-knowledge-schedule'
    if (!has(body, id))
      return call(body, id, 'schedule_task', {
        requestId: 'welcome-knowledge-archive',
        title: '每周归档个人知识',
        roleId: KNOWLEDGE_ROLE,
        historyTaskIds: [sourceTaskId],
        message: `${KNOWLEDGE_WORK}到 ${notes}，保留现有笔记。授权会话《${TITLE}》。`,
        cron: '0 18 * * 3',
        timezone: 'Asia/Shanghai',
      })
    knowledgeSchedule = JSON.parse(readMcpToolOutput(body, id)).automation
    assert.ok(knowledgeSchedule?.id)
    return [assistantMessage('已安排个人知识助理每周三 18:00 归档。')]
  }

  function runKnowledge(body) {
    const readId = 'welcome-knowledge-read-conversation'
    const writeId = 'welcome-knowledge-write-file'
    if (!has(body, readId)) {
      return call(body, readId, 'read_task', { taskId: sourceTaskId, limit: 10 })
    }
    const source = readMcpToolOutput(body, readId)
    assert.ok(
      source.includes(materials.launch.rollback),
      'Use the actual source history in the archive'
    )
    if (!has(body, writeId)) {
      const entry = `\n## 回滚准备\n\n${materials.launch.rollback}。来源：《${TITLE}》。\n`
      const script =
        'require("node:fs").appendFileSync(' +
        JSON.stringify(notes) +
        ', ' +
        JSON.stringify(entry) +
        '); console.log("KNOWLEDGE_SAVED")'
      const encoded = Buffer.from(script).toString('base64')
      return selectedToolCall(
        writeId,
        selectShellToolCommand(
          body,
          `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`,
          options.workspacePath
        )
      )
    }
    assert.ok(readMcpToolOutput(body, writeId).includes('KNOWLEDGE_SAVED'))
    return [assistantMessage('已把回滚准备归档到 release-knowledge.md，原手写记录已保留。')]
  }

  function scheduleWeeklyReview(body) {
    const id = 'welcome-weekly-create'
    if (!has(body, id)) {
      return call(body, id, 'schedule_task', {
        requestId: 'welcome-friday-ai-review',
        title: WEEKLY_TITLE,
        message: WEEKLY_WORK,
        cron: '0 16 * * 5',
        timezone: 'Asia/Shanghai',
        template: 'weekly_review',
      })
    }
    weeklySchedule = JSON.parse(readMcpToolOutput(body, id)).automation
    assert.ok(weeklySchedule?.id, 'The native schedule must be saved')
    return [assistantMessage('已安排每周五 16:00 的 AI 会话复盘。')]
  }

  function runWeeklyReview(body) {
    const id = 'welcome-weekly-run-read'
    if (!has(body, id)) return call(body, id, 'read_task', { taskId: sourceTaskId, limit: 10 })
    const history = JSON.parse(readMcpToolOutput(body, id))
    assert.equal(history.taskId, sourceTaskId)
    const source = history.messages.find(
      item => item.role === 'user' && item.content.startsWith(RECORD)
    )
    assert.ok(source && source.contentComplete !== false)
    const record = JSON.parse(source.content.slice(RECORD.length))
    return [
      assistantMessage(
        `${WEEKLY_RESULT}。来源：《${history.title ?? TITLE}》。1. 针对「${record.recap.action}」试用固定行动清单，对比遗漏数。2. 针对「${record.launch.conflict}」先让 AI 对照来源，对比返工轮数。3. 针对「${record.reply.missing}」用发出前核对表，对比没有依据的承诺数。`
      ),
    ]
  }

  return {
    get active() {
      return active
    },
    async handleHttp(req, response, url) {
      if (
        !active ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const text = modelMessageText(body.input?.filter(item => item.role === 'user').at(-1))
      let events
      if (current === 'knowledge' && text === examples.knowledge.prompt) {
        events = [assistantMessage(KNOWLEDGE_QUESTION)]
      } else if (current === 'knowledge' && text.includes(KNOWLEDGE_CONFIGURE)) {
        events = proposeKnowledge(body)
      } else if (current === 'knowledge' && text === KNOWLEDGE_ARRANGE) {
        events = arrangeKnowledge(body)
      } else if (current === 'knowledge' && text.includes(KNOWLEDGE_WORK)) {
        events = runKnowledge(body)
      } else if (current === 'knowledge' && text.startsWith('Wework delegated task result:')) {
        events = delegatedTaskResultEvents(body)
      } else if (current === 'weekly_review' && text.startsWith('Wework delegated task result:')) {
        events = delegatedTaskResultEvents(body)
      } else if (current === 'weekly_review' && text === examples.weekly_review.prompt) {
        events = scheduleWeeklyReview(body)
      } else if (current === 'weekly_review' && text.includes(WEEKLY_WORK)) {
        events = runWeeklyReview(body)
      } else if (text.startsWith(RECORD)) events = [assistantMessage('工作素材已记录。')]
      else if (current === 'disk_space' && text === examples.disk_space.prompt) {
        events = diskReport(body)
      } else if (current && text === examples[current].prompt) {
        const find = `welcome-${current}-find`
        const read = `welcome-${current}-read`
        if (!has(body, find)) {
          events = call(body, find, 'list_tasks', { limit: 50 })
        } else {
          const list = JSON.parse(readMcpToolOutput(body, find))
          assert.ok(list.items.some(item => item.title === TITLE && item.taskId === sourceTaskId))
          if (!has(body, read)) {
            events = call(body, read, 'read_task', { taskId: sourceTaskId, limit: 10 })
          } else {
            const history = JSON.parse(readMcpToolOutput(body, read))
            assert.equal(history.taskId, sourceTaskId)
            const source = history.messages.find(
              item => item.role === 'user' && item.content.startsWith(RECORD)
            )
            assert.ok(
              source && source.contentComplete !== false,
              'Read the original material in full'
            )
            const record = JSON.parse(source.content.slice(RECORD.length))
            outcome = `${report[current](record[current])} 来源：《${history.title ?? TITLE}》。`
            events = [assistantMessage(outcome)]
          }
        }
      } else return false
      const id = `welcome-materials-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, model, openExample) {
      const rpc = (method, params) => options.rpc(control, method, params)
      const prompt = RECORD + JSON.stringify(materials)
      active = true
      try {
        const accepted = await rpc('runtime.tasks.create', {
          taskId: sourceTaskId,
          title: TITLE,
          message: prompt,
          workspacePath: options.workspacePath,
          modelSelection: {
            modelName: model.local_model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: model.provider },
          },
          executionRequest: {
            task_id: sourceTaskId,
            subtask_id: 'welcome-materials',
            new_session: true,
            bot: [{ shell_type: 'Codex', name: TITLE }],
            model_config: { model_id: model.local_model_id, model_provider: model.provider },
            user_id: STORY_USER,
            prompt,
          },
        })
        assert.equal(accepted.success, true)
        await storyUntil(
          () => rpc('runtime.tasks.get', { taskId: sourceTaskId }),
          task => task.task?.status === 'done',
          options.modelResponseTimeoutMs,
          'Record the owner’s material before using conversation templates'
        )
        await mkdir(diskFixture)
        await writeFile(join(diskFixture, 'video-export.bin'), Buffer.alloc(262144, 7))
        await writeFile(join(diskFixture, 'notes.bin'), Buffer.alloc(8192, 9))
        current = 'disk_space'
        await openExample(control, current)
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', assistant, {
          text: 'video-export.bin（262144 字节',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.ok(outcome?.includes('磁盘容量'))
        assert.equal((await stat(join(diskFixture, 'video-export.bin'))).size, 262144)
        assert.equal((await stat(join(diskFixture, 'notes.bin'))).size, 8192)
        console.info(
          '[assistant-home-story] disk_space: original template and read-only disk report'
        )
        for (const id of Object.keys(materials)) {
          current = id
          outcome = undefined
          await openExample(control, id)
          await control.command('clickWhenEnabled', send)
          const expected = report[id](materials[id])
          await control.command('waitFor', assistant, {
            text: expected,
            timeoutMs: options.modelResponseTimeoutMs,
          })
          assert.equal(outcome, `${expected} 来源：《${TITLE}》。`)
          console.info(
            `[assistant-home-story] ${id}: original template, native source read, delivered result`
          )
        }
        current = 'weekly_review'
        await openExample(control, current)
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', assistant, {
          text: '已安排每周五 16:00 的 AI 会话复盘',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(weeklySchedule.schedule.expression, '0 16 * * 5')
        assert.equal(weeklySchedule.taskRequest.standInCalendar.template, 'weekly_review')
        const started = await rpc('runtime.automations.run_now', {
          automationId: weeklySchedule.id,
        })
        assert.ok(started.run?.id)
        const run = await storyUntil(
          async () =>
            (
              await rpc('runtime.automation_runs.list', { automationId: weeklySchedule.id })
            ).items.find(item => item.id === started.run.id),
          item => item?.status === 'succeeded',
          options.modelResponseTimeoutMs,
          'The immediately triggered review must complete'
        )
        assert.ok(run.taskId)
        await control.command('waitFor', assistant, {
          text: WEEKLY_RESULT,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const task = await rpc('runtime.tasks.transcript', { taskId: run.taskId, limit: 20 })
        assert.ok(
          task.messages.some(
            item => item.role === 'assistant' && item.content?.includes(WEEKLY_RESULT)
          )
        )
        console.info(
          '[assistant-home-story] weekly_review: Friday schedule, Run now, private report'
        )
        current = 'knowledge'
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({
            projectKey: 'welcome-knowledge-workspace',
            name: '知识归档验证',
            path: options.workspacePath,
          }),
        })
        await writeFile(notes, KEEP_NOTE)
        await openExample(control, current)
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', assistant, {
          text: KNOWLEDGE_QUESTION,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const input = `${STORY_CHAT} [data-testid="chat-message-input"]`
        await control.command('fill', input, {
          value: `${KNOWLEDGE_CONFIGURE}，写到 ${notes}，每周三 18:00，Asia/Shanghai。`,
        })
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', '[data-testid="stand-in-proposal"]', {
          text: KNOWLEDGE_NAME,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-accept"]')
        await control.command('waitFor', '[data-testid="stand-in-proposal-result"]')
        await control.command('fill', input, { value: KNOWLEDGE_ARRANGE })
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', assistant, {
          text: '已安排个人知识助理每周三 18:00 归档',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(knowledgeSchedule.taskRequest.standInOwner.roleId, KNOWLEDGE_ROLE)
        const archive = await rpc('runtime.automations.run_now', {
          automationId: knowledgeSchedule.id,
        })
        assert.ok(archive.run?.id)
        await storyUntil(
          async () =>
            (
              await rpc('runtime.automation_runs.list', { automationId: knowledgeSchedule.id })
            ).items.find(item => item.id === archive.run.id),
          item => item?.status === 'succeeded',
          options.modelResponseTimeoutMs,
          'The knowledge role must finish the manual run'
        )
        const note = await readFile(notes, 'utf8')
        assert.ok(note.startsWith(KEEP_NOTE) && note.includes(materials.launch.rollback))
        console.info(
          '[assistant-home-story] knowledge: role proposal, Run now, actual Markdown update'
        )
      } finally {
        active = false
        if (knowledgeSchedule)
          await rpc('runtime.automations.delete', { automationId: knowledgeSchedule.id })
        if (weeklySchedule)
          await rpc('runtime.automations.delete', { automationId: weeklySchedule.id })
      }
    },
  }
}
