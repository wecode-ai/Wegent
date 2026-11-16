// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createComposerLinkElement } from "./composerLinks";

it("allows long composer link labels to wrap", () => {
  const element = createComposerLinkElement({
    url: "https://github.com/example/repository/commit/abc",
    label: "a".repeat(120),
    iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
    provider: "github",
  });

  const label = element.querySelector<HTMLSpanElement>(
    ".composer-mention-label",
  )!;
  expect(label.classList.contains("min-w-0")).toBe(true);
  expect(label.classList.contains("whitespace-normal")).toBe(true);
  expect(label.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
});
