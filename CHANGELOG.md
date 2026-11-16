# Changelog

## 0.1.0

First release.

- Shows the live Obsidian graph view as the desktop wallpaper.
- **Linux (X11):** full, interactive — zoom, drag, click a node to open it, and
  cursor gravity that bends nearby nodes as the pointer passes.
- **Windows 10/11:** experimental, display-only — the live graph shows behind the
  desktop icons via a PowerShell helper (no cursor gravity or clicking).
- Backgrounds: your theme colour, or an image of your own.
- Linux only: launch Obsidian at login (minimised), and keep a snapshot as the
  system wallpaper so the graph shows before Obsidian has loaded.
- Does no work while idle; repaints only when something actually moves.
