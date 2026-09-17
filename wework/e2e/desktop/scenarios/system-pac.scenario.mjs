import { createDesktopScenario as createProxyScenario } from './system-proxy.scenario.mjs'

export function createDesktopScenario(options) {
  return createProxyScenario({ ...options, pac: true })
}
