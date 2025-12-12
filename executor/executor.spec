# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- mode: python ; coding: utf-8 -*-

import sys
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Collect all dependencies
datas = []
binaries = []
hiddenimports = []

# Add shared directory to Python path for proper module import
shared_path = os.path.join(os.path.dirname(os.getcwd()), 'shared')
if os.path.exists(shared_path):
    sys.path.insert(0, shared_path)

# Collect all submodules for critical dependencies
hiddenimports += collect_submodules('fastapi')
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('anthropic')
hiddenimports += collect_submodules('claude_agent_sdk')
hiddenimports += collect_submodules('agno')
hiddenimports += collect_submodules('openai')
hiddenimports += collect_submodules('mcp')
hiddenimports += collect_submodules('sqlalchemy')
hiddenimports += collect_submodules('httpx')
hiddenimports += collect_submodules('git')
hiddenimports += collect_submodules('cryptography')
hiddenimports += collect_submodules('requests')
hiddenimports += collect_submodules('pymysql')

# OpenTelemetry packages
hiddenimports += collect_submodules('opentelemetry')
hiddenimports += collect_submodules('opentelemetry.sdk')
hiddenimports += collect_submodules('opentelemetry.exporter')
hiddenimports += collect_submodules('opentelemetry.instrumentation')
hiddenimports += collect_submodules('opentelemetry.instrumentation.fastapi')
hiddenimports += collect_submodules('opentelemetry.instrumentation.httpx')
hiddenimports += collect_submodules('opentelemetry.instrumentation.requests')
hiddenimports += collect_submodules('opentelemetry.instrumentation.system_metrics')

# Collect shared module submodules
if os.path.exists(shared_path):
    hiddenimports += collect_submodules('shared')

# Additional hidden imports
hiddenimports += [
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
]

# Collect package data
for package in ['fastapi', 'uvicorn', 'pydantic', 'anthropic', 'claude_agent_sdk',
                'agno', 'openai', 'mcp', 'sqlalchemy', 'httpx']:
    try:
        tmp_datas, tmp_binaries, tmp_hiddenimports = collect_all(package)
        datas += tmp_datas
        binaries += tmp_binaries
        hiddenimports += tmp_hiddenimports
    except Exception:
        pass

a = Analysis(
    ['main.py'],
    pathex=[shared_path],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='executor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # 禁用 UPX 压缩以提高兼容性
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,  # 保持为 None 以自动检测
    codesign_identity=None,
    entitlements_file=None,
)
