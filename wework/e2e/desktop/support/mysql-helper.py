# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Small PyMySQL bridge for the Node-based desktop E2E fixture."""

from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import sys
from typing import Any

import pymysql


def _json_default(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8")
    raise TypeError(f"Unsupported MySQL value: {type(value).__name__}")


def main() -> None:
    request = json.loads(os.environ["WEWORK_E2E_MYSQL_REQUEST"])
    connection = pymysql.connect(
        host=request["host"],
        port=int(request["port"]),
        user="root",
        password="",
        database=request.get("database"),
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        operation = request["operation"]
        if operation == "ping":
            connection.ping()
            result: Any = {"ready": True}
        else:
            with connection.cursor() as cursor:
                cursor.execute(request["sql"], request.get("params", []))
                result = (
                    cursor.fetchall()
                    if operation == "query"
                    else {"affected": cursor.rowcount}
                )
        json.dump(result, sys.stdout, default=_json_default, separators=(",", ":"))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
