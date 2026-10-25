export const name = 'connection-source'
export const inject = ['weworkConnections']
export async function apply(ctx) {
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    records: {
      async check() {
        return { status: 'ready' }
      },
      async listResources(context, input) {
        const catalog = await context.mcp.listTools('source')
        const tools = catalog.tools.filter(item => item.name === 'read_record')
        if (tools.length !== 1)
          throw new Error('Exact source plugin must expose one read_record tool')
        const { server } = tools[0]
        const result = await context.mcp.callTool('source', {
          server,
          tool: 'read_record',
          arguments: { query: input.query },
        })
        if (result.isError) throw new Error('Source record read failed')
        const record = result.structuredContent
        return {
          items: [
            { id: record.id, name: record.value, kind: 'record', profile: 'fixture', server },
          ],
          hasMore: false,
        }
      },
      async validate(_ctx, source) {
        return source
      },
      async initialize() {
        return { cursor: '0' }
      },
      async collect() {
        return { events: [], nextCheckpoint: { cursor: '0' }, hasMore: false }
      },
    },
  })
}
