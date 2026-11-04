#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validate an external Skill catalog; persist only with --apply."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("--source", action="append", required=True, metavar="KEY=PATH")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv

        load_dotenv(args.env_file, override=True)

    from app.db.session import SessionLocal
    from app.services.skill_catalog import SkillCatalog, publish_catalog

    sources = dict(item.split("=", 1) for item in args.source)
    catalog = SkillCatalog.model_validate_json(args.catalog.read_text())
    with SessionLocal() as db:
        try:
            report = publish_catalog(
                db, catalog, {key: Path(value) for key, value in sources.items()}
            )
            report["database"] = {
                "host": db.bind.url.host,
                "name": db.bind.url.database,
            }
            if args.apply:
                db.commit()
            else:
                db.rollback()
        except Exception:
            db.rollback()
            raise
    print(json.dumps({"applied": args.apply, **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
