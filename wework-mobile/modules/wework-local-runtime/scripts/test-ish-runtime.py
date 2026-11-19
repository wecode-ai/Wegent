#!/usr/bin/env python3
"""Run focused native instruction and syscall probes in an isolated ARM64 iSH root filesystem."""

import argparse
import hashlib
import json
import platform
import subprocess
import time
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1]
PROBES = {
    "regress_pdeathsig": 14,
    "regress_pipe_exit": 2,
    "regress_pipe_signals": 4,
    "regress_proc_zombie_stat": 2,
    "regress_ldpsw": 23,
    "regress_simd_lane": 560,
    "regress_mount_boundary": 10,
    "regress_socket_timeout": 139,
}


def native_exit_probe(args: argparse.Namespace) -> dict:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("The native lifecycle probe requires an Apple ARM64 host")
    build = args.ish.resolve().parent
    binary = args.output / "regress_native_exit"
    subprocess.run(
        [
            args.host_cc,
            "-DWWR_EMBEDDED_ISH=1",
            "-DGUEST_ARM64=1",
            "-DENGINE_ASBESTOS=1",
            "-DISH_JIT=1",
            "-DISH_JIT_NO_EMIT=1",
            "-fblocks",
            f"-I{args.native_source}",
            f"-I{build}",
            str(MODULE / "native/tests/regress_native_exit.c"),
            str(MODULE / "ios/RuntimeMemory.c"),
            str(build / "libish.a"),
            str(build / "libish_emu.a"),
            str(build / "libfakefs.a"),
            "-lsqlite3",
            "-lpthread",
            "-framework",
            "Foundation",
            "-o",
            str(binary),
        ],
        check=True,
    )
    result = subprocess.run(
        [str(binary), str(args.output / "rootfs/data")],
        capture_output=True,
        text=True,
        timeout=20,
    )
    passed = result.returncode == 0 and result.stdout.count("PASS ") == 4
    return {
        "name": "regress_native_exit",
        "passed": passed,
        "assertions": 4,
        "hostExit": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def native_kernel_probe(
    args: argparse.Namespace,
    name: str,
    summary: str,
    with_rootfs: bool = False,
    sources: tuple[str, ...] = (),
) -> dict:
    build = args.ish.resolve().parent
    binary = args.output / name
    subprocess.run(
        [
            args.host_cc,
            "-DWWR_EMBEDDED_ISH=1",
            "-DGUEST_ARM64=1",
            "-DENGINE_ASBESTOS=1",
            "-DISH_JIT=1",
            "-DISH_JIT_NO_EMIT=1",
            f"-I{args.native_source}",
            f"-I{build}",
            str(MODULE / "native/tests" / f"{name}.c"),
            *(str(MODULE / "ios" / source) for source in sources),
            str(build / "libish.a"),
            str(build / "libish_emu.a"),
            str(build / "libfakefs.a"),
            "-lsqlite3",
            "-lpthread",
            "-framework",
            "Foundation",
            "-o",
            str(binary),
        ],
        check=True,
    )
    command = [str(binary)]
    if with_rootfs:
        command.append(str(args.output / "rootfs/data"))
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    return {
        "name": name,
        "passed": result.returncode == 0 and summary in result.stdout,
        "hostExit": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def run_probe(name: str, assertions: int, args: argparse.Namespace) -> dict:
    binary = args.output / name
    source = MODULE / "native/tests" / f"{name}.c"
    assembly = source.with_suffix(".S")
    subprocess.run(
        [
            args.zig,
            "cc",
            "-target",
            "aarch64-linux-musl",
            "-static",
            "-O2",
            "-pthread",
            str(source),
            *([str(assembly)] if assembly.exists() else []),
            "-o",
            str(binary),
        ],
        check=True,
    )
    command = (
        f"cat > /tmp/{name} && chmod +x /tmp/{name} && /tmp/{name}; "
        'status=$?; printf "probe-exit=%d\\n" "$status"; exit "$status"'
    )
    started = time.monotonic()
    result = subprocess.run(
        [str(args.ish), "-f", str(args.output / "rootfs"), "/bin/sh", "-c", command],
        input=binary.read_bytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    stdout, stderr = result.stdout.decode(), result.stderr.decode()
    # The upstream CLI's PID 1 halt path exits the host with zero even when the
    # guest failed. Require the guest's own status and every named assertion.
    passed = (
        result.returncode == 0
        and "probe-exit=0\n" in stdout
        and sum(line.startswith("PASS ") for line in stdout.splitlines()) == assertions
        and "FAIL" not in stdout
        and not any(marker in stderr for marker in ("SAFETY-VALVE", "DEFERRED-RELEASE"))
    )
    return {
        "name": name,
        "passed": passed,
        "assertions": assertions,
        "seconds": round(time.monotonic() - started, 3),
        "hostExit": result.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ish", type=Path, required=True)
    parser.add_argument("--fakefsify", type=Path, required=True)
    parser.add_argument("--rootfs-archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--zig", default="zig")
    parser.add_argument(
        "--native-source", type=Path, help="Also test retained native threads"
    )
    parser.add_argument("--host-cc", default="clang")
    args = parser.parse_args()
    args.output = args.output.expanduser().resolve()
    if (args.output / "rootfs").exists():
        parser.error(
            "Use a fresh output directory; the runner never overwrites a guest filesystem"
        )
    lock = json.loads((MODULE / "native/ish-source-lock.json").read_text())
    with args.rootfs_archive.open("rb") as archive:
        actual = hashlib.file_digest(archive, "sha256").hexdigest()
    if actual != lock["probeRootfs"]["sha256"]:
        parser.error("Probe rootfs checksum differs from the source lock")
    args.output.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [str(args.fakefsify), str(args.rootfs_archive), str(args.output / "rootfs")],
        check=True,
    )
    results = []
    for name, assertions in PROBES.items():
        result = run_probe(name, assertions, args)
        results.append(result)
        print(
            f"{'PASS' if result['passed'] else 'FAIL'} {name}: {assertions} assertions",
            flush=True,
        )
    if args.native_source:
        result = native_exit_probe(args)
        results.append(result)
        print(
            f"{'PASS' if result['passed'] else 'FAIL'} native lifecycle: 4 assertions"
        )
        result = native_kernel_probe(
            args, "regress_memory_resume", "PASS memory resume:"
        )
        results.append(result)
        print(f"{'PASS' if result['passed'] else 'FAIL'} native memory resume")
        result = native_kernel_probe(
            args,
            "regress_listener_recovery",
            "PASS listener recovery:",
            with_rootfs=True,
        )
        results.append(result)
        print(f"{'PASS' if result['passed'] else 'FAIL'} native listener recovery")
        for name, summary, with_rootfs, sources in [
            ("regress_poll_waiters", "PASS poll waiter lifetime", True, ()),
            ("regress_idle_poll", "PASS idle poll process lifetime", True, ()),
            ("regress_diagnostics", "PASS native diagnostic toggle", False, ()),
            (
                "regress_storage",
                "PASS native catalog cleanup",
                True,
                ("RuntimeStorage.c",),
            ),
        ]:
            result = native_kernel_probe(args, name, summary, with_rootfs, sources)
            results.append(result)
            print(f"{'PASS' if result['passed'] else 'FAIL'} {name}")
    (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    raise SystemExit(not all(result["passed"] for result in results))


if __name__ == "__main__":
    main()
