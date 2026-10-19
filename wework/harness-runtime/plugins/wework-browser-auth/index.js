import { writeSync } from 'node:fs'

export const name = 'wework-browser-auth'
export const inject = ['connection', 'webServer']

export function apply(ctx) {
  const descriptor = process.env.WEWORK_DSH_BROWSER_AUTH_FD
  if (descriptor === undefined) return
  if (descriptor !== '5') throw new Error('Invalid Wework browser authentication pipe')
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`)
  writeSync(5, JSON.stringify({ url }) + '\n')
}
