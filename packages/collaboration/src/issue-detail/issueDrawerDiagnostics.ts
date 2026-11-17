const LOG_PREFIX = "[Wework] Issue drawer diagnostic";
const MAX_EVENTS_PER_INSTANCE = 32;
let nextInstanceId = 1;

type Phase =
  | "mounted"
  | "request-close"
  | "wait-animations"
  | "animations-settled"
  | "effect-canceled"
  | "commit-callback"
  | "unmounted";

export function createIssueDrawerDiagnostic() {
  const instanceId = nextInstanceId++;
  let eventCount = 0;
  return {
    instanceId,
    record(
      phase: Phase,
      animations: Animation[] = [],
      canceledCount = 0,
    ): void {
      try {
        // Reuse the host's bounded console.debug journal, which survives remounts.
        if (
          eventCount >= MAX_EVENTS_PER_INSTANCE &&
          phase !== "unmounted" &&
          phase !== "commit-callback"
        )
          return;
        eventCount += 1;
        console.debug(LOG_PREFIX, {
          instanceId,
          phase,
          timestampUnixMs: Date.now(),
          elapsedMs: performance.now(),
          canceledCount,
          animations: animations.slice(0, 4).map((animation) => ({
            property:
              typeof CSSTransition !== "undefined" &&
              animation instanceof CSSTransition &&
              ["transform", "width"].includes(animation.transitionProperty)
                ? animation.transitionProperty
                : "other",
            playState: ["running", "paused", "finished", "idle"].includes(
              animation.playState,
            )
              ? animation.playState
              : "other",
            currentTime:
              typeof animation.currentTime === "number" &&
              Number.isFinite(animation.currentTime)
                ? animation.currentTime
                : null,
            pending: animation.pending === true,
          })),
        });
      } catch {
        // Diagnostics must never interfere with the close transaction.
      }
    },
  };
}
