import { afterEach, expect, it, vi } from "vitest";
import { createIssueDrawerDiagnostic } from "./issueDrawerDiagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("bounds lifecycle records and retains terminal phases without animation content", () => {
  class Transition {
    transitionProperty = "private-animation-name";
    playState = "running";
    currentTime = Infinity;
    pending = true;
    privateBody = "private-issue-body";
  }
  vi.stubGlobal("CSSTransition", Transition);
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const diagnostic = createIssueDrawerDiagnostic();
  const animation = new Transition() as unknown as Animation;

  for (let index = 0; index < 100; index += 1)
    diagnostic.record("wait-animations", [animation]);
  diagnostic.record("commit-callback");
  diagnostic.record("unmounted");

  expect(debug).toHaveBeenCalledTimes(34);
  expect(debug.mock.calls.at(-1)?.[1]).toMatchObject({
    instanceId: diagnostic.instanceId,
    phase: "unmounted",
  });
  expect(debug.mock.calls[0][1]).toMatchObject({
    animations: [
      {
        property: "other",
        playState: "running",
        currentTime: null,
        pending: true,
      },
    ],
  });
  expect(JSON.stringify(debug.mock.calls)).not.toMatch(
    /private-animation|private-issue/,
  );
});

it("cannot propagate a failing diagnostic sink or animation getter into closing", () => {
  const diagnostic = createIssueDrawerDiagnostic();
  vi.spyOn(console, "debug").mockImplementation(() => {
    throw new Error("Unavailable diagnostic sink");
  });
  expect(() => diagnostic.record("request-close")).not.toThrow();
  const animation = {
    get playState() {
      throw new Error("Destroyed animation");
    },
  } as Animation;
  expect(() => diagnostic.record("wait-animations", [animation])).not.toThrow();
});
