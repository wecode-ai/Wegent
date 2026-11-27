// @ts-check

const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im;

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
  const request = content.slice(sourceStart).trimEnd();
  return {
    content: request,
    sourceStart,
    sourceEnd: sourceStart + request.length,
  };
}
