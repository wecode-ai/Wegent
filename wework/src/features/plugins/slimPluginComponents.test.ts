import { describe, expect, test } from 'vitest'
import { slimPluginComponentsForCache } from './slimPluginComponents'

describe('slimPluginComponentsForCache', () => {
  test('keeps skill, app, and connector names without filesystem paths', () => {
    expect(
      slimPluginComponentsForCache({
        skills: [
          {
            name: 'CI Debug',
            description: 'Debug failing GitHub Actions checks.',
            path: '/tmp/plugins/github/skills/ci-debug',
          },
        ],
        commands: [{ name: 'ignored', path: '/tmp/commands/ignored' }],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
        apps: [
          {
            name: 'GitHub',
            path: 'github',
            description: 'Access repositories, issues, and pull requests.',
          },
        ],
        connectors: [
          {
            slug: 'github',
            authPolicy: 'on_use',
            description: 'Connect GitHub',
          },
        ],
      })
    ).toEqual({
      skills: [
        {
          name: 'CI Debug',
          description: 'Debug failing GitHub Actions checks.',
          path: 'CI Debug',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
      apps: [
        {
          name: 'GitHub',
          path: 'github',
          description: 'Access repositories, issues, and pull requests.',
        },
      ],
      connectors: [
        {
          slug: 'github',
          authPolicy: 'on_use',
          localAuth: null,
          description: 'Connect GitHub',
        },
      ],
    })
  })
})
