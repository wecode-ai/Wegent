export interface RuntimeUserMessageParts {
  prefix: string;
  request: string;
}

export interface RuntimeUserTextProjection {
  content: string;
  sourceStart: number;
  sourceEnd: number;
}

export function splitRuntimeUserMessage(
  content: string,
): RuntimeUserMessageParts | null;
export function visibleRuntimeUserMessage(content: string): string;
export function projectRuntimeUserText(
  content: string,
): RuntimeUserTextProjection;
