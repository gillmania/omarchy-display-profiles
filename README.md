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
- **See it in the bar.** Optionally lists the workspaces grouped by display, in
  place of the built-in workspace switcher.
- **One profile per setup, applied automatically.** A setup is recognised by
  the displays connected to it (make, model, and serial number), not by
  connector names such as `DP-7`, which change every time a dock is replugged.
- **Dock aware.** With a Thunderbolt or USB4 dock, a profile belongs to that
  dock. Two desks with identical monitors get a profile each, and saving at
  one dock never replaces the profile of another.
- **Several profiles per setup.** Keep, say, "All screens" and "Laptop only"
  for the same desk and switch between them from the panel or a key. The one
  you used last is the one that comes back. Useful when monitors are switched
  off at their power button, which a dock usually does not report.
- **Hard to lock yourself out.** A layout that changes a display's resolution,
  scale, rotation, or on/off state has to be confirmed within 15 seconds, or
  the previous layout comes back. Moving displays around needs no
  confirmation.
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
4. If the layout changed a display's scale, rotation, resolution, or on/off
   state, the panel reopens and asks
   **Keep this layout?** Answer within 15 seconds or you are taken back: to
   the layout that was applied before, or to your own Hyprland configuration
   if none was. A profile being saved is only written once you keep it.
   Moving displays, or changing which workspaces go where, needs no
   confirmation. The
   countdown starts when the layout has gone in, and a layout cannot be tried
   while every screen is asleep.

From then on the profile is applied whenever that set of displays appears, and
after every Hyprland config reload. Right-click the bar icon to re-apply it by
hand. Turn automatic applying off with the last row of the panel.

A profile always belongs to the setup it was saved on: the same displays behind
the same dock. To make one for another desk, plug in there and save. When you
plug into a setup that has no profile, your own Hyprland configuration is put
back in force.

### Workspaces in the bar

The widget can also take over from Omarchy's workspace switcher and show which
display each workspace belongs to. Neighbouring workspaces on the same display
share a line under their numbers; the line is strong for the display that bar
is on and faint for the others. Hover a number for the display's name.

```bash
omarchy bar set io.github.gillmania.display-profiles workspaces true --json
omarchy bar move io.github.gillmania.display-profiles --after omarchy.workspaces
omarchy plugin disable omarchy.workspaces
```

To go back:

```bash
omarchy plugin enable omarchy.workspaces
omarchy bar set io.github.gillmania.display-profiles workspaces false --json
```

### Keyboard

| Key | Action |
|---|---|
| `←` `→` `↑` `↓` | Select the previous or next display |
| `1`–`9`, `0` | Move workspace 1–10 to the selected display |
| `r` | Rotate the selected display |
| `e` | Turn the selected display on or off |
| `a` or `Enter` | Apply |
| `s` | Save |
| `k` or `Enter` | Keep the layout, while the panel is asking |
| `u` | Go back to the previous layout, while the panel is asking |
| `Tab` | Switch to the neighbouring bar panel |
| `Esc` | Close |

### Command line

The service answers on the `display-profiles` IPC target:

```bash
omarchy-shell display-profiles status          # JSON: displays, dock, matched profile
omarchy-shell display-profiles list            # id<TAB>name per profile
omarchy-shell display-profiles apply           # re-apply the profile for this setup
omarchy-shell display-profiles save "Home"     # save the current arrangement as a new profile
omarchy-shell display-profiles save ""         # save over the profile in use
omarchy-shell display-profiles use p2          # switch to another profile for this setup
omarchy-shell display-profiles next            # cycle through the profiles for this setup
omarchy-shell display-profiles remove p1
omarchy-shell display-profiles autoApply false
omarchy-shell display-profiles keep            # answer "Keep this layout?"
omarchy-shell display-profiles revert
```

`save` stores the arrangement that is on screen right now, so it never needs
confirming.

Bind one in `~/.config/hypr/bindings.lua` if you want a key for it:

```lua
o.bind("SUPER + CTRL + P", "Apply display profile", "omarchy-shell display-profiles apply")
o.bind("SUPER + CTRL + O", "Next display profile", "omarchy-shell display-profiles next")
```

## How it works

The plugin has two halves, both running inside `omarchy-shell`:

- `Service.qml` listens for Hyprland's monitor and config-reload events, reads
  the connected displays with `hyprctl -j monitors all`, and looks up the
  profile for that setup.
