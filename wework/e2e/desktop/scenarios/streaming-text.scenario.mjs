import { handleEmptyReplyPrediction } from '../modules/response-protocol.mjs'
import {
  createMarkdownLinkChecks,
  MARKDOWN_LINKS_PROMPT,
} from '../modules/streaming-text-markdown-links.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  SUBAGENT_CHILD_STARTUP_TIMEOUT_MS,
  SUBAGENT_CHILD_TOOL_TIMEOUT_MS,
  readJson,
  GENERATED_IMAGE_REVISED_PROMPT,
  ATTACHMENT_BASE64,
  latestModelInputText,
  orderFollowUpNumber,
  streamingEvents,
  longCodeStreamingEvents,
  SUBAGENT_CHILD_COMMENTARY,
  selectShellTool,
  SUBAGENT_CHILD_TOOL_START,
  SUBAGENT_CHILD_TOOL_COMPLETE,
  sse,
  responseCreated,
  reasoningEvents,
  SUBAGENT_CHILD_REASONING,
  textDeltaEvents,
  functionCall,
  SUBAGENT_CHILD_TOOL_CALL_ID,
  responseCompleted,
  requestContainsToolOutputForCall,
  SUBAGENT_CHILD_COMPLETION,
  SUBAGENT_CHILD_PARTIAL,
  SUBAGENT_WAIT_CALL_ID,
  assistantMessage,
  SUBAGENT_PARENT_COMPLETION,
  SUBAGENT_CALL_ID,
  namespacedFunctionCall,
  RECLASSIFIED_COMMENTARY_CALL_ID,
  RECLASSIFIED_COMMENTARY_FINAL,
  requestContainsReclassifiedCommentaryPrompt,
  RECLASSIFIED_COMMENTARY_TEXT,
  reclassifiedCommentaryToolEvents,
  requestContainsSubagentPrompt,
  SUBAGENT_CHILD_PROMPT,
  GENERATED_IMAGE_CALL_ID,
  GENERATED_IMAGE_COMPLETION,
  LONG_CODE_PROMPT,
  LONG_CODE_COMPLETION,
  LONG_CODE_STREAM_MARKER,
  ORDER_FOLLOW_UP_COUNT,
  ORDER_COMPLETION_PREFIX,
  ORDER_STOP_PROMPT,
  ORDER_STOP_PARTIAL,
  TOOL_DETAIL_PERSISTENCE_CALL_ID,
  TOOL_DETAIL_PERSISTENCE_COMPLETION,
  requestContainsToolOutput,
  TIMER_COMPLETION,
  TOOL_COMPLETION,
  writeSseEvents,
  requestContainsTimerPrompt,
  requestContainsPrompt,
  COMPLETION_TEXT,
  PARTIAL_TEXT,
  APPENDED_TEXT,
  SCROLL_BUTTON_APPENDED_TEXT,
  requestContainsToolRegressionPrompt,
  REASONING_SUMMARY,
  TOOL_PREAMBLE,
  requestContainsToolDetailPersistencePrompt,
  TOOL_DETAIL_PERSISTENCE_OUTPUT,
  requestContainsPhaseFlipPrompt,
  phaseFlipEvents,
  requestContainsLegacyConversationPrompt,
  LEGACY_CONVERSATION_COMPLETION,
  requestContainsVisualizationPrompt,
  VISUALIZATION_TITLE,
  requestContainsGeneratedImagePrompt,
  selectImageGenerationTool,
  requestContainsWindowsLinkPrompt,
  WINDOWS_LINK_COMPLETION,
  findHistoryTurn,
  requestContainsInitialPrompt,
  INITIAL_COMPLETION,
  createLocalProject,
  openNewChatWithE2EModel,
} from '../modules/streaming-text-fixture.mjs'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from '../modules/shared.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { createStreamingContentChecks } from '../modules/streaming-text-content.mjs'
import { createStreamingToolChecks } from '../modules/streaming-text-tools.mjs'
import { createStreamingScrollChecks } from '../modules/streaming-text-scroll.mjs'
import { createStreamingTranscriptIdentityChecks } from '../modules/streaming-transcript-identity.mjs'

