export async function loadDesktopScenario(moduleUrl, options) {
  if (!moduleUrl) return null

  const scenarioModule = await import(moduleUrl)
  if (typeof scenarioModule.createDesktopScenario !== 'function') {
    throw new Error(`Desktop scenario module must export createDesktopScenario: ${moduleUrl}`)
  }

  return scenarioModule.createDesktopScenario(options)
}
