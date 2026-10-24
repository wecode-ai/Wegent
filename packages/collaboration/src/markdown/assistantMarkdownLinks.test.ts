import { describe, expect, it } from "vitest";

import { toDingTalkClientUrl } from "./assistantMarkdownLinks";

describe("toDingTalkClientUrl", () => {
  it("wraps DingTalk mini-app pages in a DingTalk client deep link", () => {
    const url =
      "https://n.dingtalk.com/dingding/dd-todo/detail/index.html?taskId=58547524601&bizTag=teambition#/detail";

    expect(toDingTalkClientUrl(url)).toBe(
      `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(url)}&pc_slide=true`,
    );
  });

  it("leaves regular web links and existing deep links unchanged", () => {
    expect(toDingTalkClientUrl("https://example.com/todo")).toBeNull();
    expect(
      toDingTalkClientUrl(
        "dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fexample.com&pc_slide=true",
      ),
    ).toBeNull();
  });
});
