'use strict';

/*
 * Vault Graph Wallpaper — pins a popout of the real graph view to the X11 desktop layer.
 *
 * The popout is an ordinary Obsidian window, so the graph is the live one: same
 * filters, colour groups, theme, snippets and plugins as any other graph tab.
 * The only trick is the window type: _NET_WM_WINDOW_TYPE_DESKTOP makes the
 * window manager stack it under every other window, on all workspaces, with no
 * frame and no taskbar entry.
 */

const { Plugin, PluginSettingTab, Setting, Notice, TFile } = require('obsidian');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW_CLASS = 'vault-graph-wallpaper-window';
const IMAGE_CLASS = 'vault-graph-wallpaper-has-image';
const UPKEEP_INTERVAL_MS = 10000;
// Frameless Electron windows on Linux have rounded corners; push them just past the screen edge.
const OVERSCAN_PX = 8;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
// Set by the login launcher, so only a login start (never a manual one) minimises the main window.
const AUTOSTART_ENV = 'VAULT_GRAPH_WALLPAPER_AUTOSTART';
// Per-node state for the cursor gravity effect, stored on the graph's own node objects.
const FIELD = 'vaultGraphWallpaperField';

// Drives a smooth animation at the display's own refresh rate. Calls step(dt) each frame, where
// dt is seconds since the previous frame, and stops as soon as step returns false. The work each
// step does is what has to stay cheap — the loop itself runs no faster than the screen refreshes.
function animate(win, step) {
  let last = win.performance.now();
  const tick = () => {
    const now = win.performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (step(dt) !== false) win.requestAnimationFrame(tick);
  };
  win.requestAnimationFrame(tick);
}

// data.json is per machine in most synced vaults, so the wallpaper is opt-in on each one.
const DEFAULT_SETTINGS = {
  autoStart: true, // show the wallpaper now and whenever this vault opens
  display: 'primary', // 'primary' | 'all' | Electron display id as a string
  iconsOnTop: true, // true = sit behind the desktop icons and ignore the mouse (the lightweight default)
  fitPadding: 0.08,
  leafId: null,
  background: 'theme', // 'theme' | 'image'
  backgroundImage: '',
  backgroundDim: 0.2,
  nodeSize: 1,
  returnToFitAfter: 45, // seconds without mouse activity before a zoomed view eases back; 0 = never
  cursorGravity: 0.6, // -1..1: above 0 nodes fall toward the cursor, below 0 they part around it, 0 = off
  gravityRadius: 240, // reach of the cursor's pull, in screen pixels
  snapshotWallpaper: false,
  previousWallpaper: null,
  loginStart: false,
};

// Talks to the X server through libX11 so the plugin needs nothing beyond python3.
// argv: <comma separated commands> <window id>. "active" prints the focused window's id.
const X11_HELPER = `
import ctypes, sys
from ctypes import POINTER, byref, c_int, c_long, c_uint, c_ulong, c_void_p, c_char_p

X = ctypes.CDLL("libX11.so.6")
X.XOpenDisplay.restype = c_void_p
X.XOpenDisplay.argtypes = [c_char_p]
X.XInternAtom.restype = c_ulong
X.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]
X.XDefaultRootWindow.restype = c_ulong
X.XDefaultRootWindow.argtypes = [c_void_p]
X.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong, c_int, c_int, c_void_p, c_int]
X.XSendEvent.argtypes = [c_void_p, c_ulong, c_int, c_long, c_void_p]
X.XGetWindowProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong,
                                 POINTER(c_ulong), POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong),
                                 POINTER(c_void_p)]
X.XDeleteProperty.argtypes = [c_void_p, c_ulong, c_ulong]
X.XCreateSimpleWindow.restype = c_ulong
X.XCreateSimpleWindow.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
X.XSelectInput.argtypes = [c_void_p, c_ulong, c_long]
X.XNextEvent.argtypes = [c_void_p, c_void_p]
X.XSync.argtypes = [c_void_p, c_int]
X.XCloseDisplay.argtypes = [c_void_p]

class ClientMessage(ctypes.Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int),
                ("display", c_void_p), ("window", c_ulong), ("message_type", c_ulong),
                ("format", c_int), ("data", c_long * 5)]

class PropertyEvent(ctypes.Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int),
                ("display", c_void_p), ("window", c_ulong), ("atom", c_ulong),
                ("time", c_ulong), ("state", c_int)]

class XEvent(ctypes.Union):
    _fields_ = [("xclient", ClientMessage), ("xproperty", PropertyEvent), ("pad", c_long * 24)]

dpy = X.XOpenDisplay(None)
if not dpy:
    sys.exit("cannot open X display")
root = X.XDefaultRootWindow(dpy)
atom = lambda name: X.XInternAtom(dpy, name.encode(), 0)

def set_type(win, name):
    value = (c_ulong * 1)(atom(name))
    X.XChangeProperty(dpy, win, atom("_NET_WM_WINDOW_TYPE"), 4, 32, 0, value, 1)

def set_input(win, accepts_focus):
    hints = (c_long * 9)(1, 1 if accepts_focus else 0, 0, 0, 0, 0, 0, 0, 0)  # flags = InputHint
    X.XChangeProperty(dpy, win, 35, 35, 32, 0, hints, 9)  # 35 = WM_HINTS

# Source indication 2 ("pager") so the window manager does not second-guess the request.
def message(win, name, *data):
    ev = XEvent()
    ev.xclient.type = 33
    ev.xclient.window = win
    ev.xclient.message_type = atom(name)
    ev.xclient.format = 32
    ev.xclient.data[0] = 2
    for i, value in enumerate(data):
        ev.xclient.data[i + 1] = value
    X.XSendEvent(dpy, root, 0, (1 << 19) | (1 << 20), byref(ev))

# The X server's clock, read the standard way: touch a property and look at the event's time.
# A focus request without a real time is only honoured for windows on the current workspace.
def server_time():
    probe = X.XCreateSimpleWindow(dpy, root, 0, 0, 1, 1, 0, 0, 0)
    X.XSelectInput(dpy, probe, 1 << 22)
    X.XChangeProperty(dpy, probe, atom("_VAULT_GRAPH_WALLPAPER_TIME"), 31, 8, 2, None, 0)
    ev = XEvent()
    for _ in range(50):
        X.XNextEvent(dpy, byref(ev))
        if ev.xproperty.type == 28:
            return ev.xproperty.time
    return 0

def read_ids(win, name):
    kind, fmt, count, rest, data = c_ulong(), c_int(), c_ulong(), c_ulong(), c_void_p()
    X.XGetWindowProperty(dpy, win, atom(name), 0, 4096, 0, 0,
                         byref(kind), byref(fmt), byref(count), byref(rest), byref(data))
    if not count.value or not data.value or fmt.value != 32:
        return []
    values = ctypes.cast(data, POINTER(c_ulong))
    return [values[i] for i in range(count.value)]

def active_window():
    return (read_ids(root, "_NET_ACTIVE_WINDOW") or [0])[0]

# The file manager draws desktop icons in its own desktop-type window, and the window manager
# raises that window whenever the desktop is focused. Marking the wallpaper as its transient
# makes the window manager keep the wallpaper above it at all times.
def icon_window(win):
    desktop = atom("_NET_WM_WINDOW_TYPE_DESKTOP")
    for other in read_ids(root, "_NET_CLIENT_LIST"):
        if other != win and desktop in read_ids(other, "_NET_WM_WINDOW_TYPE"):
            return other
    return 0

# If the wallpaper itself ended up with keyboard focus, pass it to the topmost ordinary window on
# this workspace that is not part of the same app, or to the desktop icons if there is none.
def focus_other(win):
    if active_window() != win:
        return
    mine = read_ids(win, "_NET_WM_PID")
    current = (read_ids(root, "_NET_CURRENT_DESKTOP") or [0])[0]
    skip = {atom("_NET_WM_WINDOW_TYPE_DESKTOP"), atom("_NET_WM_WINDOW_TYPE_DOCK")}
    hidden = atom("_NET_WM_STATE_HIDDEN")
    for other in reversed(read_ids(root, "_NET_CLIENT_LIST_STACKING")):
        if other == win or read_ids(other, "_NET_WM_PID") == mine:
            continue
        if skip & set(read_ids(other, "_NET_WM_WINDOW_TYPE")) or hidden in read_ids(other, "_NET_WM_STATE"):
            continue
        if (read_ids(other, "_NET_WM_DESKTOP") or [current])[0] not in (current, 0xFFFFFFFF):
            continue
        message(other, "_NET_ACTIVE_WINDOW", server_time(), 0)
        return
    icons = icon_window(win)
    if icons:
        message(icons, "_NET_ACTIVE_WINDOW", server_time(), 0)

def above_icons(win):
    other = icon_window(win)
    if other:
        value = (c_ulong * 1)(other)
        X.XChangeProperty(dpy, win, 68, 33, 32, 0, value, 1)  # WM_TRANSIENT_FOR, type WINDOW
    message(win, "_NET_RESTACK_WINDOW", 0, 0)

def below_icons(win):
    X.XDeleteProperty(dpy, win, 68)
    message(win, "_NET_RESTACK_WINDOW", 0, 1)

win = int(sys.argv[2], 0)
for cmd in sys.argv[1].split(","):
    if cmd == "desktop":
        set_type(win, "_NET_WM_WINDOW_TYPE_DESKTOP")
    elif cmd == "normal":
        set_type(win, "_NET_WM_WINDOW_TYPE_NORMAL")
    elif cmd == "below-icons":
        below_icons(win)
    elif cmd == "above-icons":
        above_icons(win)
    elif cmd == "nofocus":
        set_input(win, False)
    elif cmd == "activate":
        message(win, "_NET_ACTIVE_WINDOW", server_time(), 0)
    elif cmd == "focus-other":
        focus_other(win)
    elif cmd == "active":
        print(active_window())
    else:
        sys.exit("unknown command " + cmd)
X.XSync(dpy, 0)
X.XCloseDisplay(dpy)
`;

