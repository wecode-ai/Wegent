import { startNativeClient } from '../../wework/e2e/desktop/modules/native-mcp-environment.mjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const root = join(process.cwd(), '.ci-artifacts', 'sqlite-interruption')
await mkdir(root, { recursive: true })
const server = createServer((request, response) => { request.resume(); response.on('error', () => {}) })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const records = []
try {
  for (let index = 0; index < 32; index++) {
    const home = join(root, String(index)); await mkdir(home)
    const config = { cli_auth_credentials_store: 'file', model: 'gpt-5.4', model_provider: 'synthetic', 'model_providers.synthetic.name': 'SQLite interruption model substitute', 'model_providers.synthetic.base_url': `http://127.0.0.1:${server.address().port}/v1`, 'model_providers.synthetic.wire_api': 'responses', 'model_providers.synthetic.requires_openai_auth': false, 'features.shell_snapshot': false }
    const args = Object.entries(config).flatMap(([key,value]) => ['-c', `${key}=${JSON.stringify(value)}`]).concat('app-server')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key)))
    Object.assign(environment, { HOME: home, USERPROFILE: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home, TMP: home, TEMP: home })
    const client = startNativeClient({ binary: join(process.cwd(), 'wework/electron/release/WeWork-win32-x64/resources/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe'), args, cwd: home, env: environment, root: home, phase: 'native' })
    let database
    try {
      await client.call('initialize', {clientInfo:{name:'sqlite_interruption_diagnostic',version:'1'},capabilities:{experimentalApi:true}}); client.notify('initialized')
      const thread = await client.call('thread/start', {cwd:home,model:'gpt-5.4',modelProvider:'synthetic',approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:false})
      const turn = await client.call('turn/start', {threadId:thread.thread.id,input:[{type:'text',text:'Synthetic SQLite interruption probe; no actions.'}]})
      await client.waitFor('turn/started', event => event.turn.id === turn.turn.id)
      database = new DatabaseSync(join(home,'state_5.sqlite')); database.exec('PRAGMA busy_timeout=10000')
      const read = database.prepare('SELECT id FROM threads WHERE id = ?')
      const deadline = Date.now() + 10000
      while (!read.get(thread.thread.id)) { if (Date.now() > deadline) throw new Error('Native thread metadata was not persisted'); await new Promise(resolve=>setTimeout(resolve,25)) }
      for(let update=0;update<64;update++) database.prepare('UPDATE threads SET title = ? WHERE id = ?').run('diagnostic '+update+' '+ 'x'.repeat(8192), thread.thread.id)
      const initialMmap = database.prepare('PRAGMA mmap_size').get(); await writeFile(join(home,'mmap.json'), JSON.stringify(initialMmap)); database.close();database=null
      await client.close()
      database = new DatabaseSync(join(home,'state_5.sqlite'))
      const changed=database.prepare("UPDATE threads SET history_mode = 'legacy' WHERE id = ?").run(thread.thread.id)
      assert.equal(Number(changed.changes),1)
      const record={index,threadId:thread.thread.id,integrity:database.prepare('PRAGMA quick_check').all(),afterStopUpdate:'passed'};records.push(record);console.log(JSON.stringify(record))
    } catch(error) {
      records.push({index,error:error.stack,code:error.code,errcode:error.errcode,errstr:error.errstr}); const probe = await promisify(execFile)('pwsh.exe',['-NoProfile','-NonInteractive','-File',join(process.cwd(),'.github/scripts/wework-sqlite-lock-diagnostic.ps1'),home],{timeout:30000}); await writeFile(join(home,'windows-file-probe.json'),probe.stdout); console.log(probe.stdout); throw error
    } finally {database?.close();await client.close().catch(()=>{});await writeFile(join(root,'results.json'),JSON.stringify(records,null,2))}
  }
} finally {server.closeAllConnections();server.close()}
