# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

from shared.utils.xmind_parser import parse_xmind_to_markdown


def test_parse_xmind_content_json_to_markdown() -> None:
    payload = [
        {
            "title": "Launch",
            "rootTopic": {
                "title": "Plan",
                "notes": {"plain": {"content": "Keep teams aligned."}},
                "labels": ["priority"],
                "children": {"attached": [{"title": "Research"}]},
            },
        }
    ]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("content.json", json.dumps(payload))

    markdown = parse_xmind_to_markdown(archive.getvalue())

    assert "# Launch" in markdown
    assert "- Plan" in markdown
    assert "Note: Keep teams aligned." in markdown
    assert "Labels: priority" in markdown
    assert "- Research" in markdown


def test_parse_xmind_content_xml_to_markdown() -> None:
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
      <sheet>
        <title>Legacy Sheet</title>
        <topic>
          <title>Legacy Plan</title>
          <notes><plain>Legacy note</plain></notes>
          <children>
            <topics type="attached">
              <topic><title>Legacy Child</title></topic>
            </topics>
          </children>
        </topic>
      </sheet>
    </xmap-content>
    """
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("content.xml", xml)

    markdown = parse_xmind_to_markdown(archive.getvalue())

    assert "# Legacy Sheet" in markdown
    assert "- Legacy Plan" in markdown
    assert "Note: Legacy note" in markdown
    assert "- Legacy Child" in markdown
