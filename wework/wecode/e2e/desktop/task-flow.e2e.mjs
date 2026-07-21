process.env.WEWORK_E2E_DESKTOP_SCENARIO_MODULE = new URL('./index.mjs', import.meta.url).href
process.env.WEWORK_E2E_DESKTOP_SCENARIO_ONLY = 'true'

await import('../../../e2e/desktop/task-flow.e2e.mjs')
