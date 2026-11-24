import { createConversationSwitchingChecks } from '../modules/streaming-conversation-switching.mjs'
import { createBackgroundWindowRefreshChecks } from '../modules/background-window-refresh.mjs'
import { createComposerLayoutChecks } from '../modules/streaming-text-composer-layout.mjs'
import { createConversationScrollbarChecks } from '../modules/streaming-text-scrollbar.mjs'
import { createRichTaskSwitchChecks } from '../modules/streaming-text-rich-task-switch.mjs'
import { createStreamingCompletionChecks } from '../modules/streaming-text-completion.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { handleEmptyReplyPrediction, selectTool } from '../modules/response-protocol.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  SUBAGENT_CHILD_STARTUP_TIMEOUT_MS,
  SUBAGENT_CHILD_TOOL_TIMEOUT_MS,
  readJson,
  GENERATED_IMAGE_REVISED_PROMPT,
  ATTACHMENT_BASE64,
  latestModelInputText,
  streamingEvents,
  SUBAGENT_CHILD_COMMENTARY,
  selectShellTool,
  SUBAGENT_CHILD_TOOL_START,
  SUBAGENT_CHILD_TOOL_COMPLETE,
  sse,
  responseCreated,
  reasoningEvents,
  SUBAGENT_CHILD_REASONING,
  textDeltaEvents,
  SUBAGENT_CHILD_TOOL_CALL_ID,
  responseCompleted,
  requestContainsToolOutputForCall,
  SUBAGENT_CHILD_COMPLETION,
  SUBAGENT_CHILD_PARTIAL,
  SUBAGENT_WAIT_CALL_ID,
  assistantMessage,
  SUBAGENT_PARENT_COMPLETION,
  SUBAGENT_CALL_ID,
  RECLASSIFIED_COMMENTARY_CALL_ID,
  RECLASSIFIED_COMMENTARY_FINAL,
  requestContainsReclassifiedCommentaryPrompt,
  RECLASSIFIED_COMMENTARY_TEXT,
  reclassifiedCommentaryToolEvents,
  requestContainsSubagentPrompt,
  SUBAGENT_CHILD_PROMPT,
  GENERATED_IMAGE_CALL_ID,
  GENERATED_IMAGE_COMPLETION,
  requestContainsPrompt,
  COMPLETION_TEXT,
  PARTIAL_TEXT,
  APPENDED_TEXT,
  SCROLL_BUTTON_APPENDED_TEXT,
  requestContainsVisualizationPrompt,
  VISUALIZATION_TITLE,
  requestContainsGeneratedImagePrompt,
  selectImageGenerationTool,
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
import { createStreamingTranscriptIdentityChecks } from '../modules/streaming-transcript-identity.mjs'
import { createStreamingGuidanceOrderChecks } from '../modules/streaming-text-guidance-order.mjs'
import { createInteractiveVisualizationChecks } from '../modules/streaming-interactive-visualization.mjs'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'
import { createVisualizationScrollChecks } from '../modules/streaming-visualization-scroll.mjs'

