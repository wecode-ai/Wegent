import { createDesktopScenario as createSources } from './connection-automations.scenario.mjs'
import {
  permissionRequest,
  verifyConnectionRuleProjectPermissions,
} from '../modules/connection-rule-project-permissions.mjs'

// The existing cloud host invokes this same case after its publication verification.
export function createDesktopScenario(options) {
  const sources = createSources(options)
  let environment
  let project
  let workspace
  let restart
  const request = (path, init) => permissionRequest(environment, path, init)
  return {
    requiresCloudEnvironment: true,
    prepareApp: sources.prepareApp,
    handleHttp: sources.handleHttp,
    setRestartDesktopApp(value) {
      restart = value
    },
    async prepareCloud(value) {
      environment = value
      await request('/admin/setup-complete', { method: 'POST' })
      workspace = await request('/v1/workspaces', {
        method: 'POST',
        body: { name: `Source permissions-${process.pid}` },
      })
      project = await request(`/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: { name: 'Source permission boundary', task_provider: 'local' },
      })
    },
    async verify(control) {
      await verifyConnectionRuleProjectPermissions(
        control,
        environment,
        project.id,
        restart,
        options
      )
    },
    async cleanup() {
      if (project) {
        const latest = await request(`/v1/cloud-projects/${project.id}`)
        await request(`/v1/cloud-projects/${project.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      }
      if (workspace) {
        const latest = await request(`/v1/workspaces/${workspace.id}`)
        await request(`/v1/workspaces/${workspace.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      }
    },
  }
}
