#!/usr/bin/env python3

import json
import os
from pathlib import Path


def main() -> None:
    config: dict[str, object] = {
        "build": {
            "devUrl": f"http://localhost:{os.environ['WEWORK_PORT_VALUE']}",
            "beforeDevCommand": os.environ["BEFORE_DEV_COMMAND_VALUE"],
        },
    }

    app_identifier = os.environ["WEWORK_APP_IDENTIFIER_VALUE"].strip()
    if app_identifier:
        config["identifier"] = app_identifier

    if os.environ["WEWORK_DISABLE_BACKGROUND_THROTTLING_VALUE"] == "1":
        config_path = (
            Path(os.environ["WEWORK_DIR_VALUE"]) / "src-tauri" / "tauri.conf.json"
        )
        with config_path.open(encoding="utf-8") as handle:
            base_config = json.load(handle)
        config["app"] = {"windows": base_config["app"]["windows"]}

    if os.environ["WEWORK_RELEASE_UI_VALUE"] != "true":
        config["bundle"] = {
            "icon": [
                "icons/icon-dev.icns",
                "icons/icon.png",
            ],
        }

    output_path = Path(os.environ["TAURI_DEV_CONFIG_VALUE"])
    output_path.write_text(
        f"{json.dumps(config, indent=2)}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
