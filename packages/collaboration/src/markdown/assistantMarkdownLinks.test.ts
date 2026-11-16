import { describe, expect, it } from "vitest"
import { classifyMarkdownLink } from "./assistantMarkdownLinks"

describe("classifyMarkdownLink", () => {
  it("recognizes percent-encoded Windows absolute file links", () => {
    expect(
      classifyMarkdownLink(
        "<D:%5Ca%5CWegent%5Cwework%5Ctest-results%5Ccart-review.md>",
      ),
    ).toEqual({
      kind: "file",
      path: "D:\\a\\Wegent\\wework\\test-results\\cart-review.md",
    })
  })

  it("keeps remote links external", () => {
    expect(classifyMarkdownLink("https://example.com/cart-review.md")).toEqual({
      kind: "external",
    })
  })
})
