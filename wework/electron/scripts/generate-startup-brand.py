# /// script
# dependencies = [
#   "numpy==2.5.4",
#   "opencv-python-headless==5.0.0.93",
#   "pillow==13.0.0",
#   "scipy==1.18.1",
# ]
# ///
"""Generate the startup mark from its supplied alpha silhouette, never its RGB texture."""

import argparse
import hashlib
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.interpolate import splev, splprep

DIRECTORY = Path(__file__).resolve().parents[1] / "src/shell/startup-splash"
SOURCE = DIRECTORY / "brand-source.png"
OUTPUT = DIRECTORY / "brand-mark.js"
ALPHA_THRESHOLD = 128
MAX_BOUNDARY_ERROR_SOURCE = 3.0
MINIMUM_COUNTER_RATIO = 0.001
DESIGN_WIDTH = 512


def straight_underscore(contour: np.ndarray) -> np.ndarray:
    points = contour[:, 0, :].astype(float)
    left, top = points.min(axis=0)
    right, bottom = points.max(axis=0)
    radius = (bottom - top) / 2
    center_y = (top + bottom) / 2
    arc = radius * 4 * (np.sqrt(2) - 1) / 3
    a, b = left + radius, right - radius
    return np.array(
        [
            [[left, center_y], [left, center_y - arc], [a - arc, top], [a, top]],
            [[a, top], [a + (b - a) / 3, top], [b - (b - a) / 3, top], [b, top]],
            [[b, top], [b + arc, top], [right, center_y - arc], [right, center_y]],
            [
                [right, center_y],
                [right, center_y + arc],
                [b + arc, bottom],
                [b, bottom],
            ],
            [
                [b, bottom],
                [b - (b - a) / 3, bottom],
                [a + (b - a) / 3, bottom],
                [a, bottom],
            ],
            [[a, bottom], [a - arc, bottom], [left, center_y + arc], [left, center_y]],
        ]
    )


def fit_closed_contour(contour: np.ndarray) -> np.ndarray:
    points = contour[:, 0, :].astype(float)
    closed = np.vstack((points, points[0]))
    lengths = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    distance = np.concatenate(([0.0], np.cumsum(lengths)))
    samples = np.linspace(0, distance[-1], max(512, int(distance[-1] * 2)))
    points = np.column_stack(
        [np.interp(samples, distance, closed[:, axis]) for axis in range(2)]
    )
    parameters = samples / distance[-1]
    low, high = 0.0, len(points) * MAX_BOUNDARY_ERROR_SOURCE**2
    # Maximize smoothing under a source-coordinate displacement bound.
    for _ in range(32):
        smoothing = (low + high) / 2
        spline, _ = splprep(points.T, u=parameters, k=3, s=smoothing, per=True)
        fitted = np.array(splev(parameters, spline)).T
        if np.linalg.norm(fitted - points, axis=1).max() <= MAX_BOUNDARY_ERROR_SOURCE:
            low = smoothing
        else:
            high = smoothing
    spline, _ = splprep(points.T, u=parameters, k=3, s=low, per=True)
    samples = np.array(splev(np.linspace(0, 1, max(2048, len(points) * 2)), spline)).T
    error = max(
        abs(cv2.pointPolygonTest(contour, tuple(point), True)) for point in samples
    )
    if error > MAX_BOUNDARY_ERROR_SOURCE:
        raise ValueError(
            "The fitted curve exceeded the source-pixel boundary tolerance"
        )
    return spline_beziers(spline)


def spline_beziers(spline: tuple) -> np.ndarray:
    knots = np.unique(spline[0])
    knots = knots[(knots >= 0) & (knots <= 1)]
    curves = []
    for start, end in zip(knots[:-1], knots[1:], strict=True):
        a = np.array(splev(start, spline))
        b = np.array(splev(end, spline))
        tangent_a = np.array(splev(start, spline, der=1))
        tangent_b = np.array(splev(end, spline, der=1))
        curves.append(
            [a, a + tangent_a * (end - start) / 3, b - tangent_b * (end - start) / 3, b]
        )
    return np.array(curves)


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
            curves = (
                straight_underscore(contour)
                if name == "underscore"
                else fit_closed_contour(contour)
            )
            hole = index != parent
            records.append(
                {
                    "name": f"{name}-counter" if hole else name,
                    "hole": hole,
                    "curves": curves * (DESIGN_WIDTH / image.width),
                }
            )
            print(f"{name}: {len(curves)} cubic segments, hole={hole}")
    return records, hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def generate() -> str:
    records, digest = extract_contours()
    lines = [
        "// Generated from brand-source.png alpha, normalized to 512 px. Do not edit curves.",
        f"// Source SHA-256: {digest}",
        "// Rebuild: uv run wework/electron/scripts/generate-startup-brand.py",
        "// Alpha >= 128; curved contours <= 3 source px; straight capsule underscore.",
        "window.WEWORK_STARTUP_BRAND_CONTOURS = [",
    ]
    for record in records:
        lines.extend(
            [
                "  {",
                f"    name: '{record['name']}',",
                f"    hole: {str(record['hole']).lower()},",
                "    curves: [",
            ]
        )
        for curve in record["curves"]:
            lines.append("      [")
            for x, y in curve:
                coordinates = [
                    f"{value:.6f}".rstrip("0").rstrip(".") for value in (x, y)
                ]
                lines.append(f"        [{coordinates[0]}, {coordinates[1]}],")
            lines.append("      ],")
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
