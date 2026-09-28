import { createContext, useContext, type ReactNode } from "react";

export interface MarkdownFileOpenOptions {
  lineStart?: number;
  lineEnd?: number;
  isDirectory?: boolean;
  traceId?: string;
}

/** Platform operations only. All Markdown markup and interaction live in this package. */
export interface MarkdownServices {
  translate: (key: string, fallback?: string) => string;
  copyText: (text: string) => Promise<void>;
  onCopy?: () => void;
  openExternalUrl: (url: string) => void | Promise<unknown>;
  navigateTo?: (path: string) => void;
  openHtmlFile?: (path: string) => boolean;
  fetchAttachmentBlob?: (id: number) => Promise<Blob>;
  readLocalFile?: (path: string) => Promise<Blob>;
  renderVisualization?: (part: {
    file: string;
    mode?: "wide";
    title?: string;
  }) => ReactNode;
  windowMarkdown?: boolean;
  theme: "dark" | "light" | "system";
  plantumlServerUrl?: string;
}

export const markdownMessages = {
  "zh-CN": {
    "table.copy": "复制表格",
    "table.copied": "表格已复制",
    "table.failed": "复制表格失败，请重试",
    "table.expand": "展开表格",
    "table.close": "收起表格",
    "workbench.diagram_image_copied": "图片已复制",
    "workbench.diagram_image_copy_failed": "复制图片失败",
    "workbench.diagram_copy_image": "复制图片",
    "workbench.diagram_image_saved": "图片已保存",
    "workbench.diagram_image_save_failed": "保存图片失败",
    "workbench.diagram_save_image": "保存图片",
    "workbench.diagram_exit_full_screen": "退出全屏",
    "workbench.diagram_full_screen": "全屏查看",
    "code.copy": "复制代码",
    "code.wrap_on": "开启自动换行",
    "code.wrap_off": "禁用自动换行",
  },
  en: {
    "table.copy": "Copy table",
    "table.copied": "Table copied",
    "table.failed": "Could not copy table. Try again.",
    "table.expand": "Expand table",
    "table.close": "Close expanded table",
    "workbench.diagram_image_copied": "Image copied",
    "workbench.diagram_image_copy_failed": "Failed to copy image",
    "workbench.diagram_copy_image": "Copy image",
    "workbench.diagram_image_saved": "Image saved",
    "workbench.diagram_image_save_failed": "Failed to save image",
    "workbench.diagram_save_image": "Save image",
    "workbench.diagram_exit_full_screen": "Exit full screen",
    "workbench.diagram_full_screen": "Full screen",
    "code.copy": "Copy code",
    "code.wrap_on": "Enable word wrap",
    "code.wrap_off": "Disable word wrap",
  },
};

export const browserMarkdownServices: MarkdownServices = {
  translate: (key) =>
    markdownMessages.en[key as keyof typeof markdownMessages.en] ?? key,
  copyText: async (text) => {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard copy is not supported");
    await navigator.clipboard.writeText(text);
  },
  openExternalUrl: (url) => {
    const parsed = new URL(url, window.location.href);
    if (!["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol))
      return;
    window.open(parsed.href, "_blank", "noopener,noreferrer");
  },
  theme: "system",
  plantumlServerUrl: "https://www.plantuml.com/plantuml/svg",
};

const MarkdownServicesContext = createContext<MarkdownServices>(
  browserMarkdownServices,
);
export function MarkdownServicesProvider({
  value,
  children,
}: {
  value: MarkdownServices;
  children: ReactNode;
}) {
  return (
    <MarkdownServicesContext.Provider value={value}>
      {children}
    </MarkdownServicesContext.Provider>
  );
}
export function useMarkdownServices() {
  return useContext(MarkdownServicesContext);
}
