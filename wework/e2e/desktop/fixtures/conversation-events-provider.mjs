export const name = 'conversation-event-source'
export const inject = ['weworkConnections']

export async function apply(ctx) {
  const read = async (context, source) => {
    const result = await context.mcp.callTool('source', {
      server: source.server,
      tool: 'read_record',
      arguments: { query: source.id },
    })
    if (result.isError) throw new Error('Cannot read the test-owned event document')
    return JSON.parse(result.structuredContent.value)
  }
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    records: {
      async check() {
        return { status: 'ready' }
      },
      async listResources(context) {
        const catalog = await context.mcp.listTools('source')
        const tools = catalog.tools.filter(item => item.name === 'read_record')
        if (tools.length !== 1) throw new Error('Expected the real installed record reader')
        return {
          items: [
            {
              id: 'archive-record',
              profile: 'fixture',
              kind: 'record',
              name: '发布文档',
              server: tools[0].server,
            },
            {
              id: 'long-archive-record',
              profile: 'fixture',
              kind: 'record',
              name: `发布文档 · ${'跨部门协作与发布审核记录，等待相关变更后在原会话继续处理。'.repeat(5)}`,
              server: tools[0].server,
            },
          ],
          hasMore: false,
        }
      },
      async validate(_context, source) {
        if (
          !['archive-record', 'long-archive-record'].includes(source.id) ||
          source.profile !== 'fixture' ||
          source.kind !== 'record'
        )
          throw new Error('Unexpected document selection')
        return source
      },
      async initialize(context, source) {
        return { cursor: (await read(context, source)).length }
      },
      async collect(context, { source, checkpoint }) {
        const events = await read(context, source)
        return {
          events: events.slice(checkpoint.cursor),
          nextCheckpoint: { cursor: events.length },
          hasMore: false,
        }
      },
    },
  })
}
