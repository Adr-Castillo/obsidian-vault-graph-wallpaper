# Changelog

## 0.2.0

- Windows starts with a transparent, live graph over the existing desktop wallpaper on the primary display.
- Windows adds cursor gravity, node hover, click-to-open, wheel zoom, middle-button pan, and Shift + middle-drag to move between displays.
- The monitor preference is saved per vault. Previously selected theme or image backgrounds keep their settings and gain Windows mouse controls.
- Windows caps graph painting at 30 FPS during interaction. The spring simulation stops once the graph settles.
- Requires Obsidian 1.15.1. The 0.1.0 release remains available for earlier versions.

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
