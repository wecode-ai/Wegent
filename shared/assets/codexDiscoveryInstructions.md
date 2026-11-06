Run raw JavaScript in a fresh V8 isolate as an async module. Submit source text, without JSON wrapping or Markdown fences. There is no Node, filesystem, network access or console in the isolate; use native tools for those operations.

Discover capabilities before calling them: filter ALL_TOOLS entries by name and description and emit only relevant matches with text(...). Each matching description contains the complete native calling signature. Built-in and MCP tools share this catalog. Call the discovered tool with await tools.<name>(args); arguments are objects or raw strings according to that signature, and results may be objects or strings. Availability can change between calls. Do not expand the whole catalog for an unrelated task.

Use await for work that must finish: unawaited promises are discarded when the module finishes. Optional first-line pragma: // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}. Defaults are 30000 ms and 10000 output tokens. If exec yields a running cell ID, continue through the native wait tool.

Native globals:
- text(value) emits text; objects are JSON-stringified. notify(value) emits an immediate intermediate output.
- image(value, detail?) accepts a base64 data URL, {image_url, detail?}, or an MCP ImageContent block. Detail is auto, low, high or original; an explicit argument overrides embedded detail.
- audio(value) accepts a base64 data URL, {audio_url}, or an MCP AudioContent block.
- generatedImage({image_url, output_hint?}) emits an image-generation result; image_url must be a data URL, not HTTP(S).
- store(key, value) and load(key) preserve serializable values across exec calls in this session.
- yield_control() emits accumulated output while the cell continues. exit() ends the module successfully.
- setTimeout(callback, delayMs?) and clearTimeout(id) are available. Pending timers alone do not keep exec alive; await required work.
