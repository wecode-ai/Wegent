import { describe, expect, it } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { managerActivityPresentation } from "./managerActivity";

describe("managerActivityPresentation", () => {
  it("projects a cancelled manager run as a terminal stopped event", () => {
    expect(
      managerActivityPresentation(
        createCollaborationTranslator("zh-CN"),
        {},
        "cancelled",
      ),
    ).toEqual({
      label: "已停止任务规划",
      planning: false,
    });
  });
});
