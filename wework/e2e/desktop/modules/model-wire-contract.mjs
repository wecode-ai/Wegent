import assert from 'node:assert/strict'

// This is a model-side test oracle, not a replay of Codex's incremental catalog.
// Use it against a fresh request or a request with an explicitly expected batch.
export function wireDeclarations(body, protocol) {
  if (protocol === 'chat') {
    return (body.tools ?? []).map(tool => ({ ...tool.function, type: tool.type }))
  }
  if (protocol === 'anthropic') return body.tools ?? []
  assert.equal(protocol, 'responses')
  return [
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter(item => item.type === 'additional_tools')
      .flatMap(item => item.tools ?? []),
  ].flatMap(tool =>
    tool.type === 'namespace'
      ? tool.tools.map(member => ({ ...member, namespace: tool.name }))
      : [tool]
  )
}

export function assertCodeModeRequest(body, { protocol, lite }) {
  const tools = wireDeclarations(body, protocol)
  const exec = tools.filter(tool => ['exec', 'functions__exec'].includes(tool.name))
  assert.equal(exec.length, 1, 'The model must receive exactly one Code Mode exec declaration')
  for (const name of ['exec_command', 'apply_patch', 'get_goal', 'create_goal', 'update_goal']) {
    assert.ok(!tools.some(tool => tool.name === name), `${name} escaped the Code Mode entrypoint`)
  }
  if (protocol === 'responses' && lite) {
    assert.equal(body.tools, undefined, 'Lite declarations must retain their native history form')
    assert.ok(body.input.some(item => item.type === 'additional_tools'))
    assert.equal(exec[0].type, 'custom')
    assert.equal(exec[0].namespace, 'functions')
  } else {
    assert.ok(body.tools?.length, 'The compatibility request lost its current tool declarations')
    assert.ok(!(body.input ?? []).some(item => item.type === 'additional_tools'))
    const schema = protocol === 'anthropic' ? exec[0].input_schema : exec[0].parameters
    if (exec[0].type !== 'custom') {
      assert.equal(
        schema?.properties?.input?.type,
        'string',
        'Custom exec lost its raw input schema'
      )
      assert.ok(schema.required.includes('input'))
    }
  }
  return exec[0]
}

export function assertCodeModeOutput(body, protocol, { callId, script, marker }) {
  if (protocol === 'responses') {
    const call = body.input?.find(item => item.call_id === callId && item.type?.endsWith('_call'))
    assert.ok(call, 'Responses history lost the original exec call')
    assert.ok(
      ['exec', 'functions__exec'].includes(call.name),
      'Responses exec was routed to the wrong tool'
    )
    assert.equal(
      call.type === 'custom_tool_call' ? call.input : JSON.parse(call.arguments).input,
      script,
      'The exec script changed across the Responses round trip'
    )
    const output = body.input.find(
      item => item.call_id === callId && item.type?.endsWith('_call_output')
    )
    assert.ok(output, 'Responses history lost the matching exec result')
    assert.ok(
      JSON.stringify(output.output).includes(marker),
      'The real exec result lost its marker'
    )
    return
  }
  if (protocol === 'chat') {
    const calls = (body.messages ?? []).flatMap(message => message.tool_calls ?? [])
    const call = calls.find(item => item.id === callId)
    assert.ok(call, 'Chat history lost the original exec call')
    assert.ok(
      ['exec', 'functions__exec'].includes(call.function.name),
      'Chat exec was routed to the wrong tool'
    )
    assert.equal(JSON.parse(call.function.arguments).input, script)
    const output = body.messages.find(
      message => message.role === 'tool' && message.tool_call_id === callId
    )
    assert.ok(output, 'Chat history lost the matching exec result')
    assert.ok(JSON.stringify(output.content).includes(marker))
    return
  }
  assert.equal(protocol, 'anthropic')
  const blocks = (body.messages ?? []).flatMap(message => message.content ?? [])
  const call = blocks.find(block => block.type === 'tool_use' && block.id === callId)
  assert.ok(call, 'Anthropic history lost the original exec call')
  assert.ok(
    ['exec', 'functions__exec'].includes(call.name),
    'Anthropic exec was routed to the wrong tool'
  )
  assert.equal(call.input.input, script)
  const output = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === callId)
  assert.ok(output, 'Anthropic history lost the matching exec result')
  assert.ok(JSON.stringify(output.content).includes(marker))
}
