// @ts-check

const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im;
const APPLICATION_CONTEXT_OPEN = "<application_context>";
const APPLICATION_CONTEXT_CLOSE = "</application_context>";

/**
 * @param {string} content
 * @returns {import('./runtime-user-message.js').RuntimeUserMessageParts | null}
 */
export function splitRuntimeUserMessage(content) {
  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN);
  if (requestMarker?.index === undefined) return null;

  return {
    prefix: content.slice(0, requestMarker.index),
    request: projectRuntimeUserText(content).content,
  };
}

/** @param {string} content */
export function visibleRuntimeUserMessage(content) {
  return projectRuntimeUserText(content).content;
}

/**
 * Keep the actual request slice so display and search share its provenance.
 * @param {string} content
 * @returns {import('./runtime-user-message.js').RuntimeUserTextProjection}
 */
export function projectRuntimeUserText(content) {
  const marker = content.match(CODEX_REQUEST_MARKER_PATTERN);
  let sourceStart =
    marker?.index === undefined ? 0 : marker.index + marker[0].length;
  sourceStart +=
    content.slice(sourceStart).length -
    content.slice(sourceStart).trimStart().length;
  const remaining = content.slice(sourceStart);
  if (remaining.startsWith(APPLICATION_CONTEXT_OPEN)) {
    const closeIndex = matchingApplicationContextCloseIndex(remaining);
    if (closeIndex >= 0)
      sourceStart += closeIndex + APPLICATION_CONTEXT_CLOSE.length;
  }
  sourceStart +=
    content.slice(sourceStart).length -
    content.slice(sourceStart).trimStart().length;
  const request = content.slice(sourceStart).trimEnd();
  return {
    content: request,
    sourceStart,
    sourceEnd: sourceStart + request.length,
  };
}

/** @param {string} content */
function matchingApplicationContextCloseIndex(content) {
  let depth = 1;
  let offset = APPLICATION_CONTEXT_OPEN.length;

  while (offset < content.length) {
    const nextOpen = content.indexOf(APPLICATION_CONTEXT_OPEN, offset);
    const nextClose = content.indexOf(APPLICATION_CONTEXT_CLOSE, offset);
    if (nextClose < 0) return -1;

    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      offset = nextOpen + APPLICATION_CONTEXT_OPEN.length;
      continue;
    }

    depth -= 1;
    if (depth === 0) return nextClose;
    offset = nextClose + APPLICATION_CONTEXT_CLOSE.length;
  }

  return -1;
}
