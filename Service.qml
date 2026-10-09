import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "Model.js" as Model

// Headless half of Display Profiles. It watches which monitors (and which
// dock) are connected, finds the saved profile for that setup, and applies it.
//
// Everything is applied at runtime through `hyprctl eval`; nothing under
// ~/.config/hypr is ever written. Profiles live in their own file so removing
// the plugin leaves the Hyprland configuration exactly as it was.
Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null
  property var manifest: null

  readonly property string configDir:
    (Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")) + "/omarchy-display-profiles"
  readonly property string storePath: configDir + "/profiles.json"

  // Names this instance in Hyprland's Lua state, so that an older instance
  // that is torn down late cannot release rules a newer one has applied.
  readonly property string owner: "i" + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36)

  // ---- Live state ----
  // The fields below are replaced together by handleProbe(). `generation` is
  // bumped last, so listen to that rather than to a single field: at that
  // point every field belongs to the same reading.
  property bool ready: false
  property int generation: 0
  property var monitors: []
  property var workspaces: []
  property var workspaceRules: []
  property var dock: null
  property string fingerprint: ""
  property string topology: ""
  property string lastError: ""

  // ---- Saved state ----
  // "loading" | "missing" | "ok" | "corrupt" | "unsupported". The file is only
  // ever written in "missing" and "ok"; see Model.loadStore.
  property string storeState: "loading"
  property string storeError: ""
  readonly property bool storeWritable: storeState === "ok" || storeState === "missing"
  property var store: Model.emptyStore()
  readonly property var profiles: store.profiles
  readonly property bool autoApply: store.autoApply

  readonly property var activeProfile: Model.matchProfile(profiles, fingerprint, dock)
  // Connector name per workspace id, for the bar's workspace strip.
  readonly property var workspaceOwners: Model.workspaceOwnerNames(monitors, workspaces, workspaceRules)
  readonly property bool inSync: Model.matchesLive(activeProfile, monitors, workspaceOwners)

  // ---- Applying ----
  // "idle" | "running" | "ok" | "failed"
  property string applyState: "idle"
  // A layout asked for while another was being applied. It is turned into Lua
  // only after the next probe, against the monitors that are there by then.
  property var pendingApply: null
  property string applyNote: ""

  // ---- Confirmation ----
  // A layout that changes a monitor's own settings can leave a screen dark, so
  // it is kept only if the user says so in time. Until then `rollbackLayout`
  // holds what was there before.
  readonly property int confirmTimeout: 15
  property bool confirmPending: false
  property int confirmSeconds: 0
  property var rollbackLayout: null
  property var pendingSave: null
  property string confirmTopology: ""
  signal confirmationEnded(bool kept)

  function refresh() { probe("refresh") }

  // ---- Probing ----

  readonly property var reasonRank: ({ "": 0, refresh: 1, applied: 2, hotplug: 3, reload: 4, startup: 5 })
  property string runningReason: ""
  property string queuedReason: ""

  // Only "startup", "reload", and "hotplug" may change the layout; a refresh
  // for the panel must never move screens around. Each run keeps the reason it
  // was started for, and a request made meanwhile waits for a run of its own.
  function probe(reason) {
    if (probeProc.busy) {
      if (reasonRank[reason] > reasonRank[queuedReason]) queuedReason = reason
      return
    }
    runningReason = reason
    probeProc.start(["bash", "-c",
      "hyprctl -j monitors all; printf '\\n@@\\n'; hyprctl -j workspaces; printf '\\n@@\\n'; hyprctl -j workspacerules; printf '\\n@@\\n'; "
      + "for d in /sys/bus/thunderbolt/devices/*; do [[ -r $d/unique_id ]] || continue; "
      + "printf '%s\\t%s\\t%s\\n' \"$(cat \"$d/unique_id\")\" \"$(cat \"$d/vendor_name\" 2>/dev/null)\" \"$(cat \"$d/device_name\" 2>/dev/null)\"; done"])
  }

  function handleProbe(text, reason) {
    var parts = String(text || "").split("\n@@\n")
    var nextMonitors = Model.parseMonitors(parts[0])
    // hyprctl failing (compositor restarting) must not look like "no monitors".
    if (nextMonitors.length === 0) return

    var nextDock = Model.parseDock(parts[3])
    var nextTopology = Model.topology(nextMonitors, nextDock)
    var changed = root.topology !== nextTopology

    root.monitors = nextMonitors
    root.workspaces = Model.parseWorkspaces(parts[1])
    root.workspaceRules = Model.parseWorkspaceRules(parts[2])
    root.dock = nextDock
    root.fingerprint = Model.fingerprint(nextMonitors)
    root.topology = nextTopology
    root.ready = true
    root.generation += 1

    // A pending confirmation was about screens that are no longer the ones
    // connected, or about settings a config reload has just thrown away.
    if (root.confirmPending && (reason === "reload" || root.topology !== root.confirmTopology))
      endConfirmation(false, "The displays changed, so the new layout was not kept.")

    if (root.pendingApply) {
      var waiting = root.pendingApply
      root.pendingApply = null
      startApply(waiting)
      return
    }

    // A replugged dock renumbers its connectors, so a changed topology needs
    // the rules again even when the monitors themselves are the same.
    var mayApply = reason === "startup" || reason === "reload" || (reason === "hotplug" && changed)
    if (!mayApply) return
    if (root.activeProfile) {
      if (root.autoApply) startApply(root.activeProfile)
    } else if (reason !== "reload") {
      // No profile for this setup. If an earlier setup (or an earlier instance
      // that did not get to clean up) left a layout in Hyprland, hand the
      // screens back to the user's own configuration.
      Quickshell.execDetached(["hyprctl", "eval", Model.buildReleaseLua("")])
    }
  }

  // ---- Applying ----

  function startApply(profileLike) {
    if (applyProc.busy) {
      root.pendingApply = profileLike
      return true
    }
    var built = Model.buildApplyLua(profileLike, root.monitors, root.owner)
    if (built.lua === "") {
      root.applyState = "failed"
      root.lastError = "Nothing to apply: none of this profile's displays are connected."
      return false
    }
    root.applyNote = built.skipped.length > 0 ? "Not connected: " + built.skipped.join(", ") : ""
    root.applyState = "running"
    // stderr is folded into stdout so one stream carries the whole answer.
    applyProc.start(["bash", "-c", 'hyprctl eval "$1" 2>&1', "_", built.lua])
    return true
  }

  function applyProfile(id) {
    var profile = findProfile(id)
    if (!profile) return false
    if (root.confirmPending) {
      root.lastError = "Keep or revert the current layout first."
      return false
    }
    return startApply(profile)
  }

  // Apply a layout the user has just edited. If it changes any monitor's own
  // settings it has to be confirmed, and `toSave` (a profile, or null) is only
  // written once it is.
  function applyGuarded(layout, toSave) {
    if (root.confirmPending) {
      root.lastError = "Keep or revert the current layout first."
      return false
    }
    if (!Model.changesMonitors(layout.monitors, root.monitors)) {
      if (toSave && !writeStore(Model.upsertProfile(root.store, toSave))) return false
      return startApply(layout)
    }
    var before = Model.makeProfile("rollback", "rollback", root.monitors,
      Model.workspacesFromLive(root.monitors, root.workspaces, root.workspaceRules), root.dock)
    if (!startApply(layout)) return false
    root.rollbackLayout = before
    root.pendingSave = toSave
    root.confirmTopology = root.topology
    root.confirmSeconds = root.confirmTimeout
    root.confirmPending = true
    confirmTimer.restart()
    return true
  }

  function endConfirmation(kept, message) {
    confirmTimer.stop()
    root.confirmPending = false
    root.rollbackLayout = null
    root.pendingSave = null
    if (message) root.lastError = message
    root.confirmationEnded(kept)
  }

  function keepChanges() {
    if (!root.confirmPending) return false
    var toSave = root.pendingSave
    endConfirmation(true, "")
    if (toSave) writeStore(Model.upsertProfile(root.store, toSave))
    return true
  }

  function revertChanges() {
    if (!root.confirmPending) return false
    var before = root.rollbackLayout
    endConfirmation(false, "")
    if (before) startApply(before)
    return true
  }

  function sameTopology(expected) {
    if (!expected || expected === root.topology) return true
    root.lastError = "The displays changed while you were editing. Check the arrangement and try again."
    return false
  }

  // Try an arrangement without saving it. `expectedTopology` is the topology
  // the draft was made for; a draft for other screens is refused.
  function applyDraft(draftMonitors, draftWorkspaces, expectedTopology) {
    if (!root.ready || !sameTopology(expectedTopology)) return false
    return applyGuarded(Model.makeProfile("draft", "draft", draftMonitors, draftWorkspaces, root.dock), null)
  }

  // Save an arrangement for the setup that is connected right now. It updates
  // the profile saved for exactly this setup, or creates one. Returns the
  // profile id, or "" when nothing was saved or queued.
  function saveProfile(name, draftMonitors, draftWorkspaces, expectedTopology) {
    if (!root.ready || !canWrite() || !sameTopology(expectedTopology)) return ""
    var existing = root.activeProfile
    var id = existing ? existing.id : Model.newId(profiles)
    var finalName = Model.cleanName(name)
      || (existing ? existing.name : Model.suggestName(draftMonitors, root.dock, profiles))
    var profile = Model.makeProfile(id, finalName, draftMonitors, draftWorkspaces, root.dock)
    return applyGuarded(profile, profile) ? id : ""
  }

  function saveCurrent(name) {
    return saveProfile(name, root.monitors,
      Model.workspacesFromLive(root.monitors, root.workspaces, root.workspaceRules), root.topology)
  }

  // ---- Profiles ----

  function findProfile(id) {
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i]
    return null
  }

  function renameProfile(id, name) {
    var profile = findProfile(id)
    var finalName = Model.cleanName(name)
    if (!profile || finalName === "") return false
    var copy = JSON.parse(JSON.stringify(profile))
    copy.name = finalName
    return writeStore(Model.upsertProfile(root.store, copy))
  }

  function deleteProfile(id) {
    if (!findProfile(id)) return false
    return writeStore(Model.removeProfile(root.store, id))
  }

  function setAutoApply(enabled) {
    var next = JSON.parse(JSON.stringify(root.store))
    next.autoApply = enabled === true
    return writeStore(next)
  }

  function canWrite() {
    if (root.storeWritable) return true
    root.lastError = root.storeState === "loading"
      ? "Still reading the saved profiles."
      : root.storeError + " It was left untouched, and nothing can be saved until it is fixed or set aside."
    return false
  }

  function writeStore(next) {
    if (!canWrite()) return false
    root.store = next
    root.storeState = "ok"
    writeProc.pending = JSON.stringify(next, null, 2) + "\n"
    writeProc.flush()
    return true
  }

  // Start over with no profiles after the file could not be understood. The
  // old file is renamed, never deleted.
  function resetStore() {
    if (root.storeState !== "corrupt" && root.storeState !== "unsupported") return false
    return asideProc.start(["bash", "-c",
      '[[ ! -e "$1" ]] || mv -n "$1" "$1.unreadable-$(date +%Y%m%d-%H%M%S)"', "_", root.storePath])
  }

  function statusJson() {
    return JSON.stringify({
      ready: root.ready,
      generation: root.generation,
      fingerprint: root.fingerprint,
      dock: root.dock,
      profile: root.activeProfile ? { id: root.activeProfile.id, name: root.activeProfile.name } : null,
      inSync: root.inSync,
      autoApply: root.autoApply,
      applyState: root.applyState,
      confirmPending: root.confirmPending,
      confirmSeconds: root.confirmSeconds,
      storeState: root.storeState,
      storeError: root.storeError,
      lastError: root.lastError,
      workspaceOwners: root.workspaceOwners,
      monitors: root.monitors.map(function(m) {
        return { name: m.name, key: m.key, description: m.description, enabled: m.enabled,
                 width: m.width, height: m.height, x: m.x, y: m.y, scale: m.scale, transform: m.transform }
      }),
      profiles: root.profiles.map(function(p) {
        return { id: p.id, name: p.name, fingerprint: p.fingerprint, dock: p.dock }
      })
    })
  }

  // ---- Plumbing ----

  // A process whose exit code and output are reported together, once both are
  // in. `exited` and the end of the output stream arrive in no fixed order.
  component Runner: Process {
    id: runner
    property bool busy: false
    property var collected: null
    property int code: -1
    property bool ended: false
    signal done(int exitCode, string output)

    function start(argv) {
      if (busy) return false
      busy = true
      collected = null
      ended = false
      command = argv
      running = true
      return true
    }

    function finish() {
      if (collected === null || !ended) return
      var output = collected
      busy = false
      done(code, output)
    }

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        runner.collected = String(text || "")
        runner.finish()
      }
    }
    onExited: function(exitCode) {
      code = exitCode
      ended = true
      finish()
    }
  }

  Component.onCompleted: readProc.start(["bash", "-c",
    'if [[ ! -e "$1" ]]; then echo MISSING; elif [[ -r "$1" ]]; then echo FOUND; cat "$1"; else echo UNREADABLE; fi',
    "_", root.storePath])

  // What was set through eval outlives this object. When the plugin is
  // disabled or removed, the user's own configuration takes over again.
  Component.onDestruction: Quickshell.execDetached(["hyprctl", "eval", Model.buildReleaseLua(root.owner)])

  Runner {
    id: readProc
    onDone: function(exitCode, output) {
      var newline = output.indexOf("\n")
      var marker = newline < 0 ? output.trim() : output.slice(0, newline)
      if (marker !== "MISSING" && marker !== "FOUND") {
        root.storeError = "The profiles file could not be read."
        root.storeState = "corrupt"
      } else {
        var loaded = Model.loadStore(newline < 0 ? "" : output.slice(newline + 1), marker === "FOUND")
        root.store = loaded.store
        root.storeError = loaded.error
        root.storeState = loaded.status
      }
      if (root.storeError !== "") root.lastError = root.storeError
      root.probe("startup")
    }
  }

  Runner {
    id: writeProc
    property string pending: ""
    function flush() {
      if (pending === "" || busy) return
      var data = pending
      pending = ""
      // Written to a fresh, uniquely named file beside the target and renamed
      // into place, so a crash mid-write cannot leave a truncated profiles
      // file and a planted link cannot redirect the write.
      start(["bash", "-c",
        'umask 077; mkdir -p "$1" || exit 1; tmp=$(mktemp "$1/.profiles.XXXXXXXX") || exit 1; '
        + 'if printf %s "$3" > "$tmp" && mv -f "$tmp" "$2"; then exit 0; fi; rm -f "$tmp"; exit 1',
        "_", root.configDir, root.storePath, data])
    }
    onDone: function(exitCode, output) {
      if (exitCode !== 0)
        root.lastError = "Could not write " + root.storePath
          + ". The change is not saved and will be lost when the shell restarts."
      flush()
    }
  }

  Runner {
    id: asideProc
    onDone: function(exitCode, output) {
      if (exitCode !== 0) {
        root.lastError = "Could not set the old profiles file aside."
        return
      }
      root.store = Model.emptyStore()
      root.storeError = ""
      root.storeState = "missing"
      root.lastError = ""
    }
  }

  Runner {
    id: probeProc
    onDone: function(exitCode, output) {
      var reason = root.runningReason
      root.runningReason = ""
      root.handleProbe(output, reason)
      if (root.queuedReason !== "") {
        var next = root.queuedReason
        root.queuedReason = ""
        root.probe(next)
      }
    }
  }

  Runner {
    id: applyProc
    onDone: function(exitCode, output) {
      var answer = output.trim()
      if (exitCode !== 0 || (answer !== "" && answer !== "ok")) {
        root.applyState = "failed"
        var wasConfirming = root.confirmPending
        // A layout that did not go in cleanly is not one to keep.
        if (wasConfirming) root.revertChanges()
        root.lastError = (answer !== "" ? answer : "hyprctl eval failed (exit " + exitCode + ").")
          + (wasConfirming ? " The previous layout is being restored." : "")
      } else {
        root.applyState = "ok"
        root.lastError = root.applyNote
      }
      settle.restart()
    }
  }

  // Hyprland needs a moment after a modeset before `monitors` reports the new
  // geometry.
  Timer {
    id: settle
    interval: 400
    onTriggered: root.probe("applied")
  }

  Timer {
    id: confirmTimer
    interval: 1000
    repeat: true
    onTriggered: {
      root.confirmSeconds -= 1
      if (root.confirmSeconds <= 0) root.revertChanges()
    }
  }

  // A dock announces its monitors one by one; wait until the burst is over so
  // the profile is matched against the complete setup.
  Timer {
    id: hotplugDebounce
    interval: 1200
    onTriggered: root.probe("hotplug")
  }

  Timer {
    id: reloadDebounce
    interval: 500
    onTriggered: root.probe("reload")
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event || !event.name) return
      var name = String(event.name)
      if (name.indexOf("monitoradded") === 0 || name.indexOf("monitorremoved") === 0)
        hotplugDebounce.restart()
      // A config reload drops everything set through eval, so put it back.
      else if (name === "configreloaded")
        reloadDebounce.restart()
    }
  }

  IpcHandler {
    target: "display-profiles"

    function status(): string { return root.statusJson() }
    function refresh(): void { root.refresh() }
    function list(): string {
      return root.profiles.map(function(p) { return p.id + "\t" + p.name }).join("\n")
    }
    function apply(): string {
      if (!root.activeProfile) return "no profile for this setup"
      return root.applyProfile(root.activeProfile.id)
        ? "applying " + root.activeProfile.name : "not applied: " + root.lastError
    }
    function applyId(id: string): string {
      if (!root.findProfile(id)) return "unknown profile"
      return root.applyProfile(id) ? "applying" : "not applied: " + root.lastError
    }
    function save(name: string): string {
      var id = root.saveCurrent(name)
      return id !== "" ? id : "not saved: " + root.lastError
    }
    function remove(id: string): string {
      if (!root.findProfile(id)) return "unknown profile"
      return root.deleteProfile(id) ? "removed" : "not removed: " + root.lastError
    }
    function autoApply(enabled: string): void { root.setAutoApply(enabled === "true") }
    function keep(): string { return root.keepChanges() ? "kept" : "nothing to confirm" }
    function revert(): string { return root.revertChanges() ? "reverting" : "nothing to confirm" }
    function resetStore(): string {
      return root.resetStore() ? "setting the old file aside" : "the profiles file is readable"
    }
  }
}
