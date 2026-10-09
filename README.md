# Display Profiles

An [Omarchy](https://omarchy.org/) shell plugin for arranging monitors and
remembering the arrangement for every place you plug in.

Drag your displays to where they sit on your desk, choose which workspaces live
on which display, and save it. The next time the same displays are connected
(at home, at work, at your parents' place, or with nothing plugged in at all)
the layout comes back on its own.

## Features

- **Drag-and-drop arrangement.** A map of your displays in the bar panel.
  Dropped displays snap edge to edge, so the layout never has gaps or overlaps.
- **Workspaces per display.** Assign workspaces 1–10 to displays, so
  `SUPER+5` always lands on the screen you expect.
- **One profile per setup, applied automatically.** A setup is recognised by
  the displays connected to it (make, model, and serial number), not by
  connector names such as `DP-7`, which change every time a dock is replugged.
- **Dock aware.** With a Thunderbolt or USB4 dock, the dock's own id tells
  apart two desks that have identical monitors, and gives the profile its name.
- **Scale, rotation, and on/off** per display. Only scales the display's mode
  can actually run at are offered.
- **Leaves your configuration alone.** Nothing under `~/.config/hypr` is ever
  written. See [How it works](#how-it-works).

## Install

```bash
omarchy plugin add https://github.com/gillmania/omarchy-display-profiles.git --enable
```

Without `--enable` the plugin is cloned but left off, so you can read the code
first:

```bash
omarchy plugin enable io.github.gillmania.display-profiles --section right
```

Requires Omarchy 4 (Quattro) with Hyprland's Lua configuration. There are no
other dependencies: the plugin only calls `hyprctl`, which Omarchy ships.

## Use

Click the display icon in the bar.

1. Drag the displays in the map to match your desk.
2. Select a display (click it in the map or in the list) and pick its scale,
   rotation, and workspaces.
3. **Apply** tries the arrangement without saving it. **Save as profile…**
   stores it for the displays that are connected right now.

From then on the profile is applied whenever that set of displays appears, and
after every Hyprland config reload. Right-click the bar icon to re-apply it by
hand. Turn automatic applying off with the last row of the panel.

A profile always belongs to the setup it was saved on. To make one for another
desk, plug in there and save.

### Keyboard

| Key | Action |
|---|---|
| `←` `→` `↑` `↓` | Select the previous or next display |
| `1`–`9`, `0` | Move workspace 1–10 to the selected display |
| `r` | Rotate the selected display |
| `e` | Turn the selected display on or off |
| `a` or `Enter` | Apply |
| `s` | Save |
| `Tab` | Switch to the neighbouring bar panel |
| `Esc` | Close |

### Command line

The service answers on the `display-profiles` IPC target:

```bash
omarchy-shell display-profiles status          # JSON: displays, dock, matched profile
omarchy-shell display-profiles list            # id<TAB>name per profile
omarchy-shell display-profiles apply           # re-apply the profile for this setup
omarchy-shell display-profiles save "Home"     # save the current arrangement
omarchy-shell display-profiles remove p1
omarchy-shell display-profiles autoApply false
```

Bind one in `~/.config/hypr/bindings.lua` if you want a key for it:

```lua
o.bind("SUPER + CTRL + P", "Apply display profile", "omarchy-shell display-profiles apply")
```

## How it works

The plugin has two halves, both running inside `omarchy-shell`:

- `Service.qml` listens for Hyprland's monitor and config-reload events, reads
  the connected displays with `hyprctl -j monitors all`, and looks up the
  profile for that setup.
- `BarWidget.qml` and `Panel.qml` are the bar button and the editor.

A profile is applied with `hyprctl eval`, as `hl.monitor(...)` and
`hl.workspace_rule(...)` calls, and existing workspaces are moved to their
displays. These are runtime settings: they are not written to any file and are
gone after `hyprctl reload` or a restart, at which point the service applies
the profile again.

Every value placed in the evaluated Lua is either a connector name matching
`[A-Za-z0-9._-]+` or a number, so neither a strangely named output nor a
hand-edited profile file can inject code.

### Files

| Path | Contents |
|---|---|
| `~/.config/omarchy-display-profiles/profiles.json` | Your saved profiles. Plain JSON, safe to back up or sync. |

That is the only file the plugin writes.

### If you already configure monitors in `monitors.lua`

Your `~/.config/hypr/monitors.lua` keeps working and is what you get whenever
no profile matches. Where a profile and your config disagree, the profile wins
while it is applied. If your config has its own `hl.workspace_rule` lines for
workspaces 1–10, a new profile starts from them, and you can remove them once
the profile does the job.

## Remove

```bash
omarchy plugin remove io.github.gillmania.display-profiles
```

Disabling or removing the plugin switches off the workspace rules it added. The
current arrangement stays until the next `hyprctl reload` or restart, which
returns everything to your own Hyprland configuration. To delete the saved
profiles as well:

```bash
rm -r ~/.config/omarchy-display-profiles
```

## Limitations

- Dock identity is read from Thunderbolt/USB4 (`/sys/bus/thunderbolt`). With a
  plain USB-C or HDMI connection, a setup is recognised by its displays alone.
  That only matters if two desks have the same serial-less monitors.
- The current resolution and refresh rate of each display are kept; there is no
  mode picker.
- Mirroring is not managed. Use Omarchy's built-in Display panel for that.
- Workspaces above 10 are left alone.
- At login the profile is applied a moment after the bar appears, not before.

## Develop

```bash
node --test test/        # unit tests for Model.js
scripts/dev-install      # copy the tree into ~/.config/omarchy/plugins and reload
omarchy plugin validate .
qs log -p "$OMARCHY_PATH/shell" --tail 100   # QML errors
```

All decisions (identity, matching, snapping, the generated Lua) live in
`Model.js`, which has no dependency on QML and is covered by the tests.

The shell hot-reloads the bar widget and panel when their files change. The
running service is kept across a reload, so after editing `Service.qml` or
`Model.js` run `omarchy restart shell` to load the new code.

## License

MIT. See [LICENSE](LICENSE). The scale-rounding rule follows Omarchy's
`omarchy-hyprland-monitor-scaling`.
