import { readFile } from 'node:fs/promises'

export const name = 'connection-automation-fixture'
export const inject = ['weworkConnections']

export async function apply(ctx) {
  const events = () => readFile(new URL('./events.json', import.meta.url), 'utf8').then(JSON.parse)
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    records: {
      async check() {
        return { status: 'ready' }
      },
      async listResources() {
        return {
          items: [
            {
              id: 'private-source',
              profile: 'private-account',
              kind: 'record',
              name: 'Private records',
            },
          ],
          hasMore: false,
        }
      },
      async validate(_context, source) {
        return source
      },
      async initialize() {
        return { cursor: 0 }
      },
      async collect(_context, { checkpoint }) {
        const items = await events()
        return {
          events: items.slice(checkpoint.cursor),
          nextCheckpoint: { cursor: items.length },
          hasMore: false,
        }
      },
    },
  })
}
