import readline from 'node:readline'

const uri = 'ui://counter/app.html'
let count = 0
let failedResource = false
const tools = [
  {
    name: 'show_app',
    description: 'Open the counter MCP App.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: uri } },
  },
  {
    name: 'read_count',
    description: 'Read the counter from the app.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'model_only',
    description: 'A tool unavailable to apps.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'change_count',
    description: 'A write requiring approval.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  },
]

for (const [name, metadata] of [
  ['show_legacy', { 'openai/outputTemplate': 'ui://counter/legacy.html' }],
  ['show_dynamic', undefined],
  ['show_recovery', { ui: { resourceUri: 'ui://counter/recovery.html' } }],
])
  tools.push({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    ...(metadata ? { _meta: metadata } : {}),
  })

const legacyHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><output id="status">Legacy loading</output><button id="refresh">Read counter</button><script>
window.addEventListener('openai:set_globals', () => { if (window.openai.toolOutput) document.querySelector('#status').textContent='Legacy '+window.openai.toolOutput.count });
document.querySelector('#refresh').onclick=async()=>{ const result=await window.openai.callTool('read_count',{}); document.querySelector('#status').textContent='Counter '+result.structuredContent.count };
</script></body></html>`

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Counter App</title></head>
<body><h1>Counter App</h1><output id="status">Loading</output><input id="draft" aria-label="App draft"><button id="refresh">Read counter</button><button id="expand">Expand</button><button id="pip">Picture in picture</button><button id="context">Update context</button>
<script>
let sequence=0; const pending=new Map();
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
window.addEventListener('message',event=>{if(event.source!==parent)return;const m=event.data;if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}
if(m.method==='ui/notifications/tool-result'){document.querySelector('#status').textContent='Result '+m.params.structuredContent.count+' '+m.params._meta.privateMarker}
if(m.method==='ui/resource-teardown')parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*')});
document.querySelector('#refresh').onclick=async()=>{try{const r=await request('tools/call',{name:'read_count',arguments:{}});document.querySelector('#status').textContent='Counter '+r.structuredContent.count}catch(e){document.querySelector('#status').textContent=e.message}};
document.querySelector('#expand').onclick=()=>request('ui/request-display-mode',{mode:'fullscreen'});
document.querySelector('#pip').onclick=()=>request('ui/request-display-mode',{mode:'pip'});
document.querySelector('#context').onclick=async()=>{await request('ui/update-model-context',{structuredContent:{selection:'counter-selection'}});document.querySelector('#status').textContent='Context saved'};
request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'counter',version:'1.0.0'},appCapabilities:{}}).then(()=>parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*')).catch(e=>{document.querySelector('#status').textContent=e.message});
fetch('https://blocked.example.invalid/leak').then(()=>{document.body.dataset.csp='failed'}).catch(()=>{document.body.dataset.csp='blocked'});
</script></body></html>`

for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue
  const request = JSON.parse(line)
  if (!Object.hasOwn(request, 'id')) continue
  let result
  let error
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        serverInfo: { name: 'counter', version: '1.0.0' },
        capabilities: { tools: {}, resources: {} },
      }
      break
    case 'tools/list':
      result = { tools }
      break
    case 'resources/list':
      result = { resources: [{ uri, name: 'Counter App', mimeType: 'text/html;profile=mcp-app' }] }
      break
    case 'resources/templates/list':
      result = { resourceTemplates: [] }
      break
    case 'resources/read':
      if (request.params.uri === 'ui://counter/recovery.html' && !failedResource) {
        failedResource = true
        error = { code: -32603, message: 'Resource temporarily unavailable' }
      } else if (
        ![uri, 'ui://counter/legacy.html', 'ui://counter/recovery.html'].includes(
          request.params.uri
        )
      )
        error = { code: -32602, message: 'Unknown resource' }
      else
        result = {
          contents: [
            {
              uri: request.params.uri,
              mimeType: request.params.uri.endsWith('/legacy.html')
                ? 'text/html+skybridge'
                : 'text/html;profile=mcp-app',
              text: request.params.uri.endsWith('/legacy.html') ? legacyHtml : html,
              _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
            },
          ],
        }
      break
    case 'tools/call':
      if (!tools.some(tool => tool.name === request.params.name)) {
        error = { code: -32602, message: 'Unknown tool' }
        break
      }
      if (request.params.name === 'read_count') count++
      result = {
        content: [{ type: 'text', text: 'Counter ready' }],
        structuredContent: { count },
        _meta: {
          privateMarker: 'ui-only-marker',
          ...(request.params.name === 'show_dynamic' ? { ui: { resourceUri: uri } } : {}),
        },
      }
      break
    case 'ping':
      result = {}
      break
    default:
      error = { code: -32601, message: 'Unknown method' }
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n'
  )
}
