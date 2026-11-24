#!/usr/bin/env python3
"""Screen monitor for the dsh-screen-click plugin.

Watches the client area of a game window for a known button (a small
grayscale signature), clicks it repeatedly while it stays visible, and exits
when the button disappears. Status is emitted as one JSON object per stdout
line so the Host can relay it to the sidebar panel.

Modes:
  --test-image <png>   Compare a saved screenshot instead of the live screen
                       (no clicking, exits with the match result).
  --dry-run            Match but never click.
"""
import argparse
import csv
import ctypes
import ctypes.wintypes as wt
import io
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageGrab


def set_dpi_aware():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


user32 = ctypes.windll.user32
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.mouse_event.argtypes = [
    ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_ulonglong,
]
user32.GetForegroundWindow.restype = wt.HWND
user32.GetAncestor.restype = wt.HWND
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_ssize_t)


def emit(**payload):
    payload.setdefault("ts", round(time.time(), 3))
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def process_ids(image_name):
    """PIDs whose image name equals the requested name."""
    try:
        output = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq " + image_name, "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception as error:
        emit(event="error", message="tasklist failed: %s" % error)
        return []
    pids = []
    for row in csv.reader(io.StringIO(output)):
        if len(row) >= 2 and row[0].strip().lower() == image_name.lower():
            try:
                pids.append(int(row[1].replace(",", "")))
            except ValueError:
                pass
    return pids


def find_window(pids):
    """Largest visible titled window owned by one of the PIDs."""
    best = [None, -1]

    def callback(hwnd, _lparam):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindowTextLengthW(hwnd) == 0:
            return True
        rect = wt.RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
            return True
        area = (rect.right - rect.left) * (rect.bottom - rect.top)
        if area > best[1]:
            best[0], best[1] = hwnd, area
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return best[0]


def root_window(hwnd):
    return user32.GetAncestor(hwnd, 2) or hwnd


def foreground_root():
    hwnd = user32.GetForegroundWindow()
    return root_window(hwnd) if hwnd else None


def parent_alive(pid):
    """Whether the parent process that spawned this monitor is still running."""
    if not pid or pid <= 0:
        return True
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wt.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


_MUTEX = None


def acquire_single_instance():
    """Keep at most one monitor alive, even after an unclean Host restart."""
    global _MUTEX
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    handle = kernel32.CreateMutexW(None, False, "Local\\dsh-screen-click-monitor")
    if not handle:
        return True  # Cannot create the mutex: do not block the feature.
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return False
    _MUTEX = handle
    return True


def client_rect(hwnd):
    rect = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    point = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(point))
    return point.x, point.y, rect.right, rect.bottom


def window_rect(hwnd):
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom


def thread_id(hwnd):
    tid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(tid))
    return tid.value


def bring_to_front(hwnd):
    """Activate the window and report whether it became the foreground window."""
    user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
    user32.BringWindowToTop.argtypes = [ctypes.c_void_p]
    user32.keybd_event.argtypes = [ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint32, ctypes.c_void_p]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.2)
    # A synthetic ALT tap releases Windows' foreground lock for this attempt.
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.15)
    if user32.GetForegroundWindow() == hwnd:
        return True
    foreground = user32.GetForegroundWindow()
    target_thread = thread_id(hwnd)
    foreground_thread = thread_id(foreground) if foreground else 0
    attached = False
    if foreground_thread and target_thread and foreground_thread != target_thread:
        attached = bool(user32.AttachThreadInput(foreground_thread, target_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(foreground_thread, target_thread, False)
    time.sleep(0.15)
    return user32.GetForegroundWindow() == hwnd


def signature_of(image, box_px, grid):
    x0, y0, x1, y1 = box_px
    crop = image.crop((x0, y0, x1, y1)).convert("L")
    crop = crop.resize((grid[1], grid[0]), Image.LANCZOS)
    return np.asarray(crop, dtype=np.float32)


def click(x, y):
    user32.SetCursorPos(int(round(x)), int(round(y)))
    time.sleep(0.03)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # left down
    time.sleep(0.04)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # left up


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32), ("biHeight", ctypes.c_int32),
        ("biPlanes", ctypes.c_uint16), ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
        ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32), ("biYPelsPerMeter", ctypes.c_int32),
        ("biClrUsed", ctypes.c_uint32), ("biClrImportant", ctypes.c_uint32),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]


