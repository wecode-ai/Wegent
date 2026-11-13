export const name = 'connection-source'
export const inject = ['weworkConnections']
export async function apply(ctx) {
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    records: {
      async check() {
        return { status: 'ready' }
      },
      async listResources(context, input) {
        if (input.scope === 'all')
          return {
            items: [
              { id: '*', scope: 'all', name: 'All records', kind: 'record', profile: 'fixture' },
            ],
            hasMore: false,
          }
        const catalog = await context.mcp.listTools('source')
        const tools = catalog.tools.filter(item => item.name === 'read_record')
        if (tools.length !== 1)
          throw new Error('Exact source plugin must expose one read_record tool')
        const { server } = tools[0]
        const queries = input.query === 'batch' ? ['record-1', 'record-2'] : [input.query]
        const items = []
        for (const query of queries) {
          const result = await context.mcp.callTool('source', {
            server,
            tool: 'read_record',
            arguments: { query },
          })
          if (result.isError) throw new Error('Source record read failed')
          const record = result.structuredContent
          items.push({
            id: record.id,
            name: record.value,
            kind: 'record',
            profile: 'fixture',
            server,
          })
        }
        return {
          items,
          hasMore: false,
        }
      },
      async validate(_ctx, source) {
        return source
      },
      async initialize() {
        return { cursor: '0' }
      },
      async collect(context, { source, checkpoint }) {
        if (source.id === 'archive-record') {
          const result = await context.mcp.callTool('source', {
            server: source.server,
            tool: 'read_record',
            arguments: { query: source.id },
          })
          if (result.isError) throw new Error('Archive source record read failed')
          const events = JSON.parse(result.structuredContent.value)
          return {
            events: events.slice(Number(checkpoint.cursor)),
            nextCheckpoint: { cursor: String(events.length) },
            hasMore: false,
          }
        }
        if (source.id === 'versioned-record') {
          const result = await context.mcp.callTool('source', {
            server: source.server,
            tool: 'read_record',
            arguments: { query: source.id },
          })
          if (result.isError) throw new Error('Versioned source record read failed')
          const record = result.structuredContent
          return {
            events: [
              {
                id: 'stable-versioned-record-event',
                objectId: `record:${record.id}`,
                version: record.version,
                eventType: 'record.received',
                text: record.value,
                at: new Date().toISOString(),
              },
            ],
            nextCheckpoint: { cursor: String(Number(checkpoint.cursor) + 1) },
            hasMore: false,
          }
        }
        return { events: [], nextCheckpoint: { cursor: '0' }, hasMore: false }
      },
    },
  })
}