function x11(commands, xid) {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', X11_HELPER, commands.join(','), String(xid)], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// Windows helper (experimental). PowerShell with inline C# re-parents our window into the layer
// behind the desktop icons — the standard "WorkerW" technique that live-wallpaper tools use, and
// the only way to reach the desktop layer on Windows, since there is no desktop window type.
// This is an independent implementation of that public technique. The window ends up behind the
// icons, which receive the mouse, so on Windows the wallpaper is display-only (no cursor gravity).
// The helper stays running: it re-pins the window if Explorer restarts, and restores it to a
// normal window when its stdin closes (the plugin stops it or Obsidian quits).
const WINDOWS_HELPER = String.raw`
param([Parameter(Mandatory = $true)][string]$Hwnd)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VGW {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string n);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    // Measure in real screen pixels: prefer per-monitor-v2, fall back to the old system-DPI call.
    public static void UsePhysicalPixels() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
        try { SetProcessDPIAware(); } catch {}
    }

    const int GWL_STYLE = -16, SW_RESTORE = 9, SM_CXSCREEN = 0, SM_CYSCREEN = 1;
    const long WS_CHILD = 0x40000000L, WS_POPUP = unchecked((long)0x80000000L), WS_CAPTION = 0x00C00000L,
               WS_THICKFRAME = 0x00040000L, WS_MINIMIZEBOX = 0x00020000L, WS_MAXIMIZEBOX = 0x00010000L, WS_SYSMENU = 0x00080000L;
    const uint SWP_SHOWWINDOW = 0x40, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;

    public static IntPtr Host = IntPtr.Zero;
    static long OriginalStyle = 0;

    static IntPtr FindWorkerW() {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr res;
        // Tell Explorer to spawn the WorkerW that hosts the wallpaper beneath the icon layer.
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0x0, 1000, out res);
        IntPtr worker = IntPtr.Zero;
        EnumWindows((hwnd, l) => {
            if (FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
                worker = FindWindowEx(IntPtr.Zero, hwnd, "WorkerW", null);
            return true;
        }, IntPtr.Zero);
        return worker != IntPtr.Zero ? worker : progman;
    }

    public static void Pin(string s) {
        IntPtr hwnd = new IntPtr(long.Parse(s));
        if (OriginalStyle == 0) OriginalStyle = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
        ShowWindow(hwnd, SW_RESTORE);
        Host = FindWorkerW();
        long child = (OriginalStyle & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_CHILD;
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(child));
        SetParent(hwnd, Host);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN),
            SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    public static void Release(string s) {
        IntPtr hwnd = new IntPtr(long.Parse(s));
        SetParent(hwnd, IntPtr.Zero);
        if (OriginalStyle != 0) SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(OriginalStyle));
        SetWindowPos(hwnd, IntPtr.Zero, 120, 120, 1280, 800, SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    }

    public static bool Alive(string s) { return IsWindow(new IntPtr(long.Parse(s))); }
    public static bool Strayed(string s) { return GetParent(new IntPtr(long.Parse(s))) != Host; }
}
'@
[VGW]::UsePhysicalPixels()
[VGW]::Pin($Hwnd)
$stop = [Console]::In.ReadLineAsync()
while ([VGW]::Alive($Hwnd) -and -not $stop.Wait(2000)) {
    if ([VGW]::Strayed($Hwnd)) { [VGW]::Pin($Hwnd) }  # Explorer restarted; re-pin into the new WorkerW.
}
if ([VGW]::Alive($Hwnd)) { [VGW]::Release($Hwnd) }
`;

function electronRemote() {
  const electron = require('electron');
  return electron.remote || require('@electron/remote');
}

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// Where this desktop keeps its wallpaper setting, or null if it is one we do not know.
function wallpaperSetting() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (desktop.includes('cinnamon')) return { schema: 'org.cinnamon.desktop.background', keys: ['picture-uri'], asUri: true };
  if (desktop.includes('mate')) return { schema: 'org.mate.background', keys: ['picture-filename'], asUri: false };
  if (/gnome|unity|budgie|pantheon/.test(desktop)) {
    return { schema: 'org.gnome.desktop.background', keys: ['picture-uri', 'picture-uri-dark'], asUri: true };
  }
  return null;
}


const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

