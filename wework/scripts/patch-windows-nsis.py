#!/usr/bin/env python3
"""Patch Tauri-generated NSIS installer to work around empty desktop shortcuts.

NSIS CreateShortcut can produce shortcuts with empty target/working directory
fields when the installer is cross-compiled from macOS. A second CreateShortcut
call, overwriting the freshly created .lnk file, produces a correct shortcut.
This script replaces Tauri's CreateOrUpdateDesktopShortcut function with two
consecutive CreateShortcut calls.
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

OLD_FUNCTION = r"""Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd"""

NEW_FUNCTION = r"""Function CreateOrUpdateDesktopShortcut
  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  ; NSIS CreateShortcut can produce shortcuts with empty target/working
  ; directory fields when the installer is cross-compiled from macOS.
  ; Empirically, the first call creates a blank .lnk, but overwriting an
  ; existing .lnk with a second call produces a correct shortcut. We call
  ; CreateShortcut twice to simulate the "second install" behavior.
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd"""


def patch_installer_nsi(nsi_path: Path) -> bool:
    content = nsi_path.read_text(encoding="utf-8")
    if OLD_FUNCTION not in content:
        print(
            "error: CreateOrUpdateDesktopShortcut pattern not found; installer already patched or Tauri generated code changed",
            file=sys.stderr,
        )
        return False
    content = content.replace(OLD_FUNCTION, NEW_FUNCTION)
    nsi_path.write_text(content, encoding="utf-8")
    return True


def parse_nsi_define(content: str, name: str) -> str | None:
    match = re.search(rf'!define +{re.escape(name)} +"([^"]+)"', content)
    if match:
        return match.group(1)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Patch and recompile Tauri NSIS installer"
    )
    parser.add_argument("nsi_path", type=Path, help="Path to generated installer.nsi")
    args = parser.parse_args()

    nsi_path = args.nsi_path.resolve()
    if not nsi_path.exists():
        print(f"error: {nsi_path} does not exist", file=sys.stderr)
        return 1

    if not patch_installer_nsi(nsi_path):
        return 1

    makensis = shutil.which("makensis")
    if not makensis:
        print("error: makensis not found in PATH", file=sys.stderr)
        return 1

    # Compute the bundle output path that Tauri would normally use.
    # nsi_path: .../target/<target>/<profile>/nsis/x64/installer.nsi
    # bundle:   .../target/<target>/<profile>/bundle/nsis/<PRODUCTNAME>_<VERSION>_<ARCH>-setup.exe
    content = nsi_path.read_text(encoding="utf-8")
    product_name = parse_nsi_define(content, "PRODUCTNAME") or "WeWork"
    version = parse_nsi_define(content, "VERSION") or "0.0.0"
    arch = parse_nsi_define(content, "ARCH") or "x64"
    outfile = f"{product_name}_{version}_{arch}-setup.exe"

    profile_dir = nsi_path.parent.parent.parent  # .../<profile>
    bundle_dir = profile_dir / "bundle" / "nsis"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    out_path = bundle_dir / outfile

    # Recompile; makensis writes to nsis-output.exe in the same directory as installer.nsi.
    subprocess.run([makensis, str(nsi_path)], check=True)

    compiled = nsi_path.parent / "nsis-output.exe"
    if not compiled.exists():
        print(f"error: compiled installer not found at {compiled}", file=sys.stderr)
        return 1

    shutil.move(str(compiled), str(out_path))
    print(f"patched installer: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
