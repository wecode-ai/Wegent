import type {
  BrowserAnnotationContextData,
  StyleAdjustment,
} from "./browser-annotation";

export interface CodeCommentContext {
  id: string;
  source?: "browser_annotation" | "code_selection";
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
  createdAt: string;
  updatedAt?: string;
  browserAnnotation?: BrowserAnnotationContextData;
  adjustments?: StyleAdjustment[];
}
