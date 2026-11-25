import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const TEAM = '周报团队'
const RELEASE_TEAM = '发布团队'
const STORIES = [
  { name: TEAM, duty: '核对周报指标', reply: '周报指标由数据助理核对。' },
  { name: RELEASE_TEAM, duty: '核对发布指标', reply: '发布指标由数据助理核对。' },
].map(story => ({ ...story, request: `请查看${story.name}的分工。` }))
const FOLLOWUP = {
  ...STORIES[1],
  request: '请再确认发布团队的分工。',
  reply: '已再次确认，数据助理仍负责核对发布指标。',
}
const OVERVIEW = '[data-testid="stand-in-overview"]'
const CHAT = `${OVERVIEW} [data-testid="stand-in-conversation"]`
const testId = id => `[data-testid="${id}"]`

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, modelResponseTimeoutMs }) {
  let sequence = 0
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      const latest = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const story = [...STORIES, FOLLOWUP].find(entry =>
        JSON.stringify(latest ?? '').includes(entry.request)
      )
      if (!story) return false
      const directory =
        story === FOLLOWUP
          ? 'release-follow-up'
          : story === STORIES[0]
            ? 'weekly-directory'
            : 'release-directory'
      let events
      if (requestContainsToolOutput(body, directory)) {
        const { roles } = JSON.parse(readMcpToolOutput(body, directory))
        assert.deepEqual(
          roles.map(role => [role.id, role.teamDuty]),
          [['data', story.duty]]
        )
        events = [assistantMessage(story.reply)]
      } else {
        events = mcpToolRequestEvents(body, {
          toolName: 'list_delegate_roles',
          directToolName: 'mcp__wework_stand_in__list_delegate_roles',
          argumentsValue: {},
          searchCallId: `${directory}-discovery`,
          toolCallId: directory,
        }).events
      }
      const id = `assistant-team-${++sequence}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const read = () => rpc('runtime.stand_in.personal.get', { userId: USER })
      const before = await read()
      const catalog = await rpc('runtime.runner.catalog', {})
      const selected = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(selected, 'Team conversation needs a configured Codex model')
      const model = {
        runtime: selected.runtime,
        provider: selected.provider,
        model_id: selected.model_id,
      }
      const roles = [
        { id: 'data', name: '数据助理' },
        { id: 'outside', name: '公告助理' },
      ].map(role => ({
        ...role,
        enabled: true,
        prompt: '',
        model,
        executionDeviceId: before.executionDeviceId,
        collaboration: {
          enabled: false,
          allProjects: false,
          projects: [],
          excludedProjects: [],
          tags: [],
        },
      }))
      await rpc('runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...before,
          primary: { ...before.primary, enabled: true, prompt: '', preferences: '', model },
          roles,
        },
      })
      const click = id =>
        control.command('clickWhenEnabled', testId(id), { timeoutMs: uiTimeoutMs })
      const fill = (id, value) =>
        control.command('fill', testId(id), { value, timeoutMs: uiTimeoutMs })
      await click('personal-stand-in-button')
      await click('stand-in-teams-open')

      for (const { name, duty } of STORIES) {
        await click('stand-in-team-create')
        await fill('stand-in-team-name', name)
        await click('stand-in-team-member-data')
        await fill('stand-in-team-duty-data', duty)
        if (name === TEAM) {
          await click('stand-in-teams-dialog-close')
          await control.command('waitFor', testId('stand-in-team-keep-editing'), {
            timeoutMs: uiTimeoutMs,
          })
          await captureScreenshot(control, '01a-confirm-discard.png')
          await click('stand-in-team-keep-editing')
          assert.equal(await control.command('getValue', testId('stand-in-team-name')), name)
          assert.equal(await control.command('getValue', testId('stand-in-team-duty-data')), duty)
          await captureScreenshot(
            control,
            '01-create-assistant-team.png',
            testId('stand-in-teams-dialog')
          )
        }
        await click('stand-in-team-save')
        const { teams } = await readAfterTeamSave(control, read, name, uiTimeoutMs)
        assert.equal(teams.find(team => team.name === name).members.data, duty)
      }
      const beforeDiscard = await read()
      await click('stand-in-team-create')
      await fill('stand-in-team-name', '将放弃的团队')
      await click('stand-in-team-edit-cancel')
      await click('stand-in-team-discard')
      const afterDiscard = await readAfterTeamSave(control, read, TEAM, uiTimeoutMs)
      assert.deepEqual(
        afterDiscard.teams,
        beforeDiscard.teams,
        'Discarding must leave saved teams unchanged'
      )

      await captureScreenshot(
        control,
        '02-two-assistant-teams.png',
        testId('stand-in-teams-dialog')
      )
      const saved = await read()
      assert.equal(saved.roles.filter(role => role.id === 'data').length, 1)
      const team = saved.teams.find(team => team.name === TEAM)
      const openTeam = async name => {
        const selected = saved.teams.find(team => team.name === name)
        assert.ok(selected, `Missing saved team ${name}`)
        await click(`stand-in-team-open-${selected.id}`)
      }
      const assistantMessages = `${CHAT} ${testId('assistant-message-content')}`
      const waitForReply = reply =>
        control.command('waitFor', assistantMessages, {
          text: reply,
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
      const send = async story => {
        await control.command(
          'fill',
          `${CHAT} ${testId('chat-message-input')}[contenteditable="true"]`,
          { value: story.request, timeoutMs: uiTimeoutMs }
        )
        await control.command('clickWhenEnabled', `${CHAT} ${testId('send-message-button')}`)
        return waitForReply(story.reply)
      }
      for (const [index, story] of STORIES.entries()) {
        await openTeam(story.name)
        const transcript = await send(story)
        assert.ok(
          STORIES.every(other => other === story || !transcript.includes(other.reply)),
          `${story.name} must only show its own conversation`
        )
        await control.command('waitFor', testId('stand-in-role-help'), {
          text: story.name,
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, `03-${index + 1}-team-conversation.png`, OVERVIEW)
        await click('stand-in-teams-open')
      }
      await openTeam(TEAM)
      const reopened = await waitForReply(STORIES[0].reply)
      assert.ok(
        !reopened.includes(STORIES[1].reply),
        'Reopening must restore only the selected team'
      )
      await click('stand-in-teams-open')
      await click(`stand-in-team-edit-${team.id}`)
      await fill('stand-in-team-duty-data', '核对周报同比指标')
      await click('stand-in-team-save')
      const edited = await readAfterTeamSave(control, read, TEAM, uiTimeoutMs)
      assert.equal(edited.teams.find(row => row.id === team.id).members.data, '核对周报同比指标')
      const release = edited.teams.find(row => row.name === RELEASE_TEAM)
      assert.equal(release.members.data, '核对发布指标')
      await click(`stand-in-team-remove-${team.id}`)
      await captureScreenshot(
        control,
        '04-delete-team-confirmation.png',
        testId('stand-in-teams-dialog')
      )
      await click('stand-in-team-remove-confirm')
      const remaining = await readAfterTeamSave(control, read, release.name, uiTimeoutMs)
      assert.deepEqual(
        remaining.teams.map(row => row.id),
        [release.id]
      )
      assert.ok(
        remaining.roles.some(role => role.id === 'data'),
        'Deleting a team must keep its assistants'
      )
      await captureScreenshot(control, '05-remaining-team.png', testId('stand-in-teams-dialog'))
      await openTeam(RELEASE_TEAM)
      await waitForReply(STORIES[1].reply)
      await send(FOLLOWUP)
      await waitForReply(STORIES[1].reply)
      await control.command('waitFor', testId('stand-in-role-help'), {
        text: RELEASE_TEAM,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, '06-remaining-team-conversation.png', OVERVIEW)
      await click('stand-in-back-to-assistants')
      await control.command('waitFor', testId('stand-in-primary-open'), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getElementCount', testId('stand-in-back-to-assistants')),
        '0'
      )
      await captureScreenshot(control, '07-back-to-assistants.png', OVERVIEW)
    },
  }
}

async function readAfterTeamSave(control, read, name, timeoutMs) {
  await control.command('waitFor', testId('stand-in-teams-dialog'), { text: name, timeoutMs })
  return read()
}
