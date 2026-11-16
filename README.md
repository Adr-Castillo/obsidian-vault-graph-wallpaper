# Graph Wallpaper

Use your live Obsidian graph view as the desktop wallpaper on Linux (X11).

![The graph wallpaper: an Obsidian graph over a starfield and lunar horizon](docs/screenshot.jpg)

The wallpaper is a real Obsidian popout window showing the real graph view, so it has the same filters, colour groups, theme, CSS snippets and plugins as any other graph tab, and it updates as the vault changes. The plugin strips the window chrome and asks the window manager to treat the window as part of the desktop (`_NET_WM_WINDOW_TYPE_DESKTOP`), which puts it under every other window on every workspace.

## Requirements

- Linux with an X11 session and an EWMH window manager. Built and tested on Cinnamon (Muffin) with Obsidian 1.14 and 1.15.
- `python3` with the system `libX11` (present on any X11 desktop). No other dependencies and no build step.
- The core Graph view plugin enabled.

## Install

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/graph-wallpaper/`, then enable **Graph Wallpaper** under Settings → Community plugins.

## Use

Command palette: **Graph Wallpaper: Toggle graph wallpaper** and **Fit graph to screen**.

Settings → Graph Wallpaper (only the controls that apply to your setup are shown):

- **Show the graph wallpaper** — put your live graph on the desktop, now and whenever this vault opens.
- **Interactive** — respond to the mouse (zoom, drag, click a node to open it, cursor gravity). Off: the graph sits behind your desktop icons and uses no resources.
- **Appearance** — background (theme colour, the built-in space scene, or your own image), how much to dim it, node size, and how much of the screen the graph fills.
- **Motion** (interactive only) — cursor gravity and its reach, and how long after you stop before a zoomed view eases back to the whole graph.
- **Startup** — launch Obsidian at login (minimised), and keep a snapshot of the graph as your system wallpaper so the desktop shows it before Obsidian loads and while it is closed.
- **Display** (multi-monitor only) — which screen the graph covers.

Files the plugin writes outside the vault, all under `~/.local/share/obsidian-graph-wallpaper/` plus one entry in `~/.config/autostart/`: the snapshot, a screen-sized copy of the background image, and the login launcher.

## Performance

The wallpaper is a normal graph view, so at rest it uses no CPU — Obsidian stops rendering it once it settles. The plugin adds work only while something is actually moving:

- **Idle, or the cursor away from the graph:** no cost. The effect never repaints the graph unless a node has visibly moved, so sweeping the cursor across empty desktop is free.
- **Cursor moving through the node cluster:** the graph redraws each frame to animate the ripple, at your display's refresh rate (no artificial cap, so it stays smooth). On a large vault this uses the GPU while you move, and drops back to zero the moment you stop. Lower **Gravity reach**, or set **Cursor gravity** to 0, if you would rather it do less.

## Limits

- Obsidian has to be running for the wallpaper to be live. Without it you see the snapshot, or your normal wallpaper if snapshots are off.
- Native Wayland sessions are not supported.
- Fitting the graph and opening notes straight from a node click use undocumented internals of the graph renderer. If a future Obsidian changes them, fitting stops and clicks fall back to a slower path; the wallpaper itself keeps working.
- The wallpaper leaf is pinned; a popout that contains only a pinned graph is treated as the wallpaper when Obsidian restores its windows.
- In interactive mode the desktop icons and the desktop right-click menu are covered by the graph.
