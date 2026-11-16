# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Export the shared offline calendar from the backend development environment."""

import argparse
import json
from importlib.metadata import distribution
from pathlib import Path

import chinese_calendar

DESTINATION = (
    Path(__file__).resolve().parents[1] / "shared/assets/calendars/china-workdays.json"
)


def calendar_data() -> dict[str, object]:
    """Match the upstream library's full-year coverage and date overrides."""
    years = [day.year for day in chinese_calendar.holidays]
    return {
        "startDate": f"{min(years)}-01-01",
        "endDate": f"{max(years)}-12-31",
        "sourceVersion": chinese_calendar.__version__,
        "sourceUrl": "https://github.com/LKI/chinese-calendar",
        "license": "MIT",
        "holidays": sorted(day.isoformat() for day in chinese_calendar.holidays),
        "workdays": sorted(day.isoformat() for day in chinese_calendar.workdays),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = json.dumps(calendar_data(), ensure_ascii=False, indent=2) + "\n"
    package = distribution("chinesecalendar")
    license_file = next(
        file for file in package.files or [] if str(file).endswith("/licenses/LICENSE")
    )
    license_text = package.locate_file(license_file).read_text(encoding="utf-8")
    license_path = DESTINATION.with_name("LICENSE.chinesecalendar")
    if args.check:
        if (
            DESTINATION.read_text(encoding="utf-8") != content
            or license_path.read_text(encoding="utf-8") != license_text
        ):
            raise SystemExit("Bundled China workday calendar differs from its source")
        return
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_text(content, encoding="utf-8")
    license_path.write_text(license_text, encoding="utf-8")


if __name__ == "__main__":
    main()