def print_window(hwnd, width, height):
    """Capture a window with PrintWindow (works for occluded windows when supported)."""
    gdi32 = ctypes.windll.gdi32
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.GetWindowDC.restype = ctypes.c_void_p
    user32.GetWindowDC.argtypes = [ctypes.c_void_p]
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.PrintWindow.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
    gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                                ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
    hdc = user32.GetWindowDC(hwnd)
    memory = gdi32.CreateCompatibleDC(hdc)
    bitmap = gdi32.CreateCompatibleBitmap(hdc, width, height)
    gdi32.SelectObject(memory, bitmap)
    ok = user32.PrintWindow(hwnd, memory, 2)  # PW_RENDERFULLCONTENT
    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = width
    info.bmiHeader.biHeight = -height
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    buffer = ctypes.create_string_buffer(width * height * 4)
    got = gdi32.GetDIBits(memory, bitmap, 0, height, buffer, ctypes.byref(info), 0)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(memory)
    user32.ReleaseDC(hwnd, hdc)
    image = Image.frombuffer("RGBA", (width, height), buffer, "raw", "BGRA", 0, 1).convert("RGB")
    return image, ok, got


def probe_window(args, config):
    """Report whether the window can be captured in the background."""
    reference = config["reference"]
    box = config["box"]
    grid = (config["grid"]["height"], config["grid"]["width"])
    target = np.asarray(config["signature"], dtype=np.float32).reshape(grid)
    threshold = float(config["threshold"])
    deadline = time.time() + max(0.0, args.window_wait)
    window = None
    while time.time() <= deadline:
        pids = process_ids(args.process)
        window = find_window(pids) if pids else None
        if window:
            break
        time.sleep(1.0)
    if not window:
        emit(event="probe", error="window-missing")
        return
    left, top, width, height = client_rect(window)
    scale_x = width / float(reference["width"])
    scale_y = height / float(reference["height"])
    box_px = (
        int(round(box["x"] * scale_x)), int(round(box["y"] * scale_y)),
        int(round((box["x"] + box["width"]) * scale_x)), int(round((box["y"] + box["height"]) * scale_y)),
    )
    screen_image = ImageGrab.grab(
        bbox=(left + box_px[0], top + box_px[1], left + box_px[2], top + box_px[3]),
        all_screens=True,
    )
    screen_score = float(np.abs(signature_of(screen_image, (0, 0, screen_image.width, screen_image.height), grid) - target).mean())
    print_image, ok, got = print_window(window, width, height)
    print_crop = print_image.crop(box_px)
    print_score = float(np.abs(signature_of(print_crop, (0, 0, print_crop.width, print_crop.height), grid) - target).mean())
    emit(
        event="probe",
        window=True,
        foreground=foreground_root() == root_window(window),
        minimized=bool(user32.IsIconic(window)),
        rect=[left, top, width, height],
        screen={"score": round(screen_score, 2), "matched": screen_score <= threshold,
                "mean": round(float(np.asarray(screen_image, dtype=np.float32).mean()), 1)},
        printWindow={"ok": int(ok), "got": int(got), "score": round(print_score, 2),
                     "matched": print_score <= threshold,
                     "mean": round(float(np.asarray(print_crop, dtype=np.float32).mean()), 1)},
        threshold=threshold,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--process", default="dwrg.exe")
    parser.add_argument("--config", required=True)
    parser.add_argument("--poll", type=float, default=0.4)
    parser.add_argument("--click-interval", type=float, default=0.45)
    parser.add_argument("--misses", type=int, default=3)
    parser.add_argument("--window-wait", type=float, default=30.0)
    parser.add_argument("--test-image")
    parser.add_argument("--probe-window", action="store_true")
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    set_dpi_aware()
    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    reference = config["reference"]
    box = config["box"]
    grid = (config["grid"]["height"], config["grid"]["width"])
    target = np.asarray(config["signature"], dtype=np.float32).reshape(grid)
    threshold = float(config["threshold"])
    click_point = config["click"]

    if args.test_image:
        image = Image.open(args.test_image).convert("RGB")
        box_px = (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"])
        score = float(np.abs(signature_of(image, box_px, grid) - target).mean())
        emit(event="test", image=args.test_image, score=round(score, 2), matched=score <= threshold, threshold=threshold)
        return

    if args.probe_window:
        probe_window(args, config)
        return

    if not acquire_single_instance():
        emit(event="stopped", reason="duplicate", clicks=0, checks=0)
        return

    emit(event="ready", process=args.process, poll=args.poll, threshold=threshold)
    parent_pid = args.parent_pid or os.getppid()
    infinite_wait = args.window_wait <= 0
    deadline = 0.0 if infinite_wait else time.time() + max(0.0, args.window_wait)
    window = None
    while infinite_wait or time.time() <= deadline:
        if not parent_alive(parent_pid):
            emit(event="stopped", reason="parent-gone", clicks=0, checks=0)
            return
        pids = process_ids(args.process)
        window = find_window(pids) if pids else None
        if window:
            break
        emit(event="waiting-window", process=args.process)
        time.sleep(1.0)
    if not window:
        emit(event="stopped", reason="window-missing", clicks=0, checks=0)
        return

    emit(event="window-found", hwnd=int(window))
    last_click = 0.0
    clicks = 0
    checks = 0
    misses = 0
    seen = False
    last_score = None
    last_pid_check = 0.0
    while True:
        checks += 1
        if checks % 5 == 1 and not parent_alive(parent_pid):
            emit(event="stopped", reason="parent-gone", clicks=clicks, checks=checks)
            return
        # Refresh the process list rarely; the window handle is cheap to test.
        if time.time() - last_pid_check >= 2.0 or not user32.IsWindow(window):
            pids = process_ids(args.process)
            last_pid_check = time.time()
            if not pids:
                emit(event="stopped", reason="window-closed", clicks=clicks, checks=checks)
                return
            if not user32.IsWindow(window):
                window = find_window(pids)
        if not window:
            time.sleep(args.poll)
            continue
        left, top, width, height = client_rect(window)
        if width <= 0 or height <= 0:
            time.sleep(args.poll)
            continue
        scale_x = width / float(reference["width"])
        scale_y = height / float(reference["height"])
        box_px = (
            int(round(box["x"] * scale_x)),
            int(round(box["y"] * scale_y)),
            int(round((box["x"] + box["width"]) * scale_x)),
            int(round((box["y"] + box["height"]) * scale_y)),
        )
        foreground = foreground_root() == root_window(window)
        crop = None
        if foreground:
            try:
                crop = ImageGrab.grab(
                    bbox=(left + box_px[0], top + box_px[1], left + box_px[2], top + box_px[3]),
                    all_screens=True,
                )
            except Exception as error:
                emit(event="error", message="capture failed: %s" % error)
                time.sleep(args.poll)
                continue
        else:
            window_left, window_top, window_right, window_bottom = window_rect(window)
            window_width = window_right - window_left
            window_height = window_bottom - window_top
            if window_width <= 0 or window_height <= 0:
                time.sleep(args.poll)
                continue
            window_image, ok, got = print_window(window, window_width, window_height)
            if not ok or got == 0:
                if checks % 5 == 1:
                    emit(event="waiting-foreground", clicks=clicks, checks=checks)
                time.sleep(args.poll)
                continue
            offset_x = left - window_left
            offset_y = top - window_top
            crop_box = (
                max(0, offset_x + box_px[0]),
                max(0, offset_y + box_px[1]),
                min(window_width, offset_x + box_px[2]),
                min(window_height, offset_y + box_px[3]),
            )
            crop = window_image.crop(crop_box)
            if np.asarray(crop, dtype=np.float32).mean() < 4.0:
                # PrintWindow returned a black frame: this window cannot be read
                # in the background, so ask for it to be visible again.
                if checks % 5 == 1:
                    emit(event="waiting-foreground", clicks=clicks, checks=checks)
                time.sleep(args.poll)
                continue
        score = float(np.abs(signature_of(crop, (0, 0, crop.width, crop.height), grid) - target).mean())
        last_score = round(score, 2)
        matched = score <= threshold
        emit(event="check", checks=checks, score=last_score, matched=bool(matched), fg=bool(foreground),
             seen=bool(seen), misses=misses, clicks=clicks)
        if matched:
            seen = True
            misses = 0
            now = time.time()
            if now - last_click >= args.click_interval:
                if not args.dry_run and not foreground:
                    brought = bring_to_front(window)
                    emit(event="bring", checks=checks, ok=bool(brought))
                    if not brought:
                        if checks % 3 == 1:
                            emit(event="waiting-foreground", clicks=clicks, checks=checks, reason="focus")
                        time.sleep(args.poll)
                        continue
                    time.sleep(0.2)
                    left, top, width, height = client_rect(window)
                    scale_x = width / float(reference["width"])
                    scale_y = height / float(reference["height"])
                    if foreground_root() != root_window(window):
                        emit(event="bring", checks=checks, ok=False, reason="lost-focus")
                        time.sleep(args.poll)
                        continue
                click_x = left + click_point["x"] * scale_x
                click_y = top + click_point["y"] * scale_y
                if not args.dry_run:
                    click(click_x, click_y)
                clicks += 1
                last_click = now
                emit(event="click", clicks=clicks, checks=checks, score=last_score,
                     x=round(click_x), y=round(click_y), dryRun=args.dry_run,
                     foreground=foreground_root() == root_window(window))
        elif not seen:
            # The target has not appeared yet: wait without counting misses.
            if checks % 5 == 0:
                emit(event="waiting-target", checks=checks, score=last_score)
        else:
            misses += 1
            if checks % 5 == 0 or misses >= args.misses:
                emit(event="check", checks=checks, score=last_score, misses=misses, clicks=clicks)
            if misses >= args.misses:
                emit(event="stopped", reason="target-gone", clicks=clicks, checks=checks, score=last_score)
                return
        time.sleep(args.poll)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        emit(event="stopped", reason="error", message="%s: %s" % (type(error).__name__, error))
        sys.exit(1)