export function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  resultDir,
  standalone,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  recordScenarioRequest,
  codexSqliteHome,
  workspacePath,
  beforeSubagentOutput,
  subagentTextRelease,
}) {
  const completion = createStreamingCompletionChecks({ resultDir, uiTimeoutMs })
  const conversationSwitching = createConversationSwitchingChecks({ uiTimeoutMs, resultDir })
  const backgroundWindowRefresh = createBackgroundWindowRefreshChecks({ uiTimeoutMs })
  const conversationScrollbar = createConversationScrollbarChecks({ resultDir, uiTimeoutMs })
  const richTaskSwitch = createRichTaskSwitchChecks({ resultDir, uiTimeoutMs, codexSqliteHome })
  const composerLayout = createComposerLayoutChecks({ workspacePath, resultDir, uiTimeoutMs })
  const transcriptIdentity = createStreamingTranscriptIdentityChecks({ uiTimeoutMs })
  const guidanceOrder = createStreamingGuidanceOrderChecks({ resultDir, uiTimeoutMs })
  const interactiveVisualization = createInteractiveVisualizationChecks({
    workspacePath,
    uiTimeoutMs,
    captureScreenshot,
  })
  const visualizationScroll = createVisualizationScrollChecks({ workspacePath, uiTimeoutMs })
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  const captureSubagent = (control, name) => captureScreenshot(control, name, 'body')
  const subagentToolRenderTimeoutMs =
    SUBAGENT_CHILD_STARTUP_TIMEOUT_MS + SUBAGENT_CHILD_TOOL_TIMEOUT_MS + uiTimeoutMs
  let active = false
  let generatedImageStage = 'initial'
  let subagentStage = 'initial'
  let subagentChildStage = 'initial'
  let reclassifiedCommentaryStage = 'initial'
  let releaseAppend
  let releaseReclassifiedCommentaryFinal
  let releaseResponse
  let releaseScrollButtonAppend
  let releaseStart
  let releaseSubagentCompletion
  let resolveAppendWritten
  let resolvePartialWritten
  let resolveReclassifiedCommentaryFollowUp
  let resolveRequest
  let resolveScrollButtonAppendWritten
  let resolveSubagentChildRequestStarted
  let resolveSubagentPartialWritten
  let targetRequest
  let completionRequestHeaders
  const appendRelease = new Promise(resolve => {
    releaseAppend = resolve
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

  const { verifyContent } = createStreamingContentChecks({
    workspacePath,
    uiTimeoutMs,
    capture,
    reclassifiedCommentaryFollowUpReceived,
    releaseReclassifiedCommentaryFinal,
  })
  const { verifySubagentStreamingPanel } = createStreamingToolChecks({
    uiTimeoutMs,
    resultDir,
    capture,
    modelResponseTimeoutMs,
    captureSubagent,
    subagentToolRenderTimeoutMs,
    subagentPartialWritten,
    releaseSubagentCompletion,
    beforeSubagentOutput,
  })

  return {
    cleanup() {
      backgroundWindowRefresh.cleanup()
      completion.cleanup()
      guidanceOrder.cleanup()
    },
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
      model.experimental_supported_tools = [
        ...new Set([...(model.experimental_supported_tools ?? []), 'request_user_input_async']),
      ]
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
      if (await backgroundWindowRefresh.handleModelRequest(body, response, responseId)) return true
      if (await conversationSwitching.handleModelRequest(body, response, responseId)) return true
      if (await conversationScrollbar.handleModelRequest(body, response, responseId)) return true
      if (await composerLayout.handleModelRequest(body, response, responseId)) return true
      if (await richTaskSwitch.handleModelRequest(body, response, responseId)) return true
      if (await completion.handleModelRequest(body, response, responseId)) {
        completionRequestHeaders = request.headers
        return true
      }
      if (await transcriptIdentity.handleModelRequest(body, response, responseId)) return true
      if (await guidanceOrder.handleModelRequest(body, response, responseId)) return true
      if (await interactiveVisualization.handleModelRequest(body, response, responseId)) return true
      if (await visualizationScroll.handleModelRequest(body, response, responseId)) return true
      const latestInput = latestModelInputText(body)
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
              ...selectedToolCall(SUBAGENT_CHILD_TOOL_CALL_ID, tool),
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
        await subagentTextRelease
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
            ...selectedToolCall(
              SUBAGENT_WAIT_CALL_ID,
              selectTool(body, 'wait_agent', { timeout_ms: 60_000 })
            ),
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
        subagentStage = 'awaiting-spawn-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            ...selectedToolCall(
              SUBAGENT_CALL_ID,
              selectTool(body, 'spawn_agent', {
                task_name: 'streaming_panel',
                message: SUBAGENT_CHILD_PROMPT,
                agent_type: 'explorer',
              })
            ),
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
        const toolCallEvents = selectedToolCall(GENERATED_IMAGE_CALL_ID, tool)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([responseCreated(responseId), ...toolCallEvents, responseCompleted(responseId)])
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
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })
      active = true
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: 'wework:debug-runtime-chat-stream', value: '1' }),
      })
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: 'wework:debug-runtime', value: '1' }),
      })
      await requestExecutor(
        control,
        'runtime.codex.stream_debug.set',
        { enabled: true },
        uiTimeoutMs
      )
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
      if (process.env.WEWORK_E2E_SUBAGENT_ONLY === 'true') {
        await verifySubagentStreamingPanel(control)
        active = false
        return
      }

      const checks = new Map([
        [
          'streaming-content',
          async control => {
            await completion.verify(control)
            assert.match(
              completionRequestHeaders?.['x-wework-version'] ?? '',
              /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/,
              'The upstream model request did not receive the Wework version'
            )
            assert.ok(
              completionRequestHeaders['x-wework-platform'],
              'The upstream model request did not receive the Wework platform'
            )
            assert.ok(
              completionRequestHeaders['x-wework-arch'],
              'The upstream model request did not receive the Wework architecture'
            )
            await verifyContent(control)
            await interactiveVisualization.verify(control)
            await visualizationScroll.verify(control)
            await transcriptIdentity.verify(control)
            await guidanceOrder.verify(control)
          },
        ],
        [
          'streaming-conversation-switching',
          async control => {
            await backgroundWindowRefresh.verify(control)
            await composerLayout.verify(control)
            await conversationSwitching.verify(control)
            await conversationScrollbar.verify(control)
            await richTaskSwitch.verify(control)
          },
        ],
        ['streaming-subagent-guidance', verifySubagentStreamingPanel],
      ])
      const selectedCheckpoint = checkpoint?.startsWith('streaming-')
        ? checkpoint
        : process.env.WEWORK_E2E_VISUALIZATION_ONLY === 'true' ||
            process.env.WEWORK_E2E_GENERATED_IMAGE_ONLY === 'true'
          ? 'streaming-content'
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
