import { describe, expect, it } from 'vitest'
import { createPluginTrialGuide, buildTrialTemplatePrompt } from './composer-plugin-trial'

describe('shared plugin trial guide', () => {
  it('retains the selected plugin reference even when another plugin precedes it in the draft', () => {
    const input = 'Ask [$Docs](plugin://docs@tools), then [$PDF](plugin://pdf@tools) about this'
    expect(
      buildTrialTemplatePrompt(
        input,
        { name: 'Read', path: 'read', description: 'Read this file' },
        'PDF'
      )
    ).toBe('[$PDF](plugin://pdf@tools) Read this file ')
  })
  it('removes unavailable templates and limits a guide to six usable tasks', () => {
    const templates = Array.from({ length: 9 }, (_, index) => ({
      name: `Task ${index}`,
      path: String(index),
      unavailableReason: index === 0 ? 'offline' : undefined,
    }))
    expect(createPluginTrialGuide(' PDF ', templates)).toMatchObject({
      pluginName: 'PDF',
      templates: templates.slice(1, 7),
    })
    expect(createPluginTrialGuide('', templates)).toBeNull()
    expect(createPluginTrialGuide('PDF', [templates[0]])).toBeNull()
  })
})