module.exports = class GraphWallpaperPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.leaf = null;
    this.browserWindow = null;
    this.busy = false;
    this.guarding = false;

    this.addSettingTab(new GraphWallpaperSettingTab(this.app, this));

    this.addCommand({
      id: 'toggle',
      name: 'Toggle graph wallpaper',
      callback: () => (this.leaf ? this.stop() : this.start()),
    });
    this.addCommand({
      id: 'fit',
      name: 'Fit graph to screen',
      checkCallback: (checking) => {
        if (!this.leaf) return false;
        if (!checking) {
          this.userAdjusted = false;
          this.fitGraph(true);
        }
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.guardWindow()));
    this.registerEvent(
      this.app.workspace.on('window-close', (workspaceWindow) => {
        if (this.leaf && !this.quitting && workspaceWindow === this.leaf.getContainer()) this.forget();
      })
    );
    // Obsidian saves open popouts with the workspace and restores them on the next launch.
    // While quitting, leave the wallpaper alone so the next launch can re-adopt it.
    this.quitting = false;
    this.registerEvent(this.app.workspace.on('quit', () => (this.quitting = true)));
    this.registerDomEvent(window, 'beforeunload', () => (this.quitting = true));

    this.registerInterval(window.setInterval(() => this.upkeep(), UPKEEP_INTERVAL_MS));

    if (this.isLinux) {
      // Login autostart is wired through XDG files, so it is Linux-only for now.
      this.minimiseIfLoginStart();
      this.syncLoginStart().catch((err) => console.error('Vault Graph Wallpaper: login start', err));
    }

    this.app.workspace.onLayoutReady(async () => {
      const restored = this.findRestoredLeaves();
      if (this.settings.autoStart && this.isSupported()) await this.start(restored.shift());
      for (const leaf of restored) leaf.detach();
      // Restoring a popout makes Obsidian raise its main window; on a login start, put it away again.
      if (this.loginStarted) this.keepMinimisedAfterLogin();
    });
  }

  onunload() {
    this.stop();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isSupported() {
    if (process.platform === 'linux') return !!process.env.DISPLAY;
    return process.platform === 'win32';
  }

  get isLinux() {
    return process.platform === 'linux';
  }

  get isWindows() {
    return process.platform === 'win32';
  }

  /* ---------- lifecycle ---------- */

  // existingLeaf: a wallpaper popout Obsidian restored from the last session, to take over as is.
  async start(existingLeaf) {
    if (this.leaf || this.busy) return;
    if (!this.isSupported()) {
      new Notice('Vault Graph Wallpaper needs Linux (X11) or Windows.');
      return;
    }
    if (!this.app.internalPlugins?.getPluginById?.('graph')?.enabled) {
      new Notice('Vault Graph Wallpaper: enable the core Graph view plugin first.');
      return;
    }
    this.busy = true;
    try {
      const remote = electronRemote();
      const bounds = this.targetBounds(remote);
      const known = new Set(remote.BrowserWindow.getAllWindows().map((w) => w.id));
      // A new window grabs keyboard focus; remember who had it so it can be handed back (X11 only).
      const focused = this.isLinux ? await x11(['active'], 0).catch(() => '0') : '0';

      const leaf =
        existingLeaf ||
        this.app.workspace.openPopoutLeaf({
          x: bounds.x,
          y: bounds.y,
          size: { width: bounds.width, height: bounds.height },
        });
      this.leaf = leaf;
      this.settings.leafId = leaf.id || null;
      await this.saveSettings();

      const container = leaf.getContainer();
      container.doc.body.classList.add(WINDOW_CLASS);
      this.applyBackground();
      // Once the user zooms or drags the wallpaper themselves, stop re-framing it for them.
      this.userAdjusted = false;
      for (const type of ['wheel', 'pointerdown']) {
        container.doc.addEventListener(
          type,
          () => {
            this.userAdjusted = true;
            this.lastPointerAt = Date.now();
          },
          { capture: true, passive: true }
        );
      }
      this.lastPointerAt = 0;
      this.cursor = null;
      container.doc.addEventListener(
        'pointermove',
        (event) => {
          if (!event.isTrusted) return; // our own hover refresh, see refreshHover
          this.lastPointerAt = Date.now();
          this.cursor = { x: event.clientX, y: event.clientY, held: event.buttons !== 0 };
          this.wakeGravity();
        },
        { capture: true, passive: true }
      );
      // Fires when the pointer moves onto another window or off the screen edge.
      container.doc.documentElement.addEventListener('mouseleave', () => {
        this.cursor = null;
        this.wakeGravity();
      });

      if (leaf.view?.getViewType() !== 'graph') await leaf.setViewState({ type: 'graph', active: false });
      // Pinned, a clicked node opens beside the graph instead of replacing it, and the pin
      // doubles as the mark that identifies this popout when Obsidian restores it.
      leaf.setPinned(true);

      this.browserWindow = this.findBrowserWindow(container.win, remote, known);

      this.lastStackingAt = Date.now();
      this.lastSnapshotAt = 0;
      this.lastNodeCount = -1;
      this.hookNodeClicks();
      this.applyRenderOptions();
      await this.pinToDesktop(remote);
      if (this.isLinux) {
        if (focused !== '0' && focused !== this.windowId()) await x11(['activate'], focused).catch(() => {});
        else await x11(['focus-other'], this.windowId()).catch(() => {});
      }
      this.fitWhenSettled();
    } catch (err) {
      console.error('Vault Graph Wallpaper:', err);
      new Notice(`Vault Graph Wallpaper failed: ${err.message}`);
      await this.stop();
    } finally {
      this.busy = false;
    }
  }

  // Closing a popout makes Obsidian focus its main window; keepFocus puts focus back where it was.
  async stop({ keepFocus = true } = {}) {
    const leaf = this.leaf;
    this.forget();
    if (!leaf) return;
    const focused = keepFocus && this.isLinux ? await x11(['active'], 0).catch(() => '0') : '0';
    leaf.detach();
    if (focused === '0') return;
    await sleep(250);
    const now = await x11(['active'], 0).catch(() => focused);
    if (now !== focused) await x11(['activate'], focused).catch(() => {});
  }

  forget() {
    this.stopWindowsHelper();
    this.leaf = null;
    this.browserWindow = null;
    this.cursor = null;
    this.gravityRunning = false;
    this.awake = null;
    if (this.backgroundUrl) URL.revokeObjectURL(this.backgroundUrl);
    this.backgroundUrl = null;
    if (this.settings.leafId) {
      this.settings.leafId = null;
      this.saveSettings();
    }
  }

  async restart() {
    if (!this.leaf) return;
    await this.stop();
    await sleep(300);
    await this.start();
  }

  // Wallpaper popouts from the last session, which Obsidian has just restored as plain windows.
  // Matched by the saved leaf id, or failing that by shape: a popout holding nothing but a pinned graph.
  findRestoredLeaves() {
    const perContainer = new Map();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const container = leaf.getContainer();
      if (!container?.win || container.win === window) return;
      if (!perContainer.has(container)) perContainer.set(container, []);
      perContainer.get(container).push(leaf);
    });
    const found = [];
    for (const leaves of perContainer.values()) {
      if (leaves.length !== 1) continue;
      const leaf = leaves[0];
      const byId = !!this.settings.leafId && leaf.id === this.settings.leafId;
      const byShape = leaf.getViewState().type === 'graph' && !!leaf.getViewState().pinned;
      if (byId || byShape) found.push(leaf);
    }
    return found;
  }

  /* ---------- window placement ---------- */

  // Follow resolution and monitor changes, and keep the graph framed as the vault grows.
  upkeep() {
    if (!this.leaf || !this.browserWindow || this.busy) return;
    // On Windows the helper process owns the window's geometry and stacking; only drive them on X11.
    if (this.isLinux) {
      try {
        // Safety net: a wallpaper that somehow got minimised puts itself back.
        if (this.browserWindow.isMinimized()) {
          this.browserWindow.restore();
          this.applyStacking()
            .then(() => x11(['focus-other'], this.windowId()))
            .catch((err) => console.debug('Vault Graph Wallpaper: restore', err));
        }
        const want = this.windowBounds(electronRemote());
        const have = this.browserWindow.getBounds();
        if (['x', 'y', 'width', 'height'].some((key) => want[key] !== have[key])) this.browserWindow.setBounds(want);
      } catch (err) {
        console.debug('Vault Graph Wallpaper: bounds check skipped', err);
      }
    }
    // A view the user zoomed or dragged eases back to the whole graph once they have left it alone.
    const idleFor = Date.now() - (this.lastPointerAt || 0);
    if (this.userAdjusted && this.settings.returnToFitAfter > 0 && idleFor > this.settings.returnToFitAfter * 1000) {
      this.userAdjusted = false;
    }
    if (!this.userAdjusted) this.fitGraph();
    this.hookNodeClicks();
    this.applyRenderOptions();
    // Only photograph a graph that has stopped growing, so a half-indexed vault never becomes the snapshot.
    const nodeCount = this.leaf.view?.renderer?.nodes?.length || 0;
    const settled = nodeCount > 0 && nodeCount === this.lastNodeCount;
    this.lastNodeCount = nodeCount;
    if (Date.now() - (this.lastStackingAt || 0) > SNAPSHOT_INTERVAL_MS) {
      this.lastStackingAt = Date.now();
      // The file manager may have restarted with a new desktop window.
      this.applyStacking().catch((err) => console.debug('Vault Graph Wallpaper: stacking', err));
    }
    if (settled && this.settings.snapshotWallpaper && Date.now() - (this.lastSnapshotAt || 0) > SNAPSHOT_INTERVAL_MS) {
      // A skipped snapshot (graph busy, mouse on it) is simply retried on the next pass.
      this.saveSnapshot()
        .then((saved) => {
          if (saved) this.lastSnapshotAt = Date.now();
        })
        .catch((err) => console.error('Vault Graph Wallpaper: snapshot', err));
    }
  }

  windowBounds(remote) {
    const target = this.targetBounds(remote);
    return {
      x: target.x - OVERSCAN_PX,
      y: target.y - OVERSCAN_PX,
      width: target.width + 2 * OVERSCAN_PX,
      height: target.height + 2 * OVERSCAN_PX,
    };
  }

  targetBounds(remote) {
    const screen = remote.screen;
    const displays = screen.getAllDisplays();
    const choice = this.settings.display;
    if (choice === 'all') {
      const left = Math.min(...displays.map((d) => d.bounds.x));
      const top = Math.min(...displays.map((d) => d.bounds.y));
      const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
      const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    const picked = displays.find((d) => String(d.id) === choice) || screen.getPrimaryDisplay();
    return { ...picked.bounds };
  }

  // The popout's own Electron handle, falling back to "whichever window is new".
  findBrowserWindow(popoutWindow, remote, knownIds) {
    try {
      const own = popoutWindow.electronWindow || popoutWindow.require('electron').remote.getCurrentWindow();
      if (own && own.id !== remote.getCurrentWindow().id) return own;
    } catch (err) {
      console.debug('Vault Graph Wallpaper: popout has no direct window handle', err);
    }
    const fresh = remote.BrowserWindow.getAllWindows().find((w) => !knownIds.has(w.id));
    if (!fresh) throw new Error('could not find the popout window');
    return fresh;
  }

  // X11: the window id parsed from the media-source id. Windows: the native HWND as a decimal string.
  windowId() {
    if (this.isWindows) {
      const handle = this.browserWindow.getNativeWindowHandle();
      return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
    }
    const match = /^window:(\d+):/.exec(this.browserWindow.getMediaSourceId());
    if (!match) throw new Error('could not read the X11 window id');
    return match[1];
  }

  async pinToDesktop(remote) {
    const win = this.browserWindow;
    win.setMenuBarVisibility(false);
    win.setSkipTaskbar(true);
    if (this.isWindows) {
      // Windows has no desktop window type; a helper re-parents the window behind the icons instead.
      await this.startWindowsHelper();
      return;
    }
    win.setHasShadow(false);
    win.setFocusable(false);
    await x11(['desktop', 'nofocus'], this.windowId());
    // The window manager re-evaluates the window when its type changes, so set the rest afterwards.
    await sleep(150);
    win.setVisibleOnAllWorkspaces(true);
    win.setBounds(this.windowBounds(remote));
    await this.applyStacking();
  }

  // Desktop icons are drawn by the file manager in its own desktop-type window.
  // Below it: icons stay usable and the graph is click-through. Above it: the graph is interactive.
  // Windows has no equivalent — the helper always sits behind the icons — so this is X11 only.
  async applyStacking() {
    if (!this.browserWindow || !this.isLinux) return;
    await x11([this.settings.iconsOnTop ? 'below-icons' : 'above-icons'], this.windowId());
  }

  // Writes the PowerShell helper into the plugin's data folder and runs it, keeping it alive by
  // holding its stdin open. The window stays pinned behind the icons until stopWindowsHelper ends it.
  async startWindowsHelper() {
    this.stopWindowsHelper();
    const hwnd = this.windowId();
    const file = path.join(this.dataDir(), 'wallpaper-helper.ps1');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, WINDOWS_HELPER);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Hwnd', hwnd],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
    );
    this.winHelper = child;
    child.stderr?.on('data', (d) => console.error('Vault Graph Wallpaper helper:', String(d).trim()));
    child.on('error', (err) => {
      console.error('Vault Graph Wallpaper: could not run the Windows helper', err);
      new Notice('Vault Graph Wallpaper: could not start the Windows helper (PowerShell).');
    });
    child.on('exit', () => {
      if (this.winHelper === child) this.winHelper = null;
    });
  }

  // Closing stdin tells the helper to restore the window and exit; kill it if it lingers.
  stopWindowsHelper() {
    const child = this.winHelper;
    this.winHelper = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch (err) {
      console.debug('Vault Graph Wallpaper: helper stdin already closed', err);
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch (err) {
        console.debug('Vault Graph Wallpaper: helper already gone', err);
      }
    }, 2500);
  }

  /* ---------- picture behind the graph ---------- */

  backgroundMode() {
    return this.settings.background === 'image' && (this.settings.backgroundImage || '').trim() ? 'image' : 'theme';
  }

  // The graph canvas is transparent, so a picture on the element behind it shows through.
  async applyBackground() {
    const container = this.leaf?.getContainer();
    const body = container?.doc?.body;
    if (!body) return;
    if (this.backgroundMode() !== 'image') {
      body.classList.remove(IMAGE_CLASS);
      return;
    }
    try {
      const ratio = container.win.devicePixelRatio || 1;
      const file = (this.settings.backgroundImage || '').trim().replace(/^~(?=\/)/, os.homedir());
      if (!file) throw new Error('no image file chosen');
      const blob = new Blob([await this.scaledBackground(file, ratio)], { type: 'image/jpeg' });
      if (this.leaf?.getContainer() !== container) return;
      if (this.backgroundUrl) URL.revokeObjectURL(this.backgroundUrl);
      this.backgroundUrl = URL.createObjectURL(blob);
      body.style.setProperty('--vault-graph-wallpaper-image', `url("${this.backgroundUrl}")`);
      this.applyBackgroundShading();
      body.classList.add(IMAGE_CLASS);
    } catch (err) {
      body.classList.remove(IMAGE_CLASS);
      console.error('Vault Graph Wallpaper: background', err);
      new Notice(`Vault Graph Wallpaper: could not load the background (${err.message})`);
    }
  }

  applyBackgroundShading() {
    const style = this.leaf?.getContainer()?.doc?.body?.style;
    if (style) style.setProperty('--vault-graph-wallpaper-dim', String(this.settings.backgroundDim));
  }

  // Node size for the wallpaper only. The graph's own settings stay as they are for every other
  // graph tab; Obsidian re-applies them whenever they change, so this is re-asserted regularly.
  applyRenderOptions() {
    try {
      const renderer = this.leaf?.view?.renderer;
      const options = this.app.internalPlugins.getPluginById('graph')?.instance?.options;
      if (!options || typeof renderer?.setRenderOptions !== 'function') return;
      const want = (options.nodeSizeMultiplier ?? 1) * this.settings.nodeSize;
      if (renderer.fNodeSizeMult === want) return;
      renderer.setRenderOptions({
        nodeSizeMultiplier: want,
        lineSizeMultiplier: options.lineSizeMultiplier ?? 1,
        textFadeMultiplier: options.textFadeMultiplier ?? 0,
        showArrow: !!options.showArrow,
      });
      renderer.changed?.();
    } catch (err) {
      console.debug('Vault Graph Wallpaper: node size skipped', err);
    }
  }

  // Wallpapers are often far larger than the screen. Scale once to screen size and keep the
  // result on disk, so later starts just read a small file.
  async scaledBackground(file, ratio) {
    const stat = await fs.promises.stat(file);
    const bounds = this.windowBounds(electronRemote());
    const width = Math.round(bounds.width * ratio), height = Math.round(bounds.height * ratio);
    const key = crypto.createHash('md5').update([file, stat.mtimeMs, stat.size, width, height].join('|')).digest('hex').slice(0, 12);
    const prefix = `background-${this.vaultSlug()}-`;
    const cached = path.join(this.dataDir(), `${prefix}${key}.jpg`);
    try {
      return await fs.promises.readFile(cached);
    } catch (err) {
      // not cached yet
    }
    const source = await fs.promises.readFile(file);
    const full = await createImageBitmap(new Blob([source]));
    const scale = Math.min(1, Math.max(width / full.width, height / full.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(full, 0, 0, canvas.width, canvas.height);
    full.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const bytes = Buffer.from(await blob.arrayBuffer());
    await fs.promises.mkdir(this.dataDir(), { recursive: true });
    for (const name of await fs.promises.readdir(this.dataDir())) {
      if (name.startsWith(prefix)) await fs.promises.rm(path.join(this.dataDir(), name), { force: true });
    }
    await fs.promises.writeFile(cached, bytes);
    return bytes;
  }

  /* ---------- keep the wallpaper a graph ---------- */

  // Clicking a node navigates the wallpaper leaf (or adds a tab next to it).
  // Send the note to the main window instead and put the graph back.
  async guardWindow() {
    if (!this.leaf || this.busy || this.guarding) return;
    this.guarding = true;
    try {
      const container = this.leaf.getContainer();
      const strays = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf !== this.leaf && leaf.getContainer() === container) strays.push(leaf);
      });
      const files = [];
      for (const leaf of strays) {
        if (leaf.view?.file) files.push(leaf.view.file);
        leaf.detach();
      }
      if (this.leaf.view?.getViewType() !== 'graph') {
        if (this.leaf.view?.file) files.push(this.leaf.view.file);
        await this.leaf.setViewState({ type: 'graph', active: false });
        this.leaf.setPinned(true);
        this.hookNodeClicks();
        this.fitWhenSettled();
      }
      for (const file of files) await this.openInMainWindow(file);
    } finally {
      this.guarding = false;
    }
  }

  // Opens notes straight in the main window when a node is clicked, so the wallpaper never
  // shows a note. Relies on the renderer's click callback; guardWindow covers anything it misses.
  hookNodeClicks() {
    const renderer = this.leaf?.view?.renderer;
    if (!renderer || renderer.vaultGraphWallpaperHooked || typeof renderer.onNodeClick !== 'function') return;
    const original = renderer.onNodeClick;
    renderer.onNodeClick = (event, id, type) => {
      const file = this.app.vault.getAbstractFileByPath(id);
      if (file instanceof TFile) {
        this.openInMainWindow(file).catch((err) => console.error('Vault Graph Wallpaper: open note', err));
      } else {
        original(event, id, type);
      }
    };
    renderer.vaultGraphWallpaperHooked = true;
  }

  async openInMainWindow(file) {
    const main = electronRemote().getCurrentWindow();
    if (main.isMinimized()) main.restore();
    main.show();
    // Ask the window manager directly: a focus request from a background window is easily ignored.
    const xid = /^window:(\d+):/.exec(main.getMediaSourceId())?.[1];
    if (xid) await x11(['activate'], xid).catch(() => main.focus());
    else main.focus();
    const workspace = this.app.workspace;
    const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
    if (recent) workspace.setActiveLeaf(recent, { focus: true });
    await workspace.getLeaf('tab').openFile(file);
  }

  // Glide to a zoom and position over about a second instead of jumping there.
  easeView(renderer, scale, panX, panY) {
    const win = this.leaf?.getContainer()?.win;
    if (!win) return;
    const from = { scale: renderer.scale, panX: renderer.panX, panY: renderer.panY };
    const ticket = (this.easeTicket = (this.easeTicket || 0) + 1);
    let elapsed = 0;
    const duration = 0.9;
    animate(win, (dt) => {
      if (ticket !== this.easeTicket || this.leaf?.view?.renderer !== renderer || this.userAdjusted) return false;
      elapsed += dt;
      const t = Math.min(1, elapsed / duration);
      const k = 1 - Math.pow(1 - t, 3);
      const current = from.scale * Math.pow(scale / from.scale, k);
      renderer.zoomTo(current);
      renderer.setPan(from.panX + (panX - from.panX) * k, from.panY + (panY - from.panY) * k);
      renderer.setScale(current);
      renderer.changed();
      return t < 1;
    });
  }

  /* ---------- cursor gravity ---------- */

  // The cursor acts like a mass: nodes within reach are drawn toward it (or part around it, with a
  // negative strength) and follow on springs, so a moving cursor leaves a ripple behind it.
  // It only changes where nodes are drawn. Each node's x/y becomes "layout position + bend": the
  // graph's own layout keeps writing the layout position, and everything that draws reads the sum.
  adoptNode(node) {
    const field = { x: node.x, y: node.y, dx: 0, dy: 0, vx: 0, vy: 0 };
    Object.defineProperty(node, FIELD, { value: field, enumerable: false });
    Object.defineProperty(node, 'x', {
      get: () => field.x + field.dx,
      set: (value) => (field.x = value),
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(node, 'y', {
      get: () => field.y + field.dy,
      set: (value) => (field.y = value),
      enumerable: true,
      configurable: true,
    });
    return field;
  }

  wakeGravity() {
    if (this.gravityRunning || !this.leaf || !this.settings.cursorGravity) return;
    const win = this.leaf.getContainer()?.win;
    if (!win) return;
    this.gravityRunning = true;
    this.gravityFrames = 0;
    animate(win, (dt) => this.gravityStep(dt));
  }

  // One frame of the spring simulation. Only touches nodes that are near the cursor or still
  // moving, and only asks the graph to repaint when a node has actually shifted by a visible
  // amount — so a cursor crossing empty space, or resting, costs almost nothing and never forces
  // the whole graph to re-render. Returns false (stopping the loop) once everything is at rest.
  gravityStep(dt) {
    const renderer = this.leaf?.view?.renderer;
    const win = this.leaf?.getContainer()?.win;
    if (!renderer?.nodes || !win) return (this.gravityRunning = false);
    try {
      const strength = this.settings.cursorGravity;
      const ratio = win.devicePixelRatio || 1;
      const scale = renderer.scale || 1;
      // No pull while a button is down: dragging a node or the view should feel exact.
      const cursor = strength && this.cursor && !this.cursor.held && !renderer.dragNode ? this.cursor : null;
      const cx = cursor ? (cursor.x * ratio - renderer.panX) / scale : 0;
      const cy = cursor ? (cursor.y * ratio - renderer.panY) / scale : 0;
      const reach = (this.settings.gravityRadius * ratio) / scale;
      const reach2 = reach * reach;
      const pull2 = reach2 * 9; // nodes beyond this are out of the cursor's reach
      const stiffness = 70, damping = 9; // slightly underdamped: a soft overshoot reads as a wave

      // The working set is every node the cursor currently reaches, plus any still springing back.
      const awake = this.awake || (this.awake = new Set());
      if (cursor) {
        for (const node of renderer.nodes) {
          const field = node[FIELD] || this.adoptNode(node);
          const ox = field.x - cx, oy = field.y - cy;
          if (ox * ox + oy * oy < pull2) awake.add(node);
        }
      }

      let moved = 0, restless = 0;
      for (const node of awake) {
        const field = node[FIELD];
        let tx = 0, ty = 0;
        if (cursor) {
          const ox = field.x - cx, oy = field.y - cy;
          const d2 = ox * ox + oy * oy;
          if (d2 < pull2) {
            // Scales the node's offset from the cursor, so nodes never cross it or each other.
            const bend = -0.6 * strength * Math.exp(-d2 / reach2);
            tx = ox * bend;
            ty = oy * bend;
          }
        }
        const dx0 = field.dx, dy0 = field.dy;
        field.vx += (stiffness * (tx - field.dx) - damping * field.vx) * dt;
        field.vy += (stiffness * (ty - field.dy) - damping * field.vy) * dt;
        field.dx += field.vx * dt;
        field.dy += field.vy * dt;
        moved = Math.max(moved, (Math.abs(field.dx - dx0) + Math.abs(field.dy - dy0)) * scale);
        const unrest = Math.abs(tx - field.dx) + Math.abs(ty - field.dy) + (Math.abs(field.vx) + Math.abs(field.vy)) * 0.05;
        if (unrest * scale < 0.04) {
          field.dx = tx;
          field.dy = ty;
          field.vx = field.vy = 0;
          if (tx === 0 && ty === 0) awake.delete(node); // back home and nothing pulling it
        } else {
          restless++;
        }
      }

      // Repaint only when something actually shifted on screen. No movement, no render.
      if (moved > 0.3) {
        renderer.changed();
        if (++this.gravityFrames % 6 === 0) this.refreshHover(renderer, win);
      }
      if (restless === 0 && awake.size === 0) {
        this.gravityRunning = false; // settled; the next pointer move wakes it again
        this.refreshHover(renderer, win);
        return false;
      }
    } catch (err) {
      console.debug('Vault Graph Wallpaper: cursor gravity stopped', err);
      return (this.gravityRunning = false);
    }
  }

  // Nodes that slid under a resting cursor are not noticed by the graph until the pointer moves.
  // Replaying the pointer's position lets it pick up the node that is now under the cursor.
  refreshHover(renderer, win) {
    try {
      const target = renderer.interactiveEl;
      if (!this.cursor || this.cursor.held || !target?.dispatchEvent) return;
      target.dispatchEvent(
        new win.PointerEvent('pointermove', {
          clientX: this.cursor.x,
          clientY: this.cursor.y,
          bubbles: true,
          pointerType: 'mouse',
          pointerId: 1,
          isPrimary: true,
        })
      );
    } catch (err) {
      console.debug('Vault Graph Wallpaper: hover refresh skipped', err);
    }
  }

  /* ---------- instant wallpaper at login ---------- */

  dataDir() {
    const base = this.isWindows
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'obsidian-vault-graph-wallpaper');
  }

  vaultSlug() {
    return this.app.vault.getName().replace(/[^\w.-]+/g, '_') || 'vault';
  }

  snapshotPath() {
    return path.join(this.dataDir(), `${this.vaultSlug()}.png`);
  }

  // Saves a picture of the settled graph and makes it the ordinary system wallpaper, so the desktop
  // already shows the graph at login while Obsidian is still loading behind it.
  // Returns true when a picture was saved. Skips while the graph is moving or the mouse is on it,
  // so a hover highlight or a half-finished drag never becomes the login picture.
  async saveSnapshot() {
    if (!this.leaf || !this.browserWindow) return false;
    const renderer = this.leaf.view?.renderer;
    if (renderer && typeof renderer.idleFrames === 'number' && renderer.idleFrames <= 60) return false;
    if (renderer?.getHighlightNode?.() || renderer?.dragNode) return false;
    if (this.cursor || this.gravityRunning || Date.now() - (this.lastPointerAt || 0) < 15000) return false;
    const target = this.targetBounds(electronRemote());
    const image = await this.browserWindow.webContents.capturePage({
      x: OVERSCAN_PX,
      y: OVERSCAN_PX,
      width: target.width,
      height: target.height,
    });
    const png = image.toPNG();
    if (!png?.length) return false;
    const file = this.snapshotPath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, Buffer.from(png));
    await fs.promises.rename(`${file}.tmp`, file);
    await this.useSnapshotAsWallpaper(file);
    return true;
  }

  async useSnapshotAsWallpaper(file) {
    const setting = wallpaperSetting();
    if (!setting) return;
    const value = setting.asUri ? `file://${encodeURI(file)}` : file;
    const current = (await run('gsettings', ['get', setting.schema, setting.keys[0]])).replace(/^'|'$/g, '');
    if (current === value) return;
    if (!this.settings.previousWallpaper) {
      this.settings.previousWallpaper = current;
      await this.saveSettings();
    }
    for (const key of setting.keys) await run('gsettings', ['set', setting.schema, key, value]);
  }

  async restoreWallpaper() {
    const setting = wallpaperSetting();
    const previous = this.settings.previousWallpaper;
    this.settings.previousWallpaper = null;
    await this.saveSettings();
    if (!setting || !previous) return;
    for (const key of setting.keys) await run('gsettings', ['set', setting.schema, key, previous]);
  }

  loginFiles() {
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return {
      launcher: path.join(this.dataDir(), `start-${this.vaultSlug()}.sh`),
      entry: path.join(config, 'autostart', `obsidian-vault-graph-wallpaper-${this.vaultSlug()}.desktop`),
    };
  }

  // Keeps the login entry in step with the setting. The launcher waits for the vault folder to
  // exist (it may be a network mount) and starts Obsidian with its main window minimised.
  async syncLoginStart() {
    const { launcher, entry } = this.loginFiles();
    if (!this.settings.loginStart) {
      await fs.promises.rm(launcher, { force: true });
      await fs.promises.rm(entry, { force: true });
      return;
    }
    const vault = this.app.vault.adapter.getBasePath();
    const binary = process.env.APPIMAGE || process.execPath;
    const script = [
      '#!/bin/sh',
      '# Written by the Vault Graph Wallpaper plugin for Obsidian. Turn off "Start Obsidian at login" to remove it.',
      `VAULT=${shellQuote(vault)}`,
      'tries=0',
      'while [ ! -d "$VAULT/.obsidian" ] && [ "$tries" -lt 180 ]; do sleep 1; tries=$((tries + 1)); done',
      '[ -d "$VAULT/.obsidian" ] || exit 0',
      `${AUTOSTART_ENV}=1 exec ${shellQuote(binary)} ${shellQuote(`obsidian://open?path=${encodeURIComponent(vault)}`)}`,
      '',
    ].join('\n');
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=Vault Graph Wallpaper (${this.app.vault.getName()})`,
      'Comment=Start Obsidian minimised so the graph wallpaper is live',
      `Exec="${launcher.replace(/(["\\`$])/g, '\\$1')}"`,
      'NoDisplay=true',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');
    await fs.promises.mkdir(path.dirname(launcher), { recursive: true });
    await fs.promises.writeFile(launcher, script, { mode: 0o755 });
    await fs.promises.chmod(launcher, 0o755);
    await fs.promises.mkdir(path.dirname(entry), { recursive: true });
    await fs.promises.writeFile(entry, desktop);
  }

  // Obsidian raises its main window again while it finishes starting (restoring popouts, handling
  // the open-vault link), at no fixed moment. For a short while after a login start, put it back.
  async keepMinimisedAfterLogin() {
    const main = electronRemote().getCurrentWindow();
    const until = Date.now() + 20000;
    while (Date.now() < until && !this.userTouchedMain) {
      if (!main.isMinimized()) {
        main.minimize();
        // Minimising can leave the wallpaper holding keyboard focus; pass it on.
        await sleep(400);
        if (this.browserWindow) await x11(['focus-other'], this.windowId()).catch(() => {});
      }
      await sleep(500);
    }
  }

  minimiseIfLoginStart() {
    try {
      if (!process.env[AUTOSTART_ENV] || window.sessionStorage.getItem(AUTOSTART_ENV)) return;
      window.sessionStorage.setItem(AUTOSTART_ENV, 'done');
      this.loginStarted = true;
      // If the user starts working in the main window while the vault loads, leave it up afterwards.
      for (const type of ['pointerdown', 'keydown']) {
        this.registerDomEvent(document, type, () => (this.userTouchedMain = true), { capture: true });
      }
      electronRemote().getCurrentWindow().minimize();
    } catch (err) {
      console.debug('Vault Graph Wallpaper: could not minimise on login start', err);
    }
  }

  /* ---------- framing ---------- */

  async fitWhenSettled() {
    const leaf = this.leaf;
    for (const delay of [1500, 3000, 6000]) {
      await sleep(delay);
      if (this.leaf !== leaf) return;
      this.fitGraph();
    }
  }

  // Uses the graph renderer's internals; quietly does nothing if they ever change shape.
  // Small drifts are left alone unless forced: Obsidian writes every zoom change to graph.json.
  fitGraph(force = false) {
    try {
      const renderer = this.leaf?.view?.renderer;
      const nodes = renderer?.nodes;
      if (!nodes?.length || typeof renderer.zoomTo !== 'function') return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of nodes) {
        // Where the layout put the node, ignoring any bend the cursor is causing right now.
        const x = node[FIELD] ? node[FIELD].x : node.x, y = node[FIELD] ? node[FIELD].y : node.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX)) return;
      // The renderer pans and scales in device pixels.
      const ratio = this.leaf.getContainer().win.devicePixelRatio || 1;
      const width = renderer.width * ratio, height = renderer.height * ratio;
      if (!width || !height) return;
      const pad = 1 - 2 * this.settings.fitPadding;
      const scale = Math.min((width * pad) / Math.max(maxX - minX, 1), (height * pad) / Math.max(maxY - minY, 1));
      const panX = width / 2 - ((minX + maxX) / 2) * scale;
      const panY = height / 2 - ((minY + maxY) / 2) * scale;
      const scaleDrift = Math.abs(scale / renderer.scale - 1);
      const panDrift = Math.max(Math.abs(panX - renderer.panX) / width, Math.abs(panY - renderer.panY) / height);
      if (!force && scaleDrift < 0.05 && panDrift < 0.03) return;
      this.easeView(renderer, scale, panX, panY);
    } catch (err) {
      console.debug('Vault Graph Wallpaper: fit skipped', err);
    }
  }
};

class GraphWallpaperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    containerEl.empty();

    if (!plugin.isSupported()) {
      containerEl.createEl('p', {
        text: 'Vault Graph Wallpaper works on Linux (X11) and Windows. This platform is not supported.',
      });
      return;
    }

    const s = plugin.settings;
    const interactive = !s.iconsOnTop;

    // --- the two decisions that matter ---
    new Setting(containerEl)
      .setName('Show the graph wallpaper')
      .setDesc('Put your live graph on the desktop, now and whenever this vault opens.')
      .addToggle((toggle) =>
        toggle.setValue(s.autoStart).onChange(async (value) => {
          s.autoStart = value;
          await plugin.saveSettings();
          if (value) await plugin.start();
          else await plugin.stop({ keepFocus: false });
        })
      );

    // Interactivity and cursor gravity need the window above the icon layer, which only X11 allows.
    // On Windows the window sits behind the icons (which take the mouse), so it is display-only.
    if (plugin.isWindows) {
      const note = new Setting(containerEl).setName('Windows support is experimental').setDesc(
        'The graph is shown behind your desktop icons and updates live, but it is display-only on ' +
          'Windows — no cursor gravity, zoom or node clicks. Please report problems with your Windows version.'
      );
      note.settingEl.style.opacity = '0.85';
    }

    if (plugin.isLinux) {
      new Setting(containerEl)
        .setName('Interactive')
        .setDesc(
          'Let the wallpaper respond to the mouse: zoom and drag the graph, click a node to open it, ' +
            'and let the cursor bend nearby nodes. Off: the graph sits quietly behind your desktop icons ' +
            'and uses no resources.'
        )
        .addToggle((toggle) =>
          toggle.setValue(interactive).onChange(async (value) => {
            s.iconsOnTop = !value;
            await plugin.saveSettings();
            await plugin.applyStacking();
            this.display(); // the motion settings only make sense when interactive
          })
        );
    }

    // --- Appearance ---
    new Setting(containerEl).setName('Appearance').setHeading();

    new Setting(containerEl)
      .setName('Background')
      .setDesc('What sits behind the graph: your theme colour, or an image of your own.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('theme', 'Theme colour')
          .addOption('image', 'Your image')
          .setValue(plugin.backgroundMode())
          .onChange(async (value) => {
            s.background = value;
            await plugin.saveSettings();
            await plugin.applyBackground();
            this.display(); // reveal or hide the image and dimming controls
          })
      );

    if (plugin.backgroundMode() === 'image') {
      new Setting(containerEl)
        .setName('Image file')
        .setDesc('Full path to the picture.')
        .addText((text) =>
          text
            .setPlaceholder('/home/you/Pictures/wallpaper.jpg')
            .setValue(s.backgroundImage)
            .onChange(async (value) => {
              s.backgroundImage = value.trim();
              await plugin.saveSettings();
              const file = s.backgroundImage.replace(/^~(?=\/)/, os.homedir());
              if (file && fs.existsSync(file)) await plugin.applyBackground();
            })
        );
    }

    if (plugin.backgroundMode() !== 'theme') {
      new Setting(containerEl)
        .setName('Dim background')
        .setDesc('Darken the scene so the nodes and labels stay easy to read.')
        .addSlider((slider) =>
          slider
            .setLimits(0, 0.9, 0.05)
            .setValue(s.backgroundDim)
            .setDynamicTooltip()
            .onChange(async (value) => {
              s.backgroundDim = value;
              await plugin.saveSettings();
              plugin.applyBackgroundShading();
            })
        );
    }

    new Setting(containerEl)
      .setName('Node size')
      .setDesc('Node size on the wallpaper only; other graph tabs keep their own.')
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 1.5, 0.05)
          .setValue(s.nodeSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.nodeSize = value;
            await plugin.saveSettings();
            plugin.applyRenderOptions();
          })
      );

    // fitPadding is the margin around the graph; show it the friendly way round (bigger = fills more).
    new Setting(containerEl)
      .setName('Graph size')
      .setDesc('How much of the screen the whole-graph view fills.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(Math.min(1, Math.max(0, (0.3 - s.fitPadding) / 0.28)))
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.fitPadding = Math.round((0.3 - value * 0.28) * 100) / 100;
            await plugin.saveSettings();
            plugin.userAdjusted = false;
            plugin.fitGraph(true);
          })
      );

    // --- Motion (only meaningful while interactive, which is X11-only) ---
    if (plugin.isLinux && interactive) {
      new Setting(containerEl).setName('Motion').setHeading();

      new Setting(containerEl)
        .setName('Cursor gravity')
        .setDesc('The cursor bends the graph as it passes. Right of centre, nearby nodes fall toward it; left, they part around it like a lens; centre is off.')
        .addSlider((slider) =>
          slider
            .setLimits(-1, 1, 0.1)
            .setValue(s.cursorGravity)
            .setDynamicTooltip()
            .onChange(async (value) => {
              const wasOff = s.cursorGravity === 0;
              s.cursorGravity = value;
              await plugin.saveSettings();
              plugin.wakeGravity();
              if (wasOff !== (value === 0)) this.display(); // reveal or hide Reach
            })
        );

      if (s.cursorGravity !== 0) {
        new Setting(containerEl)
          .setName('Reach')
          .setDesc('How far from the cursor the bend is felt.')
          .addSlider((slider) =>
            slider
              .setLimits(80, 600, 10)
              .setValue(s.gravityRadius)
              .setDynamicTooltip()
              .onChange(async (value) => {
                s.gravityRadius = value;
                await plugin.saveSettings();
              })
          );
      }

      new Setting(containerEl)
        .setName('Return to full view after')
        .setDesc('Seconds of no mouse activity before a zoomed or dragged view eases back to the whole graph. 0 keeps your view.')
        .addSlider((slider) =>
          slider
            .setLimits(0, 300, 5)
            .setValue(s.returnToFitAfter)
            .setDynamicTooltip()
            .onChange(async (value) => {
              s.returnToFitAfter = value;
              await plugin.saveSettings();
            })
        );
    }

    // --- Startup (login autostart and system-wallpaper snapshot are X11-only for now) ---
    if (plugin.isLinux) {
      new Setting(containerEl).setName('Startup').setHeading();

      new Setting(containerEl)
        .setName('Launch Obsidian at login')
        .setDesc('Open this vault at login with its window minimised, so the wallpaper comes up on its own.')
        .addToggle((toggle) =>
          toggle.setValue(s.loginStart).onChange(async (value) => {
            s.loginStart = value;
            await plugin.saveSettings();
            await plugin.syncLoginStart();
          })
        );

      new Setting(containerEl)
        .setName('Show the graph while Obsidian is closed')
        .setDesc(
          wallpaperSetting()
            ? 'Keep a picture of the graph as your system wallpaper, so the desktop shows it before Obsidian has loaded and whenever it is closed. Off puts your previous wallpaper back.'
            : `Save a picture of the graph to ${plugin.snapshotPath()} — this desktop is not one the plugin can set automatically, so point your wallpaper at that file.`
        )
        .addToggle((toggle) =>
          toggle.setValue(s.snapshotWallpaper).onChange(async (value) => {
            s.snapshotWallpaper = value;
            await plugin.saveSettings();
            if (value) await plugin.saveSnapshot();
            else await plugin.restoreWallpaper();
          })
        );
    }

    // --- Display (X11 only; the Windows helper always uses the primary monitor) ---
    let displays = [];
    try {
      displays = electronRemote().screen.getAllDisplays();
    } catch (err) {
      console.debug('Vault Graph Wallpaper: could not list displays', err);
    }
    if (plugin.isLinux && displays.length > 1) {
      new Setting(containerEl).setName('Display').setHeading();
      new Setting(containerEl)
        .setName('Monitor')
        .setDesc('Which screen the graph covers.')
        .addDropdown((dropdown) => {
          dropdown.addOption('primary', 'Primary monitor');
          dropdown.addOption('all', 'Span all monitors');
          for (const d of displays) {
            dropdown.addOption(String(d.id), `${d.label || 'Display'} (${d.bounds.width}×${d.bounds.height})`);
          }
          dropdown.setValue(s.display).onChange(async (value) => {
            s.display = value;
            await plugin.saveSettings();
            await plugin.restart();
          });
        });
    }
  }
}