export function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  resultDir,
  standalone,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  recordScenarioRequest,
  workspacePath,
}) {
  const markdownLinks = createMarkdownLinkChecks({ captureScreenshot, workspacePath, uiTimeoutMs })
  const transcriptIdentity = createStreamingTranscriptIdentityChecks({ uiTimeoutMs })
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  const captureSubagent = (control, name) => captureScreenshot(control, name, 'body')
  const subagentToolRenderTimeoutMs =
    SUBAGENT_CHILD_STARTUP_TIMEOUT_MS + SUBAGENT_CHILD_TOOL_TIMEOUT_MS + uiTimeoutMs
  let active = false
  let generatedImageStage = 'initial'
  let subagentStage = 'initial'
  let subagentChildStage = 'initial'
  let toolDetailPersistenceStage = 'initial'
  let toolRegressionStage = 'initial'
  let reclassifiedCommentaryStage = 'initial'
  let timerStage = 'initial'
  let releaseAppend
  let releaseLongCodeStream
  let releasePhaseFlipCompletion
  let releaseReclassifiedCommentaryFinal
  let releaseResponse
  let releaseScrollButtonAppend
  let releaseStart
  let releaseSubagentCompletion
  let releaseToolDetailPersistenceCompletion
  let releaseToolDetailPersistenceFinalText
  let releaseToolCompletion
  let releaseToolFinalCompletion
  let releaseTimerFinalCompletion
  let resolveAppendWritten
  let resolvePartialWritten
  let resolveReclassifiedCommentaryFollowUp
  let resolveRequest
  let resolveScrollButtonAppendWritten
  let resolveSubagentChildRequestStarted
  let resolveSubagentPartialWritten
  let resolveToolDetailPersistenceFinalTextStarted
  let resolveToolDetailPersistenceFollowUp
  let resolveToolFinalTextStarted
  let resolveToolFollowUp
  let targetRequest
  const appendRelease = new Promise(resolve => {
    releaseAppend = resolve
  })
  const longCodeStreamRelease = new Promise(resolve => {
    releaseLongCodeStream = resolve
  })
  const phaseFlipCompletionRelease = new Promise(resolve => {
    releasePhaseFlipCompletion = resolve
  })
  const reclassifiedCommentaryFinalRelease = new Promise(resolve => {
    releaseReclassifiedCommentaryFinal = resolve
  })
  const responseRelease = new Promise(resolve => {
    releaseResponse = resolve
  })
  const scrollButtonAppendRelease = new Promise(resolve => {
    releaseScrollButtonAppend = resolve
  })
  const startRelease = new Promise(resolve => {
    releaseStart = resolve
  })
  const appendWritten = new Promise(resolve => {
    resolveAppendWritten = resolve
  })
  const partialWritten = new Promise(resolve => {
    resolvePartialWritten = resolve
  })
  const scrollButtonAppendWritten = new Promise(resolve => {
    resolveScrollButtonAppendWritten = resolve
  })
  const requestReceived = new Promise(resolve => {
    resolveRequest = resolve
  })
  const reclassifiedCommentaryFollowUpReceived = new Promise(resolve => {
    resolveReclassifiedCommentaryFollowUp = resolve
  })
  const subagentCompletionRelease = new Promise(resolve => {
    releaseSubagentCompletion = resolve
  })
  const subagentChildRequestStarted = new Promise(resolve => {
    resolveSubagentChildRequestStarted = resolve
  })
  const subagentPartialWritten = new Promise(resolve => {
    resolveSubagentPartialWritten = resolve
  })
  const toolDetailPersistenceCompletionRelease = new Promise(resolve => {
    releaseToolDetailPersistenceCompletion = resolve
  })
  const toolDetailPersistenceFinalTextRelease = new Promise(resolve => {
    releaseToolDetailPersistenceFinalText = resolve
  })
  const toolDetailPersistenceFollowUpReceived = new Promise(resolve => {
    resolveToolDetailPersistenceFollowUp = resolve
  })
  const toolDetailPersistenceFinalTextStarted = new Promise(resolve => {
    resolveToolDetailPersistenceFinalTextStarted = resolve
  })
  const toolCompletionRelease = new Promise(resolve => {
    releaseToolCompletion = resolve
  })
  const timerFinalCompletionRelease = new Promise(resolve => {
    releaseTimerFinalCompletion = resolve
  })
  const toolFollowUpReceived = new Promise(resolve => {
    resolveToolFollowUp = resolve
  })
  const toolFinalTextStarted = new Promise(resolve => {
    resolveToolFinalTextStarted = resolve
  })
  const toolFinalCompletionRelease = new Promise(resolve => {
    releaseToolFinalCompletion = resolve
  })

  const { verifyContent } = createStreamingContentChecks({
    workspacePath,
    uiTimeoutMs,
    capture,
    reclassifiedCommentaryFollowUpReceived,
    releaseReclassifiedCommentaryFinal,
  })
  const {
    verifyTools,
    verifyLongCodeTerminalBurst,
    verifyStoppedTurnOrder,
    verifySubagentStreamingPanel,
  } = createStreamingToolChecks({
    uiTimeoutMs,
    releaseLongCodeStream,
    resultDir,
    capture,
    modelResponseTimeoutMs,
    captureSubagent,
    subagentToolRenderTimeoutMs,
    subagentPartialWritten,
    releaseSubagentCompletion,
    releasePhaseFlipCompletion,
    toolFollowUpReceived,
    releaseToolCompletion,
    releaseToolFinalCompletion,
    toolFinalTextStarted,
    toolDetailPersistenceFollowUpReceived,
    releaseToolDetailPersistenceFinalText,
    releaseToolDetailPersistenceCompletion,
    toolDetailPersistenceFinalTextStarted,
  })
  const { verifyTimers, verifyScroll } = createStreamingScrollChecks({
    modelResponseTimeoutMs,
    uiTimeoutMs,
    capture,
    releaseTimerFinalCompletion,
    requestReceived,
    getTargetRequest: () => targetRequest,
    releaseStart,
    partialWritten,
    releaseAppend,
    appendWritten,
    releaseScrollButtonAppend,
    scrollButtonAppendWritten,
    releaseResponse,
  })
  return {
    codexConfigToml: '\n[features.multi_agent_v2]\nenabled = true\n',
    modelProviderAuthToml: '',
    modelProviderConfigToml:
      'http_headers = { Authorization = "Bearer wework-e2e-test-key", "x-openai-actor-authorization" = "wework-desktop-e2e" }\n',
    appEnvironment: {
      WEWORK_E2E_SEED_LOCAL_MODELS: 'false',
    },

    async prepareApp({ appEnvironment, codexHome }) {
      const { stdout } = await promisify(execFile)(
        appEnvironment.CODEX_BINARY_PATH,
        ['debug', 'models', '--bundled'],
        { env: appEnvironment, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }
      )
      const catalog = JSON.parse(stdout)
      const model = catalog.models.find(entry => entry.slug === DEFAULT_MODEL_ID)
      assert.ok(model, 'The rendering fixture model is missing from the native catalog')
      // Rendering assertions exercise direct tools with the shared fixture label.
      model.tool_mode = 'direct'
      model.use_responses_lite = false
      model.display_name = DEFAULT_MODEL_LABEL
      const catalogPath = join(codexHome, 'rendering-model-catalog.json')
      await writeFile(catalogPath, JSON.stringify(catalog))
      const configPath = join(codexHome, 'config.toml')
      const config = await readFile(configPath, 'utf8')
      await writeFile(configPath, `model_catalog_json = ${JSON.stringify(catalogPath)}\n${config}`)
    },

    async handleHttp(request, response, url) {
      if (!active) return false
      if (
        request.method === 'POST' &&
        ['/v1/images/generations', '/images/generations'].includes(url.pathname)
      ) {
        assert.equal(
          generatedImageStage,
          'awaiting-image-api',
          `Unexpected generated-image API stage: ${generatedImageStage}`
        )
        const body = await readJson(request)
        assert.equal(body.prompt, GENERATED_IMAGE_REVISED_PROMPT)
        assert.equal(body.model, 'gpt-image-2')
        generatedImageStage = 'awaiting-tool-output'
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: ATTACHMENT_BASE64 }],
          })
        )
        return true
      }
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const responseId = `wework-streaming-text-${Date.now()}`
      if (await transcriptIdentity.handleModelRequest(body, response, responseId)) return true
      const latestInput = latestModelInputText(body)
      if (latestInput.includes(MARKDOWN_LINKS_PROMPT)) {
        recordScenarioRequest('markdown_original_links', body)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(markdownLinks.completion),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      const followUpNumber = orderFollowUpNumber(body)
      if (isCollaborationSubagentRequest(request.headers)) {
        resolveSubagentChildRequestStarted()
        if (subagentChildStage === 'initial') {
          const commentary = streamingEvents(
            `${responseId}-commentary`,
            SUBAGENT_CHILD_COMMENTARY,
            'commentary'
          )
          const tool = selectShellTool(
            body,
            workspacePath,
            `printf '${SUBAGENT_CHILD_TOOL_START}\\n'; sleep 2; printf '${SUBAGENT_CHILD_TOOL_COMPLETE}\\n'`,
            SUBAGENT_CHILD_TOOL_TIMEOUT_MS
          )
          subagentChildStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...reasoningEvents(`${responseId}-reasoning`, SUBAGENT_CHILD_REASONING, 8),
              ...commentary.start.slice(1),
              ...textDeltaEvents(commentary.itemId, SUBAGENT_CHILD_COMMENTARY),
              ...commentary.finish.slice(0, -1),
              ...functionCall(SUBAGENT_CHILD_TOOL_CALL_ID, tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        assert.equal(
          subagentChildStage,
          'awaiting-tool-output',
          `Unexpected subagent child stage: ${subagentChildStage}`
        )
        assert.ok(
          requestContainsToolOutputForCall(body, SUBAGENT_CHILD_TOOL_CALL_ID),
          'The child tool output was not returned to the subagent'
        )
        subagentChildStage = 'streaming-text'
        const stream = streamingEvents(responseId, SUBAGENT_CHILD_COMPLETION, 'final_answer')
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        response.write(sse(textDeltaEvents(stream.itemId, SUBAGENT_CHILD_PARTIAL)))
        response.flush?.()
        resolveSubagentPartialWritten()
        await subagentCompletionRelease
        response.write(
          sse(
            textDeltaEvents(
              stream.itemId,
              SUBAGENT_CHILD_COMPLETION.slice(SUBAGENT_CHILD_PARTIAL.length),
              SUBAGENT_CHILD_PARTIAL.length
            )
          )
        )
        subagentChildStage = 'complete'
        response.end(sse(stream.finish))
        return true
      }
      if (
        subagentStage === 'awaiting-wait-output' &&
        requestContainsToolOutputForCall(body, SUBAGENT_WAIT_CALL_ID)
      ) {
        subagentStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(SUBAGENT_PARENT_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (
        subagentStage === 'awaiting-spawn-output' &&
        requestContainsToolOutputForCall(body, SUBAGENT_CALL_ID)
      ) {
        await subagentChildRequestStarted
        subagentStage = 'awaiting-wait-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            ...namespacedFunctionCall(SUBAGENT_WAIT_CALL_ID, 'collaboration', 'wait_agent', {
              timeout_ms: 60_000,
            }),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (
        reclassifiedCommentaryStage === 'awaiting-tool-output' &&
        requestContainsToolOutputForCall(body, RECLASSIFIED_COMMENTARY_CALL_ID)
      ) {
        reclassifiedCommentaryStage = 'awaiting-final-release'
        resolveReclassifiedCommentaryFollowUp()
        await reclassifiedCommentaryFinalRelease
        reclassifiedCommentaryStage = 'complete'
        const stream = streamingEvents(responseId, RECLASSIFIED_COMMENTARY_FINAL, 'final_answer')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            ...stream.start,
            ...textDeltaEvents(stream.itemId, RECLASSIFIED_COMMENTARY_FINAL),
            ...stream.finish,
          ])
        )
        return true
      }
      if (requestContainsReclassifiedCommentaryPrompt(body)) {
        assert.equal(
          reclassifiedCommentaryStage,
          'initial',
          `Unexpected reclassified-commentary stage: ${reclassifiedCommentaryStage}`
        )
        const tool = selectShellTool(
          body,
          workspacePath,
          `printf '${RECLASSIFIED_COMMENTARY_TEXT}\\n'`
        )
        reclassifiedCommentaryStage = 'awaiting-tool-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse(reclassifiedCommentaryToolEvents(responseId, tool)))
        return true
      }
      if (requestContainsSubagentPrompt(body)) {
        assert.equal(subagentStage, 'initial', `Unexpected subagent stage: ${subagentStage}`)
        const collaborationTools = (body.tools ?? []).find(
          tool => tool?.type === 'namespace' && tool.name === 'collaboration'
        )?.tools
        const collaborationToolNames = new Set(
          (collaborationTools ?? []).map(tool => tool?.name).filter(Boolean)
        )
        assert.ok(
          collaborationToolNames.has('spawn_agent'),
          'The native collaboration.spawn_agent tool was not available'
        )
        assert.ok(
          collaborationToolNames.has('wait_agent'),
          'The native collaboration.wait_agent tool was not available'
        )
        subagentStage = 'awaiting-spawn-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            ...namespacedFunctionCall(SUBAGENT_CALL_ID, 'collaboration', 'spawn_agent', {
              task_name: 'streaming_panel',
              message: SUBAGENT_CHILD_PROMPT,
              agent_type: 'explorer',
            }),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (
        generatedImageStage === 'awaiting-tool-output' &&
        requestContainsToolOutputForCall(body, GENERATED_IMAGE_CALL_ID)
      ) {
        generatedImageStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(GENERATED_IMAGE_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (latestInput.includes(LONG_CODE_PROMPT)) {
        const stream = longCodeStreamingEvents(responseId)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        let offset = 0
        let streamedText = ''
        let streamHeld = false
        const codeEnd = LONG_CODE_COMPLETION.indexOf('\n```\n\n')
        assert.ok(codeEnd >= 0, 'The long-code fixture is missing its closing fence')
        const streamedCode = LONG_CODE_COMPLETION.slice(0, codeEnd + '\n```'.length)
        const windowedTail = LONG_CODE_COMPLETION.slice(streamedCode.length)
        for (const chunk of streamedCode.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, offset, stream.outputIndex)))
          response.flush?.()
          offset += [...chunk].length
          streamedText += chunk
          if (!streamHeld && streamedText.includes(LONG_CODE_STREAM_MARKER)) {
            streamHeld = true
            await longCodeStreamRelease
          }
          await new Promise(resolve => setTimeout(resolve, 16))
        }
        response.write(
          sse(textDeltaEvents(stream.itemId, windowedTail, offset, stream.outputIndex))
        )
        response.end(sse(stream.finish))
        return true
      }
      if (followUpNumber !== null) {
        response.once('finish', () => {
          recordScenarioRequest('message_order_follow_up', { followUpNumber })
        })
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.write(sse([responseCreated(responseId)]))
        if (followUpNumber === ORDER_FOLLOW_UP_COUNT) {
          response.write(sse([assistantMessage('继续检查耗时。', 'commentary')]))
          await new Promise(resolve => setTimeout(resolve, 2100))
        }
        response.end(
          sse([
            assistantMessage(`${ORDER_COMPLETION_PREFIX}_${followUpNumber}`),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (latestInput.includes(ORDER_STOP_PROMPT)) {
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse([responseCreated(responseId), assistantMessage(ORDER_STOP_PARTIAL)]))
        return true
      }
      if (
        toolDetailPersistenceStage === 'awaiting-tool-output' &&
        requestContainsToolOutputForCall(body, TOOL_DETAIL_PERSISTENCE_CALL_ID)
      ) {
        toolDetailPersistenceStage = 'awaiting-final-completion'
        resolveToolDetailPersistenceFollowUp()
        await toolDetailPersistenceFinalTextRelease
        const stream = streamingEvents(responseId, TOOL_DETAIL_PERSISTENCE_COMPLETION)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(
          sse([
            ...stream.start,
            ...textDeltaEvents(stream.itemId, TOOL_DETAIL_PERSISTENCE_COMPLETION),
          ])
        )
        resolveToolDetailPersistenceFinalTextStarted()
        await toolDetailPersistenceCompletionRelease
        toolDetailPersistenceStage = 'complete'
        response.end(sse(stream.finish))
        return true
      }
      if (timerStage === 'awaiting-tool-output' && requestContainsToolOutput(body)) {
        timerStage = 'awaiting-final-completion'
        const stream = streamingEvents(responseId, TIMER_COMPLETION)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.write(sse([...stream.start, ...textDeltaEvents(stream.itemId, TIMER_COMPLETION)]))
        await timerFinalCompletionRelease
        timerStage = 'complete'
        response.end(sse(stream.finish))
        return true
      }
      if (toolRegressionStage === 'awaiting-tool-output' && requestContainsToolOutput(body)) {
        toolRegressionStage = 'awaiting-completion-release'
        resolveToolFollowUp()
        await toolCompletionRelease
        const stream = streamingEvents(responseId, TOOL_COMPLETION, null)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        await writeSseEvents(response, textDeltaEvents(stream.itemId, TOOL_COMPLETION))
        resolveToolFinalTextStarted()
        await toolFinalCompletionRelease
        toolRegressionStage = 'complete'
        response.end(sse(stream.finish))
        return true
      }

      if (requestContainsTimerPrompt(body)) {
        if (timerStage === 'initial') {
          const tool = selectShellTool(body, workspacePath, 'sleep 15', 20_000)
          timerStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...functionCall('wework-running-timer', tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected running-timer stage: ${timerStage}`)
      }

      if (requestContainsPrompt(body)) {
        targetRequest = body
        resolveRequest()
        await startRelease
        const stream = streamingEvents(responseId, COMPLETION_TEXT, null)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        let partialOffset = 0
        for (const chunk of PARTIAL_TEXT.match(/[\s\S]{1,24}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, partialOffset)))
          response.flush?.()
          partialOffset += chunk.length
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        resolvePartialWritten()
        await appendRelease
        await new Promise(resolve => setTimeout(resolve, 100))
        let appendOffset = PARTIAL_TEXT.length
        for (const chunk of APPENDED_TEXT.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, appendOffset)))
          response.flush?.()
          appendOffset += [...chunk].length
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        resolveAppendWritten()
        await scrollButtonAppendRelease
        for (const chunk of SCROLL_BUTTON_APPENDED_TEXT.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, appendOffset)))
          response.flush?.()
          appendOffset += [...chunk].length
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        resolveScrollButtonAppendWritten()
        await responseRelease
        response.end(sse(stream.finish))
        return true
      }

      if (requestContainsToolRegressionPrompt(body)) {
        if (toolRegressionStage === 'initial') {
          const tool = selectShellTool(body, workspacePath)
          toolRegressionStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...reasoningEvents('wework-reasoning-summary', REASONING_SUMMARY),
              assistantMessage(TOOL_PREAMBLE),
              ...functionCall('wework-tool-text-offset', tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected tool-text-offset stage: ${toolRegressionStage}`)
      }

      if (requestContainsToolDetailPersistencePrompt(body)) {
        if (toolDetailPersistenceStage === 'initial') {
          const tool = selectShellTool(
            body,
            workspacePath,
            `printf '${TOOL_DETAIL_PERSISTENCE_OUTPUT}\\n'`
          )
          toolDetailPersistenceStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...functionCall(TOOL_DETAIL_PERSISTENCE_CALL_ID, tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected tool-detail-persistence stage: ${toolDetailPersistenceStage}`)
      }

      if (requestContainsPhaseFlipPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        const events = phaseFlipEvents(responseId)
        await writeSseEvents(response, events.slice(0, 4))
        await phaseFlipCompletionRelease
        await writeSseEvents(response, events.slice(4))
        response.end()
        return true
      }

      if (requestContainsLegacyConversationPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(LEGACY_CONVERSATION_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsVisualizationPrompt(body)) {
        const visualizationPath = join(workspacePath, 'visualizations', 'absolute-reference.html')
        const contentReference = `visualize${JSON.stringify({
          path: visualizationPath,
          mode: 'wide',
          title: VISUALIZATION_TITLE,
        })}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(contentReference),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsGeneratedImagePrompt(body)) {
        assert.equal(
          generatedImageStage,
          'initial',
          `Unexpected generated-image model stage: ${generatedImageStage}`
        )
        const tool = selectImageGenerationTool(body)
        generatedImageStage = 'awaiting-image-api'
        const toolCallEvents = tool.namespace
          ? namespacedFunctionCall(
              GENERATED_IMAGE_CALL_ID,
              tool.namespace,
              tool.name,
              tool.arguments
            )
          : functionCall(GENERATED_IMAGE_CALL_ID, tool.name, tool.arguments)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([responseCreated(responseId), ...toolCallEvents, responseCompleted(responseId)])
        )
        return true
      }

      if (requestContainsWindowsLinkPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(WINDOWS_LINK_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      const historyTurn = findHistoryTurn(body)
      if (historyTurn) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(historyTurn.completion),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsInitialPrompt(body)) {
        recordScenarioRequest('streaming_scroll_initial', body)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(INITIAL_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
      return true
    },

    async verify(control) {
      active = true
      if (standalone) {
        await createLocalProject(control, workspacePath, uiTimeoutMs)
      } else {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
      }
      await selectE2EModel(
        control,
        DEFAULT_MODEL_ID,
        DEFAULT_MODEL_LABEL,
        ACTIVE_WORKBENCH_SELECTOR
      )
      if (process.env.WEWORK_E2E_MESSAGE_ORDER_ONLY === 'true') {
        await verifyStoppedTurnOrder(control)
        active = false
        return
      }
      if (process.env.WEWORK_E2E_LONG_CODE_ONLY === 'true') {
        await verifyLongCodeTerminalBurst(control)
        active = false
        return
      }
      if (process.env.WEWORK_E2E_SUBAGENT_ONLY === 'true') {
        await verifySubagentStreamingPanel(control)
        active = false
        return
      }

      const checks = new Map([
        [
          'streaming-content',
          async control => {
            await verifyContent(control)
            await transcriptIdentity.verify(control)
          },
        ],
        [
          'streaming-tools',
          async control => {
            await markdownLinks.verify(control)
            await verifyTools(control)
          },
        ],
        ['streaming-timers', verifyTimers],
        ['streaming-scroll', verifyScroll],
        ['streaming-message-order', verifyStoppedTurnOrder],
        ['streaming-subagents', verifySubagentStreamingPanel],
      ])
      const selectedCheckpoint = checkpoint?.startsWith('streaming-')
        ? checkpoint
        : process.env.WEWORK_E2E_VISUALIZATION_ONLY === 'true' ||
            process.env.WEWORK_E2E_GENERATED_IMAGE_ONLY === 'true'
          ? 'streaming-content'
          : process.env.WEWORK_E2E_LEGACY_STREAM_ONLY === 'true'
            ? 'streaming-tools'
            : null
      if (selectedCheckpoint) {
        const check = checks.get(selectedCheckpoint)
        assert.ok(check, `Unknown streaming checkpoint: ${checkpoint}`)
        await check(control)
      } else {
        for (const check of checks.values()) await check(control)
      }
      active = false
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
