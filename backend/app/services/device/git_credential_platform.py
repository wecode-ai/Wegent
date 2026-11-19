# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Native filesystem primitives embedded in the device credential transaction."""

GIT_CREDENTIAL_PLATFORM_SCRIPT = r"""
import errno
import stat
import uuid
from contextlib import contextmanager


def is_credential_link(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


if os.name == "nt":
    import atexit
    import ctypes
    import msvcrt
    import struct
    from ctypes import wintypes

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _security = ctypes.WinDLL("advapi32", use_last_error=True)
    _private_descriptor = None

    def _win_function(library, name, arguments, result=wintypes.BOOL):
        function = getattr(library, name)
        function.argtypes = arguments
        function.restype = result
        return function

    _close_handle = _win_function(_kernel, "CloseHandle", [wintypes.HANDLE])
    _local_free = _win_function(_kernel, "LocalFree", [ctypes.c_void_p], ctypes.c_void_p)
    _create_file = _win_function(_kernel, "CreateFileW", [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ], wintypes.HANDLE)
    _control = _win_function(_kernel, "DeviceIoControl", [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ])

    def _win_path(path):
        value = str(path.absolute())
        if value.startswith("\\\\?\\"):
            return value
        if value.startswith("\\\\"):
            return "\\\\?\\UNC\\" + value[2:]
        return "\\\\?\\" + value

    def _win_open(path, access, creation=3, flags=0x02200000, share=7):
        handle = _create_file(_win_path(path), access, share, None, creation, flags, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    @contextmanager
    def _win_handle(path, access):
        handle = _win_open(path, access)
        try:
            yield handle
        finally:
            _close_handle(handle)

    def _win_owner_sid():
        token = wintypes.HANDLE()
        process = _win_function(_kernel, "GetCurrentProcess", [], wintypes.HANDLE)()
        open_token = _win_function(_security, "OpenProcessToken", [
            wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
        ])
        if not open_token(process, 8, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            needed = wintypes.DWORD()
            token_info = _win_function(_security, "GetTokenInformation", [
                wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ])
            token_info(token, 1, None, 0, ctypes.byref(needed))
            if not needed.value:
                raise ctypes.WinError(ctypes.get_last_error())
            data = ctypes.create_string_buffer(needed.value)
            if not token_info(token, 1, data, needed.value, ctypes.byref(needed)):
                raise ctypes.WinError(ctypes.get_last_error())
            sid = ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0]
            text = wintypes.LPWSTR()
            convert = _win_function(_security, "ConvertSidToStringSidW", [
                ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR),
            ])
            if not convert(sid, ctypes.byref(text)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                return text.value
            finally:
                _local_free(ctypes.cast(text, ctypes.c_void_p))
        finally:
            _close_handle(token)

    def _win_protect(path):
        global _private_descriptor
        if _private_descriptor is None:
            descriptor = ctypes.c_void_p()
            convert = _win_function(_security, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [
                wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
                ctypes.POINTER(wintypes.DWORD),
            ])
            # Protect managed state from inherited group grants. Children inherit
            # access only for this device user and the operating system.
            sddl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;%s)" % _win_owner_sid()
            if not convert(sddl, 1, ctypes.byref(descriptor), None):
                raise ctypes.WinError(ctypes.get_last_error())
            _private_descriptor = descriptor
            atexit.register(_local_free, descriptor)
        apply = _win_function(_security, "SetFileSecurityW", [
            wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p,
        ])
        if not apply(_win_path(path), 0x80000004, _private_descriptor):
            raise ctypes.WinError(ctypes.get_last_error())

    def _win_open_lock(path):
        # OPEN_REPARSE_POINT opens the leaf itself instead of following an
        # attacker-supplied link. Do not permit deletion while the lock is held.
        handle = _win_open(path, 0xC0000000, creation=4, flags=0x00200000, share=3)
        transferred = False
        try:
            class FileInfo(ctypes.Structure):
                _fields_ = [("attributes", wintypes.DWORD), ("remaining", wintypes.DWORD * 12)]
            info = FileInfo()
            inspect = _win_function(_kernel, "GetFileInformationByHandle", [
                wintypes.HANDLE, ctypes.POINTER(FileInfo),
            ])
            if not inspect(handle, ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if info.attributes & (0x400 | 0x10):
                raise RuntimeError("credential_lock_invalid")
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY | os.O_NOINHERIT)
            transferred = True
            return descriptor
        finally:
            if not transferred:
                _close_handle(handle)

    def _win_set_junction(path, revision):
        # Update the existing mount-point reparse data in one filesystem call;
        # never remove current and expose another account's native CLI state.
        # FSCTL_SET_REPARSE_POINT requires the existing tag to match.
        target = str(revision.resolve())
        if target.startswith("\\\\?\\"):
            target = target[4:]
        substitute = ("\\??\\" + target).encode("utf-16-le")
        printed = target.encode("utf-16-le")
        names = substitute + b"\0\0" + printed + b"\0\0"
        data = struct.pack("<IHHHHHH", 0xA0000003, 8 + len(names), 0,
                           0, len(substitute), len(substitute) + 2, len(printed)) + names
        if len(data) > 16384:
            raise ValueError("credential_directory_invalid")
        with _win_handle(path, 0x40000000) as handle:
            returned = wintypes.DWORD()
            buffer = ctypes.create_string_buffer(data)
            if not _control(handle, 0x000900A4, buffer, len(data), None, 0,
                            ctypes.byref(returned), None):
                raise ctypes.WinError(ctypes.get_last_error())


def protect_credential_path(path, mode):
    path.chmod(mode)
    if os.name == "nt" and mode in {0o600, 0o700}:
        _win_protect(path)


def open_credential_lock(path):
    if os.name == "nt":
        return _win_open_lock(path)
    return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)


def lock_credentials(descriptor):
    if os.name == "nt":
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def publish_credential_revision(root, revision):
    current = root / "current"
    if os.name == "nt" and is_credential_link(current):
        if current.lstat().st_reparse_tag != 0xA0000003:
            raise ValueError("credential_directory_invalid")
        _win_set_junction(current, revision)
        return
    temporary = root / (".current-" + uuid.uuid4().hex)
    try:
        if os.name == "nt":
            temporary.mkdir(mode=0o700)
            _win_set_junction(temporary, revision)
        else:
            temporary.symlink_to(Path("revisions") / revision.name)
        os.replace(temporary, current)
    finally:
        if is_credential_link(temporary) or temporary.exists():
            if os.name == "nt":
                temporary.rmdir()
            else:
                temporary.unlink()
""".strip()
