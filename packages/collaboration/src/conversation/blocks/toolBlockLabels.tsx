import { Clock3, Image as ImageIcon, Search, Wrench } from "lucide-react";
import type { CollaborationTranslate } from "../../i18n";
import type { ToolBlock } from "./types";
import {
  getToolActivityFilePaths,
  getToolActivityKind,
  isWebSearchToolName,
  unwrapShellCommand,
} from "./toolBlockActivity";
import {
  getFileInputPaths,
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isGuidanceToolName,
  isImageGenerationToolName,
  isImageViewToolName,
  isFileReadToolName,
  isNodeReplToolName,
} from "./toolBlockKinds";
import { basename, truncate } from "./toolBlockText";

function toolState(block: ToolBlock): "done" | "error" | "running" {
  return block.status === "error"
    ? "error"
    : block.status === "done"
      ? "done"
      : "running";
}

function toolLabel(
  translate: CollaborationTranslate,
  key: string,
  options?: Record<string, string | number>,
): string {
  return translate(`conversation.tool_activity.${key}`, undefined, options);
}

export function getBlockLabel(
  block: ToolBlock,
  translate: CollaborationTranslate,
): { icon: React.ReactNode; label: string } {
  const name = block.toolName.toLowerCase();
  const state = toolState(block);
  if (isNodeReplToolName(name)) {
    return {
      icon: <TerminalIcon />,
      label: toolLabel(translate, `javascript_${state}`),
    };
  }
  if (isCommandToolName(name)) {
    const activityKind = getToolActivityKind(block);
    if (activityKind === "file") {
      const paths = getToolActivityFilePaths(block);
      const target =
        paths.length === 1
          ? basename(paths[0])
          : paths.length > 1
            ? toolLabel(translate, "file_count", { count: paths.length })
            : toolLabel(translate, "file_fallback");
      return {
        icon: <FileIcon />,
        label: toolLabel(translate, `read_${state}`, { name: target }),
      };
    }
    if (activityKind === "search") {
      return {
        icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
        label: toolLabel(translate, `search_${state}`),
      };
    }
    const command = getInputField(block, "command", "cmd", "commandLine");
    const shortCmd = command
      ? truncate(unwrapShellCommand(command).split("\n")[0], 40)
      : block.toolName;
    return {
      icon: <TerminalIcon />,
      label: toolLabel(translate, `command_${state}`, { name: shortCmd }),
    };
  }
  if (isFileCreateToolName(name)) {
    return {
      icon: <FileIcon />,
      label: getFileToolLabel(block, "create", translate),
    };
  }
  if (isFileEditToolName(name)) {
    return {
      icon: <EditIcon />,
      label: getFileToolLabel(block, "edit", translate),
    };
  }
  if (isFileReadToolName(name)) {
    return {
      icon: <FileIcon />,
      label: getFileToolLabel(block, "read", translate),
    };
  }
  if (isWebSearchToolName(name)) {
    return {
      icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
      label: toolLabel(translate, `web_search_${state}`),
    };
  }
  if (isImageViewToolName(name)) {
    const path = getInputField(block, "path", "file_path", "filePath");
    return {
      icon: <FileIcon />,
      label: path
        ? toolLabel(translate, "image_view", { filename: basename(path) })
        : toolLabel(translate, "image_view_fallback"),
    };
  }
  if (isImageGenerationToolName(name)) {
    return {
      icon: <ImageIcon className="h-4 w-4" strokeWidth={1.7} />,
      label: toolLabel(translate, `image_generation_${state}`),
    };
  }
  if (isGuidanceToolName(name)) {
    return {
      icon: <ToolIcon />,
      label: toolLabel(translate, `guidance_${state}`),
    };
  }
  return getGenericToolLabel(block, translate);
}

function getGenericToolLabel(
  block: ToolBlock,
  translate: CollaborationTranslate,
): { icon: React.ReactNode; label: string } {
  const name = getReadableToolName(block.toolName);
  const state = toolState(block);
  if (name.toLowerCase().includes("wait")) {
    return {
      icon: <Clock3 className="h-4 w-4" strokeWidth={1.7} />,
      label: toolLabel(translate, `wait_${state}`),
    };
  }
  return {
    icon: <Wrench className="h-4 w-4" strokeWidth={1.7} />,
    label: toolLabel(translate, `call_${state}`, { name }),
  };
}

function getReadableToolName(toolName: string): string {
  const normalized = toolName.trim();
  const leaf = normalized.split(/\.|__/).filter(Boolean).at(-1) ?? normalized;
  return leaf.replaceAll("_", " ");
}

function getFileToolLabel(
  block: ToolBlock,
  action: "create" | "edit" | "read",
  translate: CollaborationTranslate,
): string {
  const paths = getFileInputPaths(block);
  const state = toolState(block);
  if (paths.length === 0)
    return toolLabel(translate, `${action}_file_${state}`);
  const name =
    paths.length === 1
      ? basename(paths[0])
      : toolLabel(translate, "file_count", { count: paths.length });
  return toolLabel(translate, `${action}_${state}`, { name });
}

function TerminalIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M4.5 19.5h15a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5h-15A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
      />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.42 15.17l-5.1 5.1a2.121 2.121 0 11-3-3l5.1-5.1m0 0L15.17 4.83a2.121 2.121 0 113 3l-7.75 7.34z"
      />
    </svg>
  );
}
