import { waitForElementInsideScroller } from '../modules/conversation-layout.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import {
  openProjectWorkspaceTab,
  workspaceTabIds,
  enterLocalCollaborationWorkspace,
} from '../modules/workspace-flows.mjs'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const PACKAGE = '@test/connection-automation'
const PROVIDER = `${PACKAGE}/records`
const PRIVATE = 'PRIVATE_SOURCE_ORIGINAL_NEVER_PUBLISH'

// A real DSH provider reads a local source file. Only its summarizing model is synthetic.
export function createDesktopScenario({
  electronUserDataDirectory,
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
  captureScreenshot,
}) {
  const adapterPath = join(resultDir, 'connection-automation-adapter')
  const packagePath = join(
    electronUserDataDirectory,
    'dsh-core/profiles/wework-core/node_modules',
    ...PACKAGE.split('/')
  )
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  let summaries = 0
  async function waitFor(read, ready) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await read()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Connection automation did not reach its business state: ${JSON.stringify(latest)}`)
  }
  return {
    async prepareApp() {
      await mkdir(adapterPath, { recursive: true })
      await cp(
        new URL('../fixtures/connection-automation-provider.mjs', import.meta.url),
        join(adapterPath, 'index.js')
      )
      await writeFile(join(adapterPath, 'events.json'), '[]')
      await writeFile(
        join(adapterPath, 'cordis.patch.yml'),
        `- insert:\n    - id: connection-automation\n      name: '${PACKAGE}'\n      inject:\n        - weworkConnections\n`
      )
      await writeFile(
        join(adapterPath, 'package.json'),
        JSON.stringify({
          name: PACKAGE,
          version: '1.0.0',
          type: 'module',
          main: 'index.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          wework: {
            connections: {
              apiVersion: 1,
              dependencies: {},
              providers: [
                {
                  id: 'records',
                  displayName: 'Private records',
                  uses: [],
                  collectionModes: ['poll'],
                  resourceKinds: ['record'],
                  resourceLabels: { record: 'Records' },
                  eventTypes: ['record.received'],
                },
              ],
            },
          },
        })
      )
      const profileManifest = join(packagePath, '../../..', 'package.json')
      await mkdir(packagePath, { recursive: true })
      await cp(adapterPath, packagePath, { recursive: true })
      let manifest = { private: true }
      try {
        manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: `file:${adapterPath}` }
      manifest.dsh = {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles: [...new Set([...(manifest.dsh?.profile?.bundles ?? []), PACKAGE])],
        },
      }
      await writeFile(profileManifest, JSON.stringify(manifest))
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        !JSON.stringify(body.input).includes(
          'Produce only the result explicitly authorized for publication'
        )
      )
        return false
      summaries++
      const id = `publication-${summaries}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(
            JSON.stringify({ description: 'An authorized anonymized failure summary' })
          ),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verifyPersonal(control) {
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: modelResponseTimeoutMs,
      })
      const resource = (
        await rpc(control, 'runtime.connections.resources', {
          providerId: PROVIDER,
          kind: 'record',
          query: '',
        })
      ).items[0]
      await verifyPersonalRule(control, rpc, resource, captureScreenshot, waitFor)
    },
    async verify(control) {
      const originalSourceWindowSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 720 }),
      })
      try {
        await control.command('ensureLocalModelCatalogReady', 'body', {
          timeoutMs: modelResponseTimeoutMs,
        })
        const catalog = await rpc(control, 'runtime.connections.catalog', {})
        assert.equal(catalog.items.find(item => item.id === PROVIDER)?.availability.status, 'ready')
        const project = await rpc(control, 'projects.create', {
          name: 'Connection publication boundary',
        })
        const resource = (
          await rpc(control, 'runtime.connections.resources', {
            providerId: PROVIDER,
            kind: 'record',
            query: '',
          })
        ).items[0]
        const input = {
          id: 'connection-rule-e2e',
          version: 0,
          name: 'Publish failures',
          enabled: true,
          source: resource,
          eventType: 'record.received',
          project: { id: project.id, store: 'local' },
          targetKind: 'human',
          targetId: String(USER),
          condition: { contains: 'FAILURE' },
          publication: {
            title: 'Published failure',
            instruction: 'Publish only an anonymized failure summary',
          },
        }
        const initial = JSON.parse(await control.command('snapshot', 'body'))
        const { boardContentSelector: root } = await openProjectWorkspaceTab(
          control,
          workspaceTabIds(initial, 'board')
        )
        await enterLocalCollaborationWorkspace(control, root)
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="collaboration-workspace-project-${project.id}"]`
        )
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="collaboration-tab-manage"]`
        )
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="collaboration-project-settings-automatic-processing"]`
        )
        await control.command(
          'waitFor',
          `${root} [data-testid="automatic-processing-create"]:not([disabled])`
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${root} [data-testid="connection-rule-error"]`
            )
          ),
          0,
          'Local source rules must load without a cloud device inventory'
        )
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${root} [data-testid="connection-rule-create"]`
            )
          ),
          0,
          'Project automation must have only one creation entry'
        )
        await captureScreenshot(control, 'connection-rules-01-project-empty.png')
        await control.command('click', `${root} [data-testid="automatic-processing-create"]`)
        await control.command('waitFor', `${root} [data-testid="project-rule-connection-picker"]`)
        await captureScreenshot(control, 'connection-rules-01a-connection-types.png')
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="project-rule-connection-${PROVIDER}"]`
        )
        await control.command('waitFor', `${root} [data-testid="connection-rule-editor"]`)
        await control.command('nativePress', `${root} [data-testid="connection-rule-cancel"]`, {
          key: 'Tab',
        })
        assert.equal(
          await control.command('getActiveElementTestId', 'body'),
          'connection-rule-back',
          'Tab must remain inside the source rule dialog'
        )
        await control.command('nativePress', `${root} [data-testid="connection-rule-back"]`, {
          key: 'Shift+Tab',
        })
        assert.equal(
          await control.command('getActiveElementTestId', 'body'),
          'connection-rule-cancel',
          'Shift+Tab must remain inside the source rule dialog'
        )
        await control.command('nativePress', `${root} [data-testid="connection-rule-cancel"]`, {
          key: 'Escape',
        })
        await waitFor(
          () => control.command('getActiveElementTestId', 'body'),
          value => value === 'automatic-processing-create'
        )
        await control.command('click', `${root} [data-testid="automatic-processing-create"]`)
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="project-rule-connection-${PROVIDER}"]`
        )
        await control.command('waitFor', `${root} [data-testid="connection-rule-editor"]`)
        await control.command('clickWhenEnabled', `${root} [data-testid="connection-rule-search"]`)
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="connection-rule-result-${resource.id}"]`
        )
        await waitForElementInsideScroller(
          control,
          `${root} [data-testid="connection-rule-next"]`,
          'body',
          'Connection setup footer must remain visible at 1280x720',
          uiTimeoutMs,
          { clipToViewport: true }
        )
        await captureScreenshot(control, 'connection-rules-01b-selected-connection.png')
        await control.command('clickWhenEnabled', `${root} [data-testid="connection-rule-next"]`)
        await control.command('fill', `${root} [data-testid="connection-rule-name"]`, {
          value: input.name,
        })
        await control.command(
          'click',
          `${root} [data-testid="connection-rule-processing-conditions"]`
        )
        await control.command(
          'fill',
          `${root} [data-testid="connection-rule-processing-contains"]`,
          {
            value: 'FAILURE',
          }
        )
        await captureScreenshot(control, 'connection-rules-02-source-condition.png')
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="connection-rule-target-kind-human"]`
        )
        await control.command('click', `${root} [data-testid="connection-rule-target"]`)
        await control.command(
          'clickWhenEnabled',
          `${root} [data-testid="connection-rule-target-option-human-${USER}"]`
        )
        await control.command('fill', `${root} [data-testid="connection-rule-title"]`, {
          value: input.publication.title,
        })
        await control.command('fill', `${root} [data-testid="connection-rule-publication"]`, {
          value: input.publication.instruction,
        })
        await waitForElementInsideScroller(
          control,
          `${root} [data-testid="connection-rule-save"]`,
          'body',
          'Rule save action must remain visible at 1280x720',
          uiTimeoutMs,
          { clipToViewport: true }
        )
        assert.equal(
          await control.command(
            'getText',
            `${root} [data-testid="connection-rule-selected-source"]`
          ),
          resource.name,
          'The fixed header must identify the specific watched connection'
        )
        await captureScreenshot(control, 'connection-rules-03-publication-boundary.png')
        await control.command('clickWhenEnabled', `${root} [data-testid="connection-rule-save"]`)
        const saved = (
          await waitFor(
            () =>
              rpc(control, 'runtime.connection_rules.list', {
                userId: USER,
                project: input.project,
              }),
            result => result.items.some(rule => rule.name === input.name)
          )
        ).items.find(rule => rule.name === input.name)
        await control.command(
          'waitFor',
          `${root} [data-testid="connection-rule-history-${saved.id}"]`
        )
        await captureScreenshot(control, 'connection-rules-04-saved.png')
        const excluded = (
          await rpc(control, 'runtime.connection_rules.save', {
            userId: USER,
            rule: {
              ...input,
              id: 'connection-rule-excluded',
              condition: { contains: 'NEVER_MATCH' },
            },
          })
        ).rule
        try {
          const event = {
            id: 'event-one',
            eventType: 'record.received',
            at: new Date().toISOString(),
            text: `FAILURE ${PRIVATE}`,
          }
          await writeFile(join(packagePath, 'events.json'), JSON.stringify([event]))
          const runs = await waitFor(
            () => rpc(control, 'runtime.connection_rules.runs', { userId: USER, id: saved.id }),
            result => result.items.some(run => run.status === 'published')
          )
          assert.equal(runs.items.length, 1)
          assert.equal(
            (await rpc(control, 'runtime.connection_rules.runs', { userId: USER, id: excluded.id }))
              .items.length,
            0
          )
          const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'), {
            readOnly: true,
          })
          try {
            const issues = database
              .prepare(
                "SELECT title,description,metadata FROM loop_items WHERE resource_type='task' AND cloud_project_id=?"
              )
              .all(project.id)
            assert.equal(issues.length, 1)
            assert.equal(issues[0].title, 'Published failure')
            assert.equal(issues[0].description, 'An authorized anonymized failure summary')
            const shared = database
              .prepare(
                "SELECT metadata FROM loop_items WHERE id=? OR (cloud_project_id=? AND resource_type='automation_run')"
              )
              .all(project.id, project.id)
            for (const secret of [PRIVATE, 'private-account', 'private-source'])
              assert.equal(JSON.stringify([...issues, ...shared]).includes(secret), false)
            await control.command(
              'clickWhenEnabled',
              `${root} [data-testid="connection-rule-history-${saved.id}"]`
            )
            await control.command('waitFor', `${root} [data-testid="connection-rule-runs"]`)
            await captureScreenshot(control, 'connection-rules-05-publication-history.png')
            await control.command(
              'clickWhenEnabled',
              `${root} [data-testid="connection-rule-issue-${runs.items[0].id}"]`
            )
            await control.command('waitFor', `${root} [data-testid="cloud-todo-detail-close"]`)
            await control.command('finishAnimations', 'body')
            await waitFor(
              async () =>
                JSON.parse(
                  await control.command(
                    'getElementMetrics',
                    `${root} [data-testid="cloud-todo-detail"]`
                  )
                )[0],
              panel =>
                panel &&
                panel.width > 0 &&
                panel.left >= 0 &&
                panel.right <= panel.viewportWidth + 1 &&
                panel.bottom <= panel.viewportHeight + 1
            )
            await captureScreenshot(control, 'connection-rules-05b-opened-issue.png')
            await control.command(
              'clickWhenEnabled',
              `${root} [data-testid="cloud-todo-detail-close"]`
            )
            await control.command(
              'clickWhenEnabled',
              `${root} [data-testid="connection-rule-toggle-${saved.id}"]`
            )
            await waitFor(
              () =>
                rpc(control, 'runtime.connection_rules.list', {
                  userId: USER,
                  project: input.project,
                }),
              result => result.items.some(rule => rule.id === saved.id && !rule.enabled)
            )
            await captureScreenshot(control, 'connection-rules-06-paused.png')
            await writeFile(
              join(packagePath, 'events.json'),
              JSON.stringify([event, { ...event, id: 'event-two', at: new Date().toISOString() }])
            )
            await waitFor(
              async () =>
                database
                  .prepare(
                    "SELECT metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.source.providerId')=?"
                  )
                  .all(PROVIDER),
              rows => rows.some(row => JSON.parse(row.metadata).checkpoint?.cursor === 2)
            )
            assert.equal(
              (await rpc(control, 'runtime.connection_rules.runs', { userId: USER, id: saved.id }))
                .items.length,
              1
            )
            assert.equal(
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='task' AND cloud_project_id=?"
                )
                .get(project.id).count,
              1
            )
            assert.equal(summaries, 1)
            await writeFile(join(packagePath, 'events.json'), '{')
            await waitFor(
              () =>
                rpc(control, 'runtime.connection_rules.list', {
                  userId: USER,
                  project: input.project,
                }),
              result => result.items.some(rule => rule.id === excluded.id && rule.collectionError)
            )
            await control.command(
              'waitFor',
              `${root} [data-testid="connection-rule-retry-source-${excluded.id}"]`
            )
            await captureScreenshot(control, 'connection-rules-06b-source-error.png')
            await writeFile(
              join(packagePath, 'events.json'),
              JSON.stringify([event, { ...event, id: 'event-two' }])
            )
            await control.command(
              'clickWhenEnabled',
              `${root} [data-testid="connection-rule-retry-source-${excluded.id}"]`
            )
            await waitFor(
              () =>
                rpc(control, 'runtime.connection_rules.list', {
                  userId: USER,
                  project: input.project,
                }),
              result => result.items.every(rule => !rule.collectionError)
            )
            const recovered = database
              .prepare(
                "SELECT metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.source.providerId')=?"
              )
              .all(PROVIDER)
            assert.ok(
              recovered.some(row => JSON.parse(row.metadata).checkpoint?.cursor === 2),
              'Rechecking a source must preserve the collection checkpoint'
            )
            await captureScreenshot(control, 'connection-rules-06c-source-recovered.png')
            await verifyPersonalRule(control, rpc, resource, captureScreenshot, waitFor)
          } finally {
            database.close()
          }
        } finally {
          for (const id of [saved.id, excluded.id]) {
            const rules = await rpc(control, 'runtime.connection_rules.list', {
              userId: USER,
              project: input.project,
            })
            const rule = rules.items.find(item => item.id === id)
            if (rule)
              await rpc(control, 'runtime.connection_rules.remove', {
                userId: USER,
                id,
                version: rule.version,
              })
          }
        }
      } finally {
        await control.command('setMainWindowSize', 'body', { value: originalSourceWindowSize })
      }
    },
  }
}

async function verifyPersonalRule(control, rpc, resource, capture, waitFor) {
  const original = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
  const originalWindowSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1280, height: 720 }),
  })
  const prefix = `stand-in-connection-${PROVIDER}-policy-${resource.id}`
  try {
    await rpc(control, 'runtime.stand_in.personal.save', {
      userId: USER,
      settings: {
        ...original,
        primary: {
          enabled: false,
          prompt: '',
          preferences: '',
          ...original.primary,
          connections: [
            ...(original.primary?.connections ?? []).filter(row => row.providerId !== PROVIDER),
            {
              ...resource,
              policy: { enabled: true, automatic: false, askBeforeAct: true, immediate: false },
            },
          ],
        },
      },
    })
    await ensureExperimentalFeaturesEnabled(control)
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    const onboarding = await rpc(control, 'runtime.stand_in.onboarding.get', { userId: USER })
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    if (!onboarding.state.completed) {
      await control.command('waitFor', '[data-testid="stand-in-onboarding-review"]:checked')
      await control.command('click', '[data-testid="stand-in-onboarding-review"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-complete"]')
    }
    await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
    await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('clickWhenEnabled', `[data-testid="stand-in-add-${PROVIDER}-connection"]`)
    await control.command('click', `[data-testid="${prefix}-rule-settings"]`)
    await control.command('click', `[data-testid="${prefix}-rule-conditions"]`)
    await control.command('fill', `[data-testid="${prefix}-rule-contains"]`, {
      value: 'Personal follow-up',
    })
    await control.command('fill', `[data-testid="${prefix}-rule-instruction"]`, {
      value: 'Prepare a private reminder for me.',
    })
    await control.command('scrollIntoView', `[data-testid="${prefix}-rule-instruction"]`)
    await control.command('finishAnimations', 'body')
    await waitFor(
      async () =>
        Promise.all([
          control.command('getElementMetrics', `[data-testid="${prefix}-rule-instruction"]`),
          control.command('getElementMetrics', '[data-testid="stand-in-primary-profile"] > header'),
          control.command('getElementMetrics', '[data-testid="stand-in-primary-profile"] > footer'),
        ]).then(values => values.map(value => JSON.parse(value)[0])),
      ([field, header, footer]) =>
        field &&
        header &&
        footer &&
        field.width > 0 &&
        field.top >= header.bottom - 1 &&
        field.bottom <= footer.top + 1
    )
    assert.equal(
      await control.command('getValue', `[data-testid="${prefix}-rule-instruction"]`),
      'Prepare a private reminder for me.'
    )
    await capture(control, 'connection-rules-07-personal-editor.png')
    await control.command('scrollIntoView', `[data-testid="${prefix}-enabled"]`)
    await control.command('click', `[data-testid="${prefix}-enabled"]`)
    assert.equal(
      await control.command('getAttribute', `[data-testid="${prefix}-enabled"]`, {
        value: 'aria-checked',
      }),
      'false'
    )
    await control.command('finishAnimations', 'body')
    await waitFor(
      async () =>
        Promise.all([
          control.command('getElementMetrics', `[data-testid="${prefix}-enabled"] > span`),
          control.command('getElementMetrics', `[data-testid="${prefix}-enabled"] > span > span`),
        ]).then(values => values.map(value => JSON.parse(value)[0])),
      ([track, thumb]) =>
        track && thumb && Math.abs(thumb.left - track.left - (track.height - thumb.height) / 2) <= 1
    )
    await capture(control, 'connection-rules-08-personal-paused.png')
    await control.command('clickWhenEnabled', `[data-testid="stand-in-connection-${PROVIDER}-add"]`)
    const sourcePrefix = `stand-in-connection-${PROVIDER}`
    await control.command('fill', `[data-testid="${sourcePrefix}-query"]`, { value: 'Release' })
    await control.command('clickWhenEnabled', `[data-testid="${sourcePrefix}-search"]`)
    await control.command(
      'waitFor',
      `[data-testid="${sourcePrefix}-result-${resource.id}"]:disabled`
    )
    await control.command('scrollIntoView', `[data-testid="${sourcePrefix}-resource-picker"]`)
    await capture(control, 'connection-rules-09-personal-connection-picker.png')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
    await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', { visible: false })
    const saved = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
    const row = saved.primary.connections.find(item => item.providerId === PROVIDER)
    assert.equal(row.condition.contains, 'Personal follow-up')
    assert.equal(row.instruction, 'Prepare a private reminder for me.')
    assert.deepEqual(row.policy, {
      enabled: false,
      automatic: false,
      askBeforeAct: true,
      immediate: false,
    })
  } finally {
    const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
    await rpc(control, 'runtime.stand_in.personal.save', {
      userId: USER,
      settings: { ...original, version: current.version },
    })
    await control.command('setMainWindowSize', 'body', { value: originalWindowSize })
  }
}
