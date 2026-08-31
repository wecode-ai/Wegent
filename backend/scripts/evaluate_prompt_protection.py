#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run the versioned prompt-protection dataset against one explicit model."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
DEFAULT_DATASET = BACKEND_ROOT / "evaluations/prompt_protection/v1.jsonl"
sys.path.insert(0, str(BACKEND_ROOT))


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="对一个明确模型运行提示词防护真实效果评估"
    )
    parser.add_argument("--model-id", required=True, help="报告中记录的明确模型 ID")
    parser.add_argument(
        "--model-config",
        type=Path,
        required=True,
        help="仓库外的已解析模型配置 JSON；不得提交凭证",
    )
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--report", type=Path, help="可选的脱敏 JSON 报告路径")
    return parser.parse_args()


def main() -> int:
    from app.services.prompt_protection_evaluation import (
        load_evaluation_dataset,
        load_external_model_config,
        run_prompt_protection_evaluation,
    )

    args = _arguments()
    try:
        samples = load_evaluation_dataset(args.dataset)
        model_config = load_external_model_config(
            args.model_config,
            expected_model_id=args.model_id,
            repository_root=REPOSITORY_ROOT,
        )
        report = asyncio.run(
            run_prompt_protection_evaluation(
                samples=samples,
                model_config=model_config,
                model_id=args.model_id,
            )
        )
    except ValueError as exc:
        print(json.dumps({"execution_status": "invalid", "error": str(exc)}))
        return 2

    serialized = json.dumps(
        report.to_safe_dict(), ensure_ascii=False, indent=2, sort_keys=True
    )
    if args.report:
        args.report.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0 if report.effect_gate_status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
