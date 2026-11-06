import { programmaticInput } from './model-tool-catalog.mjs'

export function functionCall(callId, name, argumentsValue, outputIndex = 0) {
  const argumentsText = JSON.stringify(argumentsValue)
  const itemId = `fc_${callId}`
  return [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name,
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: outputIndex,
      item_id: itemId,
      call_id: callId,
      delta: argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: outputIndex,
      item_id: itemId,
      call_id: callId,
      arguments: argumentsText,
    },
    {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name,
        arguments: argumentsText,
      },
    },
  ]
}

export function namespacedFunctionCall(callId, namespace, name, argumentsValue, outputIndex = 0) {
  return functionCall(callId, name, argumentsValue, outputIndex).map(event => ({
    ...event,
    item: { ...event.item, namespace },
  }))
}

export function customToolCall(callId, name, input) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `fc_${callId}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: callId,
      name,
      input,
    },
  }
}

export function selectedToolCall(callId, selection, outputIndex = 0) {
  if (selection.codeMode) {
    const input = selection.codeMode.targetName
      ? programmaticInput(selection.codeMode.targetName, selection.arguments)
      : selection.codeMode.input
    if (selection.codeMode.type === 'function')
      return selectedToolCall(
        callId,
        {
          name: selection.codeMode.name,
          namespace: selection.codeMode.namespace,
          arguments: { input },
        },
        outputIndex
      )
    const event = customToolCall(callId, selection.codeMode.name, input)
    event.output_index = outputIndex
    if (selection.codeMode.namespace) event.item.namespace = selection.codeMode.namespace
    return [event]
  }
  return selection.namespace
    ? namespacedFunctionCall(
        callId,
        selection.namespace,
        selection.name,
        selection.arguments,
        outputIndex
      )
    : functionCall(callId, selection.name, selection.arguments, outputIndex)
}
