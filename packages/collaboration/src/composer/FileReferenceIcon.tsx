import type { SVGProps } from "react";
import { fileReferenceIconPaths } from "./fileReferenceIcons";

export function FileReferenceIcon({
  path,
  ...props
}: SVGProps<SVGSVGElement> & { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {fileReferenceIconPaths(path).map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
