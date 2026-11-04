import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createDesktopScenario as createCloud } from './stand-in-cloud.scenario.mjs'
import { createDesktopScenario as createSources } from './connection-automations.scenario.mjs'
import { verifyConnectionRuleProjectPermissions } from '../modules/connection-rule-project-permissions.mjs'

// Extend the existing cloud lifecycle; all project, gateway and processor operations remain real.
export function createDesktopScenario(options) {
  const cloud = createCloud(options)
  const sources = createSources(options)
  let environment
  let restart
  const request = async (path, method = 'GET') => {
    const response = await fetch(`${environment.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${environment.authToken}` },
      signal: AbortSignal.timeout(options.uiTimeoutMs),
    })
    assert.ok(response.ok, `Cloud source ${path} failed: ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  async function until(load, accept) {
    const deadline = Date.now() + options.modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (accept(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`Cloud source publication did not settle: ${JSON.stringify(latest)}`)
  }
  return {
    requiresCloudEnvironment: true,
    setRestartDesktopApp(value) {
      restart = value
    },
    prepareApp: sources.prepareApp,
    async prepareCloud(value) {
      environment = value
      await cloud.prepareCloud(value)
    },
    async handleHttp(...args) {
      return (await sources.handleHttp(...args)) || cloud.handleHttp(...args)
    },
    async verify(control) {
      await cloud.verify(control)
      const user = await request('/users/me')
      const projectId = cloud.diagnostics().projectId
      const agents = await request(`/v1/cloud-projects/${projectId}/chat-agents`)
      const agent = agents.find(
        item => item.status === 'active' && item.executionPolicy?.mode === 'fixed'
      )
      assert.ok(agent, 'The cloud fixture must retain a real configured Agent')
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const providerId = '@test/connection-automation/records'
      const resource = (
        await rpc('runtime.connections.resources', { providerId, kind: 'record', query: '' })
      ).items[0]
      const rule = (
        await rpc('runtime.connection_rules.save', {
          userId: user.id,
          rule: {
            id: 'connection-rule-cloud-e2e',
            version: 0,
            name: 'Cloud source publication',
            enabled: true,
            source: resource,
            eventType: 'record.received',
            project: { id: String(projectId), store: 'cloud' },
            targetKind: 'agent',
            targetId: String(agent.id),
            instruction: 'Process the published Issue and record the result.',
            publication: {
              title: 'Authorized cloud publication',
              instruction: 'Publish only an anonymized failure summary',
            },
          },
        })
      ).rule
      try {
        const eventsPath = join(
          options.electronUserDataDirectory,
          'dsh-core/profiles/wework-core/node_modules/@test/connection-automation/events.json'
        )
        await writeFile(
          eventsPath,
          JSON.stringify([
            {
              id: 'cloud-source-event',
              eventType: 'record.received',
              at: new Date().toISOString(),
              text: 'PRIVATE_CLOUD_SOURCE_ORIGINAL',
            },
          ])
        )
        const result = await until(
          () => rpc('runtime.connection_rules.runs', { userId: user.id, id: rule.id }),
          value => value.items.some(run => run.status === 'published')
        )
        const published = result.items.find(run => run.status === 'published')
        assert.ok(published.issueId)
        assert.ok(published.projectRunId)
        const issue = await request(`/v1/loop-items/${published.issueId}`)
        assert.equal(issue.description, 'An authorized anonymized failure summary')
        assert.equal(JSON.stringify(issue).includes('PRIVATE_CLOUD_SOURCE_ORIGINAL'), false)
        const runs = await until(
          () => request(`/v1/cloud-projects/${projectId}/automations/${rule.cloudRuleId}/runs`),
          value =>
            value.some(
              run => String(run.id) === published.projectRunId && run.status === 'succeeded'
            )
        )
        assert.equal(runs.filter(run => String(run.id) === published.projectRunId).length, 1)
        const events = await request(
          `/v1/cloud-projects/${projectId}/incoming-hooks/${rule.cloudHookId}/events`
        )
        assert.equal(events.length, 1)
        assert.equal(events[0].status, 'processed')
        assert.equal(
          JSON.stringify({ runs, events }).includes('PRIVATE_CLOUD_SOURCE_ORIGINAL'),
          false
        )
      } finally {
        const latest = (
          await rpc('runtime.connection_rules.list', { userId: user.id, project: rule.project })
        ).items.find(item => item.id === rule.id)
        if (latest)
          await rpc('runtime.connection_rules.remove', {
            userId: user.id,
            id: latest.id,
            version: latest.version,
          })
      }
      await verifyConnectionRuleProjectPermissions(
        control,
        environment,
        projectId,
        restart,
        options
      )
    },
    diagnostics: cloud.diagnostics,
  }
}
