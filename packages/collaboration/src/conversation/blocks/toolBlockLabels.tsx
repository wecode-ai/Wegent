import { Clock3, Image as ImageIcon, Search, Wrench } from "lucide-react";
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

type GenericToolLabels = {
  waitRunning: string;
  waitDone: string;
  waitError: string;
  callRunning: (name: string) => string;
  callDone: (name: string) => string;
  callError: (name: string) => string;
  fileCount: (count: number) => string;
  fileFallback: string;
  searchRunning: string;
  searchDone: string;
  searchError: string;
  imageView: (filename: string) => string;
  imageViewFallback: string;
  imageGenerationRunning: string;
  imageGenerationDone: string;
  imageGenerationError: string;
  javascriptRunning: string;
  javascriptDone: string;
  javascriptError: string;
};

export function getBlockLabel(
  block: ToolBlock,
  genericLabels: GenericToolLabels,
): { icon: React.ReactNode; label: string } {
  const name = block.toolName.toLowerCase();
  const prefix = getToolStatusPrefix(block);

  if (isNodeReplToolName(name)) {
    const label =
      block.status === "error"
        ? genericLabels.javascriptError
        : block.status === "done"
          ? genericLabels.javascriptDone
          : genericLabels.javascriptRunning;
    return { icon: <TerminalIcon />, label };
  }
  if (isCommandToolName(name)) {
    const activityKind = getToolActivityKind(block);
    if (activityKind === "file") {
      const paths = getToolActivityFilePaths(block);
      const target =
        paths.length === 1
          ? basename(paths[0])
          : paths.length > 1
            ? genericLabels.fileCount(paths.length)
            : genericLabels.fileFallback;
      return { icon: <FileIcon />, label: `${prefix.read} ${target}` };
    }
    if (activityKind === "search") {
      const action =
        block.status === "error"
          ? genericLabels.searchError
          : block.status === "done"
            ? genericLabels.searchDone
            : genericLabels.searchRunning;
      return {
        icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
        label: action,
      };
    }
    const command = getInputField(block, "command", "cmd", "commandLine");
    const shortCmd = command
      ? truncate(unwrapShellCommand(command).split("\n")[0], 40)
      : block.toolName;
    return { icon: <TerminalIcon />, label: `${prefix.running} ${shortCmd}` };
  }
  if (isFileCreateToolName(name)) {
    return {
      icon: <FileIcon />,
      label: getFileToolLabel(prefix.create, block, "新增"),
    };
  }
  if (isFileEditToolName(name)) {
    return {
      icon: <EditIcon />,
      label: getFileToolLabel(prefix.edit, block, "编辑"),
    };
  }
  if (isFileReadToolName(name)) {
    return {
      icon: <FileIcon />,
      label: getFileToolLabel(prefix.read, block, "读取"),
    };
  }
  if (isWebSearchToolName(name)) {
    return {
      icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
      label: prefix.webSearch,
    };
  }
  if (isImageViewToolName(name)) {
    const path = getInputField(block, "path", "file_path", "filePath");
    return {
      icon: <FileIcon />,
      label: path
        ? genericLabels.imageView(basename(path))
        : genericLabels.imageViewFallback,
    };
  }
  if (isImageGenerationToolName(name)) {
    const label =
      block.status === "error"
        ? genericLabels.imageGenerationError
        : block.status === "done"
          ? genericLabels.imageGenerationDone
          : genericLabels.imageGenerationRunning;
    return {
      icon: <ImageIcon className="h-4 w-4" strokeWidth={1.7} />,
      label,
    };
  }
  if (isGuidanceToolName(name)) {
    return { icon: <ToolIcon />, label: prefix.guidance };
  }

  return getGenericToolLabel(block, genericLabels);
}

function getGenericToolLabel(
  block: ToolBlock,
  labels: GenericToolLabels,
): { icon: React.ReactNode; label: string } {
  const name = getReadableToolName(block.toolName);
  const normalizedName = name.toLowerCase();

  if (normalizedName.includes("wait")) {
    const label =
      block.status === "error"
        ? labels.waitError
        : block.status === "done"
          ? labels.waitDone
          : labels.waitRunning;
    return {
      icon: <Clock3 className="h-4 w-4" strokeWidth={1.7} />,
      label,
    };
  }

  const label =
    block.status === "error"
      ? labels.callError(name)
      : block.status === "done"
        ? labels.callDone(name)
        : labels.callRunning(name);
  return {
    icon: <Wrench className="h-4 w-4" strokeWidth={1.7} />,
    label,
  };
}

function getReadableToolName(toolName: string): string {
  const normalized = toolName.trim();
  const leaf = normalized.split(/\.|__/).filter(Boolean).at(-1) ?? normalized;
  return leaf.replaceAll("_", " ");
}

function getFileToolLabel(
  prefix: string,
  block: ToolBlock,
  action: string,
): string {
  const filePaths = getFileInputPaths(block);
  if (filePaths.length === 1) return `${prefix} ${basename(filePaths[0])}`;
  if (filePaths.length > 1) return `${prefix} ${filePaths.length} 个文件`;
  return fileToolFallbackLabel(block.status, action);
}

function fileToolFallbackLabel(
  status: ToolBlock["status"],
  action: string,
): string {
  if (status === "error") return `${action}文件失败`;
  if (status === "done") return `${action}文件`;
  return `正在${action}文件`;
}

function getToolStatusPrefix(block: ToolBlock) {
  if (block.status === "error") {
    return {
      running: "运行失败",
      create: "新增失败",
      edit: "编辑失败",
      read: "读取失败",
      webSearch: "搜索网页失败",
      guidance: "引导对话失败",
      generic: "执行失败",
    };
  }

  if (block.status === "done") {
    return {
      running: "运行",
      create: "新增",
      edit: "编辑",
      read: "读取",
      webSearch: "搜索网页",
      guidance: "引导对话",
      generic: "执行",
    };
  }

  return {
    running: "正在运行",
    create: "正在新增",
    edit: "正在编辑",
    read: "正在读取",
    webSearch: "正在搜索网页",
    guidance: "正在引导对话",
    generic: "正在执行",
  };
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
