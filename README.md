# Display Setups

An [Omarchy](https://omarchy.org/) shell plugin for your displays: one click
to mirror or extend when you plug in a projector, drag and drop to arrange
several monitors, and the same setup back on its own the next time you plug in
at the same place.

It works with a single HDMI cable and with a dock. Every set of displays you
use (at home, at work, at your parents' place, a meeting room projector, or the
laptop on its own) can have its own saved setups, and a Thunderbolt dock is
recognised, so two desks with identical monitors are told apart.

## Features

- **Drag-and-drop arrangement.** A map of your displays in the bar panel.
  Dropped displays snap edge to edge, so the layout never has gaps or overlaps.
- **Mirror, extend, external only, laptop only.** One click for the moment
  you plug in a projector, with or without a dock.
- **Resolution, refresh rate, mirroring, and adaptive sync** per display, and
  **Identify** to see which screen is which.
- **Switch from the bar.** Middle click or scroll on the icon steps through
  the setups saved for what is connected.
- **Dedicated workspaces, if you want them.** Switch it on for a profile to
  assign workspaces 1–10 to displays, so each screen keeps its own. Left off,
  the profile only arranges the displays and your own workspace rules stay in
  force.
- **See it in the bar.** Optionally lists the workspaces grouped by display, in
  place of the built-in workspace switcher.
- **Applied automatically.** A setup is recognised by
  the displays connected to it (make, model, and serial number), not by
  connector names such as `DP-7`, which change every time a dock is replugged.
- **Dock aware.** With a Thunderbolt or USB4 dock, a profile belongs to that
  dock. Two desks with identical monitors get a profile each, and saving at
  one dock never replaces the profile of another.
- **Several profiles per setup.** Keep, say, "All screens" and "Laptop only"
  for the same desk and switch between them from the panel or a key. The one
  you used last is the one that comes back. Useful when monitors are switched
  off at their power button, which a dock usually does not report.
- **Hard to lock yourself out.** A layout you have just edited that changes a
  display's resolution, refresh rate, scale, rotation, mirroring, adaptive
  sync, or on/off state has to be confirmed within 15 seconds, or the
  previous layout comes back. Moving displays
  around needs no confirmation, and neither does a saved profile: it was
  confirmed when it was made, so it is applied as it is.
- **Scale, rotation, and on/off** per display. Only scales the display's mode
  can actually run at are offered.
- **Leaves your configuration alone.** Nothing under `~/.config/hypr` is ever
  written. See [How it works](#how-it-works).

## Install

```bash
omarchy plugin add https://github.com/gillmania/omarchy-display-setups.git --enable
```

Without `--enable` you are asked whether to switch it on; say no to read the
code first, and enable it later with:

```bash
omarchy plugin enable io.github.gillmania.display-setups --section right
```

Requires Omarchy 4 (Quattro) with Hyprland's Lua configuration. There are no
other dependencies: the plugin calls `hyprctl`, `systemd-run`/`systemctl --user`
(for the safety timer while a layout is on trial), and `bash` with the usual
coreutils (`cat`, `mkdir`, `mktemp`, `mv`, `rm`, `date`) to read and write its
own profiles file. Omarchy ships all of them. Nothing runs as root and
nothing is downloaded.

## Use

Click the display icon in the bar.

### Just plugged in a projector or a second screen?

The top row of the panel has the four choices you want in that moment:

- **Mirror**: the other screens show what the laptop shows.
- **Extend**: every screen has its own desktop.
- **External only**: the laptop's own screen goes off.
- **Laptop only**: the other screens go off.

One click tries it, and **Keep** makes it stay (a choice that only moves
screens around, with nothing switched on, off or mirrored, goes in without
asking). When displays are connected
that nothing is saved for, the panel opens by itself so the choices are right
there (switch that off with `omarchy bar set
io.github.gillmania.display-setups openOnNewDisplay false --json`). Save the
result as a profile if you want it back the next time the same screen is
plugged in. No dock is needed for any of this; one HDMI cable is enough.

### Arranging

The panel has a short view, with the quick choices and your saved setups, and
**Arrange displays…** opens the map and the settings of each display. It
stays in the view you left it in, and starts in the arrange view when there is
a single display and nothing saved yet.

1. Drag the displays in the map to match your desk.
2. Select a display (click it in the map or in the list) and pick its
   resolution, refresh rate, scale, rotation, what it shows (its own desktop
   or a mirror of another display), and its workspaces. **Identify** puts a
   number on every screen, the same number its tile has in the map.
3. **Apply** tries the arrangement without saving it. **Save as profile…**
   stores it for the displays that are connected right now.
4. If the layout changed a display's resolution, refresh rate, scale,
   rotation, mirroring, adaptive sync, or on/off state, the panel reopens and
   asks
   **Keep this layout?** Answer within 15 seconds or you are taken back: to
   the layout that was applied before, or to your own Hyprland configuration
   if none was. A profile being saved is only written once you keep it.
   Moving displays, or changing which workspaces go where, needs no
   confirmation. The
   countdown starts when the layout has gone in, and a layout cannot be tried
   while every screen is asleep. A layout the displays did not actually take
   is taken back at once. And if the shell itself dies while a layout is on
   trial, a timer outside it reloads your Hyprland configuration 30 seconds
   after the trial began, so you are not left with a screen you cannot use.

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
omarchy bar set io.github.gillmania.display-setups workspaces true --json
omarchy bar move io.github.gillmania.display-setups --after omarchy.workspaces
omarchy plugin disable omarchy.workspaces
```

To go back:

```bash
omarchy plugin enable omarchy.workspaces
omarchy bar set io.github.gillmania.display-setups workspaces false --json
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

The service answers on the `display-setups` IPC target:

```bash
omarchy-shell display-setups status          # JSON: displays, dock, matched profile
omarchy-shell display-setups list            # id<TAB>name per profile
omarchy-shell display-setups apply           # re-apply the profile for this setup
omarchy-shell display-setups save "Home"     # save the current arrangement as a new profile
omarchy-shell display-setups save ""         # save over the profile in use
omarchy-shell display-setups use p2          # switch to another profile for this setup
omarchy-shell display-setups next            # cycle through the profiles for this setup
omarchy-shell display-setups previous
omarchy-shell display-setups remove p1
omarchy-shell display-setups autoApply false
omarchy-shell display-setups quick mirror    # or extend, external, laptop
omarchy-shell display-setups choose          # open the panel with the quick choices
omarchy-shell display-setups identify        # show each screen its number
omarchy-shell display-setups keep            # answer "Keep this layout?"
omarchy-shell display-setups revert
```

`save` stores the arrangement that is on screen right now, so it normally
needs no confirming.

Bind one in `~/.config/hypr/bindings.lua` if you want a key for it:

```lua
o.bind("SUPER + CTRL + P", "Apply display profile", "omarchy-shell display-setups apply")
o.bind("SUPER + CTRL + O", "Next display profile", "omarchy-shell display-setups next")
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
configuration says. If the deleted profile was one of several for the setup
and automatic applying is on, another of them takes over instead.

A profile without dedicated workspaces leaves your own workspace rules in
force. When it follows a layout that had dedicated workspaces, the plugin
reloads the Hyprland configuration first and then arranges the displays,
because that is the only way to get your own rules back.

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
| `~/.config/omarchy-display-setups/profiles.json` | Your saved profiles. Plain JSON, safe to back up or sync. |

The folder follows `$XDG_CONFIG_HOME` if you have set it. Nothing is written
outside it. Beside the profiles file it can hold a `.profiles.*` temporary
file for the moment a save takes, and `profiles.json.unreadable-*` copies you
set aside yourself. The profiles file is replaced atomically, and never
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
omarchy plugin remove io.github.gillmania.display-setups
```

Disabling or removing the plugin reloads the Hyprland configuration if a
profile was applied, so your own monitor and workspace settings are in force
again straight away, and a safety timer still armed for a layout on trial is
cancelled. Windows stay on the workspaces they were on; they are not moved
back to where they were before a profile was applied.

If you let the widget stand in for the built-in workspace switcher, bring that
one back as described under "Workspaces in the bar".

What is left is the folder with your saved profiles. To delete it as well:

```bash
rm -r "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-display-setups"
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
- Omarchy's own Display panel has mirror and laptop-screen switches that write
  to its toggle files. A profile applied here says outright what is mirrored
  and what is on, so it wins while it is applied; use one or the other.
- Workspaces above 10 are left alone.
- At login the profile is applied a moment after the bar appears, not before.

## Develop

```bash
node --test        # unit tests for Model.js
scripts/dev-install      # copy the tree into ~/.config/omarchy/plugins and reload
omarchy plugin validate .
qs log -p "$OMARCHY_PATH/shell" --tail 100   # QML errors
```

`scripts/dev-install` uses `jq`, `cp`, `dirname` and the `omarchy` commands; the
CI workflow uses `node`, `jq`, `xargs` and `find`.

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
versions and the output of `omarchy-shell display-setups status`.

## Contributing

Issues and pull requests are welcome. Before sending a pull request:

- run `node --test` and `omarchy plugin validate .`
- keep decisions in `Model.js` and add a test for anything you change there
- say which Omarchy and Hyprland versions you tried it on

## License

MIT. See [LICENSE](LICENSE).

The bar widget and panel are built on the integration pattern of Omarchy's own
shell plugins (how a widget hosts its panel and forwards open and close), and
the scale-rounding rule follows Omarchy's `omarchy-hyprland-monitor-scaling`.
Omarchy is MIT licensed; its notice is kept in [NOTICE.md](NOTICE.md).
