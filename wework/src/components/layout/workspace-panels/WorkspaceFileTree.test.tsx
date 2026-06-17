import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import "@/i18n";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import type { WorkspaceFileEntry } from "@/types/workspace-files";

function createFileEntry(index: number): WorkspaceFileEntry {
  return {
    name: `file-${index.toString().padStart(4, "0")}.ts`,
    path: `/workspace/project/file-${index.toString().padStart(4, "0")}.ts`,
    isDirectory: false,
    size: index,
    modifiedAt: "2026-06-15T00:00:00.000Z",
  };
}

describe("WorkspaceFileTree", () => {
  test("virtualizes large directory listings instead of rendering every file row", async () => {
    const entries = Array.from({ length: 1000 }, (_, index) =>
      createFileEntry(index),
    );

    render(
      <WorkspaceFileTree
        rootPath="/workspace/project"
        activeDirectoryPath="/workspace/project"
        entriesByPath={{ "/workspace/project": entries }}
        expandedPaths={new Set()}
        selectedPath={null}
        loadingPaths={new Set()}
        error={null}
        onOpenDirectory={vi.fn()}
        onOpenFile={vi.fn()}
        onExpandedPathsChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    const renderedRows = await screen.findAllByTestId("workspace-file-row");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(100);
    expect(screen.queryByText("file-0999.ts")).not.toBeInTheDocument();
  });
});
