import { createDesktopScenario as createAssignment } from './project-assignment-notification.scenario.mjs'
import { createDesktopScenario as createRequests } from './multi-request-assistant-worktrees.scenario.mjs'

/** Keep durable assignment intake and its dependent requests in one existing CI host. */
export function createProjectAssistantSuite(assignment, requests) {
  let active = assignment
  return {
    requiresCloudEnvironment: true,
    backendEnv: { ...assignment.backendEnv, ...requests.backendEnv },
    async prepareCloud(cloud) {
      await assignment.prepareCloud(cloud)
      await requests.prepareCloud(cloud)
    },
    setCloudEnvironment(environment) {
      assignment.setCloudEnvironment(environment)
      requests.setCloudEnvironment(environment)
    },
    handleHttp(...args) {
      return active.handleHttp(...args)
    },
    async verify(control) {
      await assignment.verify(control)
      active = requests
      await requests.verify(control)
    },
    diagnostics() {
      return {
        assignment: assignment.diagnostics(),
        asyncRequests: requests.diagnostics(),
      }
    },
    cleanup() {
      return requests.cleanup()
    },
  }
}

export function createDesktopScenario(options) {
  return createProjectAssistantSuite(createAssignment(options), createRequests(options))
}
