import { describe, expect, it, vi } from "vitest";
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
} from "./response-api-stream";

describe("native text item offsets", () => {
  it.each([
    [{ offset: 34, block_offset: 0 }, 0],
    [{ offset: 290, block_offset: 256 }, 256],
    [{ offset: 12 }, 12],
  ])("decodes %j as item offset %i", (offsets, expected) => {
    const onChatChunk = vi.fn();
    emitResponseApiEvent(
      { onChatChunk },
      "response.output_text.delta",
      {
        task_id: "1",
        subtask_id: "2",
        data: { item_id: "segment-2", delta: "text", ...offsets },
      },
      createResponseApiStreamState(),
    );
    expect(onChatChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "segment-2",
        content: "text",
        offset: expected,
      }),
    );
  });
});
