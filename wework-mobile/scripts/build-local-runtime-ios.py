"""Build the pinned, non-JIT iPhone runtime into an external artifact directory.

Run with uv run --no-project. The executor and clean Linux rootfs are explicit
inputs; this script never reads desktop authentication or account directories.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "modules/wework-local-runtime"
SOURCE_LOCK = json.loads((MODULE / "native/ish-source-lock.json").read_text())
REVISION = SOURCE_LOCK["upstream"]["revision"]
ARCHIVE_HEADERS = {
    "archive.h": "11c373fab05e8f017220aff1d89cec3cf32146b44d6cb56aeb12e968bc3b950b",
    "archive_entry.h": "510ae3e21a800403bb1c8d413d5ddabaee0b38facb8491b60bb6da55f84f4695",
}


def run(*args, **kwargs):
    return subprocess.run([str(value) for value in args], check=True, **kwargs)


def read(*args):
    return run(*args, stdout=subprocess.PIPE, text=True).stdout.strip()


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def verify_source(source):
    if read("git", "-C", source, "rev-parse", "HEAD") != REVISION:
        raise ValueError("iSH source revision does not match the pinned revision")
    patch = MODULE / SOURCE_LOCK["patch"]["path"]
    if digest(patch) != SOURCE_LOCK["patch"]["sha256"]:
        raise ValueError("Compatibility patch checksum does not match the source lock")
    run("git", "-C", source, "diff", "--exit-code", "--quiet")
    if read("git", "-C", source, "ls-files", "--others", "--exclude-standard"):
        raise ValueError("Prepared iSH source contains untracked source files")
    actual = run(
        "git",
        "-C",
        source,
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        stdout=subprocess.PIPE,
    ).stdout
    if actual != patch.read_bytes():
        raise ValueError(
            "iSH source diff differs from the reviewed compatibility patch"
        )
    return digest(patch)


def build_libraries(source, output):
    tools = output / "build-tools"
    if not (tools / "bin/meson").exists():
        run("uv", "venv", "--python", "3.12", tools)
        run(
            "uv",
            "pip",
            "install",
            "--python",
            tools / "bin/python",
            "meson==1.12.1",
            "ninja==1.13.2",
        )
    build = output / "build-ish-ios"
    toolbin = build / "toolbin"
    toolbin.mkdir(parents=True, exist_ok=True)
    uv = shutil.which("uv")
    zig = shutil.which("zig")
    if not uv or not zig:
        raise RuntimeError("uv and Zig (for Linux VDSO LLD) must be installed")
    python = tools / "bin/python"
    for name, command in {
        "python3": [uv, "run", "--no-project", "--python", str(python), "python"],
        "ld.lld": [zig, "ld.lld"],
    }.items():
        script = toolbin / name
        script.write_text("#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n')
        script.chmod(0o755)
    sdk = read("xcrun", "--sdk", "iphoneos", "--show-sdk-path")
    clang = read("xcrun", "--sdk", "iphoneos", "--find", "clang")
    cross = build / "ios-cross.txt"
    cross.write_text(
        "[binaries]\n"
        f"c = {repr([clang, '-arch', 'arm64', '-isysroot', sdk, '-miphoneos-version-min=16.4'])}\n"
        f"ar = {read('xcrun', '--sdk', 'iphoneos', '--find', 'ar')!r}\n"
        "pkg-config = 'false'\n"
        "[host_machine]\nsystem = 'darwin'\ncpu_family = 'aarch64'\n"
        "cpu = 'aarch64'\nendian = 'little'\n"
        "[built-in options]\n" + f"c_link_args = {['-L' + sdk + '/usr/lib']!r}\n"
        "[properties]\nneeds_exe_wrapper = true\n"
    )
    command = [
        "uv",
        "run",
        "--no-project",
        "--python",
        python,
        tools / "bin/meson",
        "setup",
        build,
        source,
    ]
    if (build / "build.ninja").exists():
        command.append("--reconfigure")
    else:
        command.extend(["--cross-file", cross])
    command.extend(
        [
            "--buildtype=release",
            "-Db_ndebug=true",
            "-Dlog=",
            "-Dlog_handler=nslog",
            "-Dkernel=ish",
            "-Dengine=asbestos",
            "-Dguest_arch=arm64",
            "-Djit=true",
            "-Djit_emit=false",
            "-Doffload_test_symbol=false",
            "-Doffload_test_prebuilt=false",
            f'-Dvdso_c_args=-fuse-ld={toolbin / "ld.lld"}',
        ]
    )
    env = dict(os.environ, PATH=str(toolbin) + os.pathsep + os.environ["PATH"])
    run(*command, env=env)
    run(
        tools / "bin/ninja",
        "-C",
        build,
        "-j",
        "6",
        "libish.a",
        "libish_emu.a",
        "libfakefs.a",
        "vdso/arm64/libvdso.so.elf",
        env=env,
    )
    return build, sdk


def export_headers(source, build, vendor):
    include = vendor / "include/ish"
    for directory in ["emu", "kernel", "fs", "util", "platform", "asbestos", "tools"]:
        for header in (source / directory).rglob("*.h"):
            destination = include / header.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(header, destination)
    for header in ["debug.h", "misc.h"]:
        shutil.copy2(source / header, include / header)
    (include / "deps").mkdir(exist_ok=True)
    shutil.copy2(source / "deps/config.h", include / "deps/config.h")
    shutil.copy2(build / "cpu-offsets.h", include / "cpu-offsets.h")
    importer = vendor / "importer"
    importer.mkdir(exist_ok=True)
    shutil.copy2(source / "tools/fakefs.c", importer / "fakefs.c")
    shutil.copy2(source / "util/fchdir.c", importer / "fchdir.c")
    archive = vendor / "include/archive"
    archive.mkdir(parents=True, exist_ok=True)
    for name, expected in ARCHIVE_HEADERS.items():
        path = archive / name
        if not path.exists():
            url = f"https://raw.githubusercontent.com/libarchive/libarchive/v3.7.7/libarchive/{name}"
            with urllib.request.urlopen(url, timeout=30) as response:
                path.write_bytes(response.read())
        if digest(path) != expected:
            raise ValueError(f"libarchive header integrity mismatch: {name}")


def package_rootfs(rootfs, executor, target):
    with (
        rootfs.open("rb") as base_file,
        tarfile.open(fileobj=base_file, mode="r:gz") as base,
    ):
        with (
            target.open("wb") as output,
            gzip.GzipFile(
                fileobj=output, mode="wb", compresslevel=1, mtime=0
            ) as compressed,
        ):
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for entry in base:
                    normalized = entry.name
                    while normalized.startswith("./"):
                        normalized = normalized[2:]
                    if ".." in Path(entry.name).parts:
                        raise ValueError("Rootfs archive contains path traversal")
                    if normalized in ("opt/wegent-executor", "etc/resolv.conf"):
                        continue
                    archive.addfile(
                        entry, base.extractfile(entry) if entry.isfile() else None
                    )
                entry = tarfile.TarInfo("opt/wegent-executor")
                entry.size = executor.stat().st_size
                entry.mode = 0o755
                with executor.open("rb") as binary:
                    archive.addfile(entry, binary)
                resolver = tarfile.TarInfo("etc/resolv.conf")
                resolver.mode = 0o644
                archive.addfile(resolver, io.BytesIO())


def link_artifacts(vendor):
    # CocoaPods recursively scans real directories and does not descend through
    # directory symlinks. Link files individually so libraries/resources are seen.
    destination = MODULE / "vendor"
    marker = destination / ".wework-artifact-links"
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        if not marker.is_file():
            raise ValueError("Refusing to replace an unmanaged vendor directory")
        shutil.rmtree(destination)
    destination.mkdir()
    marker.write_text(str(vendor) + "\n")
    for source in vendor.rglob("*"):
        linked = destination / source.relative_to(vendor)
        if source.is_dir():
            linked.mkdir(exist_ok=True)
        else:
            linked.symlink_to(source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "rootfs", "executor", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--rootfs-sha256", required=True)
    parser.add_argument("--link-module", action="store_true")
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if output.is_relative_to(MODULE.parents[2]):
        raise ValueError("Build output must be outside the repository")
    if digest(args.rootfs) != args.rootfs_sha256:
        raise ValueError("Clean rootfs integrity mismatch")
    patch_hash = verify_source(source)
    output.mkdir(parents=True, exist_ok=True)
    build, sdk = build_libraries(source, output)
    vendor = output / "vendor"
    for directory in ["lib", "resources"]:
        (vendor / directory).mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        MODULE / "native/licenses", vendor / "resources/licenses", dirs_exist_ok=True
    )
    shutil.copy2(
        MODULE / "native/ish-source-lock.json",
        vendor / "resources/ish-source-lock.json",
    )
    shutil.copy2(
        MODULE / SOURCE_LOCK["patch"]["path"], vendor / "resources/ish-embedding.patch"
    )
    for name in ["libish.a", "libish_emu.a", "libfakefs.a"]:
        shutil.copy2(build / name, vendor / "lib" / name)
        run("xcrun", "lipo", "-info", vendor / "lib" / name)
    export_headers(source, build, vendor)
    rootfs = vendor / "resources/runtime-rootfs.tar.gz"
    snapshot = output / "input-executor"
    shutil.copyfile(args.executor, snapshot)
    executor_hash = digest(snapshot)
    if executor_hash != digest(args.executor):
        raise ValueError("Executor changed during the build; retry with a frozen input")
    package_rootfs(args.rootfs, snapshot, rootfs)
    manifest = {
        "schemaVersion": 1,
        "ishRevision": REVISION,
        "ishPatchSha256": patch_hash,
        "rootfsSha256": digest(rootfs),
        "baseRootfsSha256": args.rootfs_sha256,
        "executorSha256": executor_hash,
        "sdk": sdk,
        "jitEmission": False,
    }
    (vendor / "resources/manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    if args.link_module:
        link_artifacts(vendor)
    print(json.dumps({"vendor": str(vendor), **manifest}, indent=2))


if __name__ == "__main__":
    main()
