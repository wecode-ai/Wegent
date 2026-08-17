import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

interface DesktopScenarioLoader {
  loadDesktopScenario: (
    moduleUrl: string | undefined,
    options: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>
}

async function loadScenarioLoader(): Promise<DesktopScenarioLoader> {
  const loaderUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/scenario-loader.mjs')
  ).href
  return import(/* @vite-ignore */ loaderUrl) as Promise<DesktopScenarioLoader>
}

describe('loadDesktopScenario', () => {
  test('returns null when no scenario module is configured', async () => {
    const { loadDesktopScenario } = await loadScenarioLoader()

    await expect(loadDesktopScenario(undefined, {})).resolves.toBeNull()
  })

  test('loads a scenario factory from an ESM module URL', async () => {
    const { loadDesktopScenario } = await loadScenarioLoader()
    const fixtureUrl =
      'data:text/javascript,export function createDesktopScenario(options) { return { marker: options.marker } }'

    await expect(loadDesktopScenario(fixtureUrl, { marker: 'loaded' })).resolves.toEqual({
      marker: 'loaded',
    })
  })
})
