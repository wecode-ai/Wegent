#!/usr/bin/env bash

wework_prepare_brand_config() {
  local wework_dir="$1"
  local brand_config="$2"
  local enable_devtools="$3"
  local output_config="$4"

  BRAND_CONFIG="$brand_config" \
  BASE_CONFIG="$wework_dir/src-tauri/tauri.conf.json" \
  ENABLE_DEVTOOLS="$enable_devtools" \
  OUTPUT_CONFIG="$output_config" \
  python3 - <<'PY'
import json
import os
import re
from pathlib import Path

brand_path = os.environ["BRAND_CONFIG"]
with open(os.environ["BASE_CONFIG"], "r", encoding="utf-8") as handle:
    base_config = json.load(handle)

brand = {}
if brand_path:
    with open(brand_path, "r", encoding="utf-8") as handle:
        brand = json.load(handle)

product_name = brand.get("productName")
identifier = brand.get("identifier")
base_identifier = base_config.get("identifier")
executor_namespace = identifier if identifier != base_identifier else None

if brand:
    required = {
        "productName": product_name,
        "identifier": identifier,
    }
    missing = [name for name, value in required.items() if not isinstance(value, str) or not value]
    if missing:
        raise SystemExit(f"Brand config is missing non-empty fields: {', '.join(missing)}")
    if identifier == base_identifier:
        raise SystemExit(
            "A branded app must use an identifier different from the default app"
        )
    if not re.fullmatch(r"[A-Za-z0-9._-]+", identifier):
        raise SystemExit("identifier may only contain letters, numbers, '.', '_' and '-'")

windows = base_config.get("app", {}).get("windows", [])
config = {}
if brand:
    config.update(
        {
            "productName": product_name,
            "mainBinaryName": brand.get("mainBinaryName", product_name),
            "identifier": identifier,
        }
    )

if brand or os.environ["ENABLE_DEVTOOLS"] == "1":
    config["app"] = {
        "windows": [
            {
                **window,
                **({"title": product_name} if brand else {}),
                **({"devtools": True} if os.environ["ENABLE_DEVTOOLS"] == "1" else {}),
            }
            for window in windows
        ]
    }

with open(os.environ["OUTPUT_CONFIG"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")

if executor_namespace:
    Path(f"{os.environ['OUTPUT_CONFIG']}.namespace").write_text(
        executor_namespace, encoding="utf-8"
    )
PY
}