- `BarWidget.qml` and `Panel.qml` are the bar button and the editor.

A profile is applied with `hyprctl eval`, as `hl.monitor(...)` and
`hl.workspace_rule(...)` calls, and existing workspaces are moved to their
displays. Displays are switched on before any is switched off. These are
runtime settings: they are not written to any file and are gone after
`hyprctl reload` or a restart, at which point the service applies the profile
again.

Handing the screens back (no profile for the new setup, the active profile
deleted, a trial not kept with nothing applied before it, or the plugin being
disabled) is done with `hyprctl reload`, which restores exactly what your
configuration says.

Two things follow from working at runtime, and are worth knowing:

- A profile's workspace rules update the rules from your own configuration in
  place for as long as the profile is applied. Your files are not touched.
- A reload also drops anything else that was set at runtime since the last
  one, such as a scale picked with `omarchy hyprland monitor scaling`.

Every value placed in the evaluated Lua is either a connector name matching
`[A-Za-z0-9._-]+` or a number, so neither a strangely named output nor a
hand-edited profile file can inject code.

### Files

| Path | Contents |
|---|---|
| `~/.config/omarchy-display-profiles/profiles.json` | Your saved profiles. Plain JSON, safe to back up or sync. |

That is the only file the plugin writes. It is replaced atomically, and never
overwritten if it could not be read: a file that is damaged, or written by a
newer version of the plugin, is left alone and reported in the panel. From
there you can set it aside (it is renamed to `profiles.json.unreadable-<date>`,
not deleted) and start with an empty list.

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

Disabling or removing the plugin reloads the Hyprland configuration if a
profile was applied, so your own monitor and workspace settings are in force
again straight away. Nothing else is left behind. To delete the saved profiles
as well:

```bash
rm -r ~/.config/omarchy-display-profiles
```

## Limitations

- Dock identity is read from Thunderbolt/USB4 (`/sys/bus/thunderbolt`). With a
  plain USB-C or HDMI connection, a setup is recognised by its displays alone.
  That only matters if two desks have the same serial-less monitors.
- The first named Thunderbolt device counts as the dock. With another
  Thunderbolt device attached as well, a profile saved with it and one saved
  without it are different profiles.
- A display without a serial number is recognised by make, model, and
  connector. If its connector name changes, it counts as a new setup.
- While the screens are asleep Hyprland holds a new layout back until they
  wake, so a profile applied then shows up when they come on.
- If the shell is restarted or the plugin re-enabled at the very moment an
  older instance is handing the screens back, the profile can be dropped by
  that reload. It is applied again right after when automatic applying is on.
- The current resolution and refresh rate of each display are kept; there is no
  mode picker.
- Mirroring is not managed. Use Omarchy's built-in Display panel for that.
- Workspaces above 10 are left alone.
- At login the profile is applied a moment after the bar appears, not before.

## Develop

```bash
node --test        # unit tests for Model.js
scripts/dev-install      # copy the tree into ~/.config/omarchy/plugins and reload
omarchy plugin validate .
qs log -p "$OMARCHY_PATH/shell" --tail 100   # QML errors
```

All decisions (identity, matching, snapping, the generated Lua) live in
`Model.js`, which has no dependency on QML and is covered by the tests.

The shell hot-reloads the bar widget and panel when their files change. The
running service is kept across a reload, so after editing `Service.qml` or
`Model.js` run `omarchy restart shell` to load the new code.

## Compatibility

Tested with Omarchy 4.0.4 and Hyprland 0.56.2.

The plugin builds on the Omarchy shell's plugin API and on Hyprland's Lua
configuration (`hyprctl eval`, `hl.monitor`, `hl.workspace_rule`). A larger
update of either can break it. If it does, your own Hyprland configuration
keeps working as before; please open an issue with your Omarchy and Hyprland
versions and the output of `omarchy-shell display-profiles status`.

## Contributing

Issues and pull requests are welcome. Before sending a pull request:

- run `node --test` and `omarchy plugin validate .`
- keep decisions in `Model.js` and add a test for anything you change there
- say which Omarchy and Hyprland versions you tried it on

## License

MIT. See [LICENSE](LICENSE). The scale-rounding rule follows Omarchy's
`omarchy-hyprland-monitor-scaling`.
