# /// script
# dependencies = [
#   "numpy==2.5.4",
#   "opencv-python-headless==5.0.0.93",
#   "pillow==13.0.0",
# ]
# ///
"""Generate the startup mark from its supplied alpha silhouette, never its RGB texture."""

import argparse
import hashlib
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

DIRECTORY = Path(__file__).resolve().parents[1] / "src/shell/startup-splash"
SOURCE = DIRECTORY / "brand-source.png"
OUTPUT = DIRECTORY / "brand-mark.js"
ALPHA_THRESHOLD = 128
SIMPLIFY_EPSILON = 1.5
MINIMUM_COUNTER_RATIO = 0.001
DESIGN_WIDTH = 512


def extract_contours() -> tuple[list[dict], str]:
    image = Image.open(SOURCE)
    if image.mode != "RGBA":
        raise ValueError("The startup mark requires its original RGBA source")
    alpha = np.asarray(image.getchannel("A"))
    if alpha.min() != 0 or alpha.max() != 255:
        raise ValueError("The source must contain transparent and opaque pixels")
    mask = (alpha >= ALPHA_THRESHOLD).astype(np.uint8) * 255
    contours, hierarchy = cv2.findContours(
        mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE
    )
    parents = [
        index
        for index, contour in enumerate(contours)
        if hierarchy[0][index][3] < 0
        and cv2.contourArea(contour) >= image.width * image.height * 0.001
    ]
    parents.sort(key=lambda index: cv2.boundingRect(contours[index])[1:3])
    if len(parents) != 3:
        raise ValueError(
            "The supplied mark must retain its we, chevron, and underscore"
        )
    records = []
    for name, parent in zip(("we", "chevron", "underscore"), parents, strict=True):
        indices = [parent] + [
            index
            for index, contour in enumerate(contours)
            if hierarchy[0][index][3] == parent
            and cv2.contourArea(contour)
            >= cv2.contourArea(contours[parent]) * MINIMUM_COUNTER_RATIO
        ]
        for index in indices:
            contour = contours[index]
            simplified = cv2.approxPolyDP(contour, SIMPLIFY_EPSILON, True)
            error = max(
                abs(cv2.pointPolygonTest(simplified, tuple(map(float, point[0])), True))
                for point in contour
            )
            if error > SIMPLIFY_EPSILON:
                raise ValueError(f"{name} exceeded the source-pixel boundary tolerance")
            hole = index != parent
            records.append(
                {
                    "name": f"{name}-counter" if hole else name,
                    "hole": hole,
                    "points": simplified[:, 0, :] * (DESIGN_WIDTH / image.width),
                }
            )
            print(f"{name}: {len(simplified)} points, hole={hole}, error={error:.3f}px")
    return records, hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def generate() -> str:
    records, digest = extract_contours()
    lines = [
        "// Generated from brand-source.png alpha, normalized to 512 px. Do not edit points.",
        f"// Source SHA-256: {digest}",
        "// Rebuild: uv run wework/electron/scripts/generate-startup-brand.py",
        "// Alpha >= 128; boundary tolerance 1.5 source px; counter/body area >= 0.1%.",
        "window.WEWORK_STARTUP_BRAND_CONTOURS = [",
    ]
    for record in records:
        lines.extend(
            [
                "  {",
                f"    name: '{record['name']}',",
                f"    hole: {str(record['hole']).lower()},",
                "    points: [",
            ]
        )
        lines.extend(f"      [{x:g}, {y:g}]," for x, y in record["points"])
        lines.extend(["    ],", "  },"])
    return "\n".join([*lines, "]", ""])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    result = generate()
    if options.check:
        if OUTPUT.read_text() != result:
            raise ValueError("Regenerate brand-mark.js from its current alpha source")
    else:
        OUTPUT.write_text(result)


if __name__ == "__main__":
    main()
