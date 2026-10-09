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

  // ---- Live state ----
  property bool ready: false
  property var monitors: []
  property var workspaces: []
  property var workspaceRules: []
  property var dock: null
  property string fingerprint: ""
  property string lastError: ""

  // ---- Saved state ----
  property var store: Model.emptyStore()
  readonly property var profiles: store.profiles
  readonly property bool autoApply: store.autoApply

  readonly property var activeProfile: Model.matchProfile(profiles, fingerprint, dock)
  readonly property bool inSync: Model.matchesLive(activeProfile, monitors, workspaces)

  // Why the next probe was asked for. Only "startup", "hotplug", and "reload"
  // may auto-apply; a refresh for the panel must never move screens around.
  property string probeReason: ""
  property bool probeQueued: false
  property string pendingLua: ""

  function refresh() { probe("refresh") }

  function probe(reason) {
    // A stronger reason wins over a queued plain refresh.
    if (probeReason === "" || probeReason === "refresh" || probeReason === "applied") probeReason = reason
    if (probeProc.running) { probeQueued = true; return }
    probeProc.running = true
  }

  function handleProbe(text) {
    var parts = String(text || "").split("\n@@\n")
    var nextMonitors = Model.parseMonitors(parts[0])
    // hyprctl failing (compositor restarting) must not look like "no monitors".
    if (nextMonitors.length === 0) { probeReason = ""; return }

    var reason = probeReason
    probeReason = ""
    var previous = root.fingerprint

    root.monitors = nextMonitors
    root.workspaces = Model.parseWorkspaces(parts[1])
    root.workspaceRules = Model.parseWorkspaceRules(parts[2])
    root.dock = Model.parseDock(parts[3])
    root.fingerprint = Model.fingerprint(nextMonitors)
    root.ready = true

    var setupChanged = previous !== root.fingerprint
    var mayApply = reason === "startup" || reason === "reload" || (reason === "hotplug" && setupChanged)
    if (mayApply && root.autoApply && root.activeProfile) applyProfile(root.activeProfile.id)
  }

  // ---- Operations (used by the panel and by IPC) ----

  function findProfile(id) {
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i]
    return null
  }

  function applyLayout(profileLike) {
    var built = Model.buildApplyLua(profileLike, root.monitors)
    if (built.lua === "") {
      root.lastError = "Nothing to apply: none of this profile's displays are connected."
      return false
    }
    root.lastError = built.skipped.length > 0
      ? "Not connected: " + built.skipped.join(", ")
      : ""
    if (applyProc.running) { root.pendingLua = built.lua; return true }
    applyProc.command = ["hyprctl", "eval", built.lua]
    applyProc.running = true
    return true
  }

  function applyProfile(id) {
    var profile = findProfile(id)
    return profile ? applyLayout(profile) : false
  }

  // Apply an arrangement without saving it, for trying a layout out.
  function applyDraft(draftMonitors, draftWorkspaces) {
    return applyLayout(Model.makeProfile("draft", "draft", draftMonitors, draftWorkspaces, root.dock))
  }

  // Save an arrangement for the setup that is connected right now. It updates
  // the profile already matched to this setup, or creates one.
  function saveProfile(name, draftMonitors, draftWorkspaces) {
    var existing = root.activeProfile
    var id = existing ? existing.id : Model.newId(profiles)
    var finalName = String(name || "").trim()
      || (existing ? existing.name : Model.suggestName(draftMonitors, root.dock, profiles))
    var profile = Model.makeProfile(id, finalName, draftMonitors, draftWorkspaces, root.dock)
    writeStore(Model.upsertProfile(root.store, profile))
    applyLayout(profile)
    return id
  }

  function saveCurrent(name) {
    return saveProfile(name, root.monitors, Model.workspacesFromLive(root.monitors, root.workspaces, root.workspaceRules))
  }

  function renameProfile(id, name) {
    var profile = findProfile(id)
    var finalName = String(name || "").trim()
    if (!profile || finalName === "") return false
    var copy = JSON.parse(JSON.stringify(profile))
    copy.name = finalName
    writeStore(Model.upsertProfile(root.store, copy))
    return true
  }

  function deleteProfile(id) {
    if (!findProfile(id)) return false
    writeStore(Model.removeProfile(root.store, id))
    return true
  }

  function setAutoApply(enabled) {
    var next = JSON.parse(JSON.stringify(root.store))
    next.autoApply = enabled === true
    writeStore(next)
  }

  function writeStore(next) {
    root.store = next
    writeProc.pending = JSON.stringify(next, null, 2) + "\n"
    if (!writeProc.running) writeProc.flush()
  }

  function statusJson() {
    return JSON.stringify({
      ready: root.ready,
      fingerprint: root.fingerprint,
      dock: root.dock,
      profile: root.activeProfile ? { id: root.activeProfile.id, name: root.activeProfile.name } : null,
      inSync: root.inSync,
      autoApply: root.autoApply,
      lastError: root.lastError,
      workspaceRules: root.workspaceRules,
      workspaces: Model.workspacesFromLive(root.monitors, root.workspaces, root.workspaceRules),
      monitors: root.monitors.map(function(m) {
        return { name: m.name, key: m.key, description: m.description, enabled: m.enabled,
                 width: m.width, height: m.height, x: m.x, y: m.y, scale: m.scale, transform: m.transform }
      }),
      profiles: root.profiles.map(function(p) { return { id: p.id, name: p.name, fingerprint: p.fingerprint } })
    })
  }

  // ---- Plumbing ----

  Component.onCompleted: readProc.running = true

  // Rules added through eval outlive this object; switch them off when the
  // plugin is disabled or removed so nothing of it lingers in Hyprland.
  Component.onDestruction: Quickshell.execDetached(["hyprctl", "eval", Model.buildReleaseLua()])

  Process {
    id: readProc
    command: ["bash", "-c", '[[ -r "$1" ]] && cat "$1" || true', "_", root.storePath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.store = Model.parseStore(text)
        root.probe("startup")
      }
    }
  }

  Process {
    id: writeProc
    property string pending: ""
    function flush() {
      if (pending === "") return
      var data = pending
      pending = ""
      // Written beside the target and renamed into place, so a crash mid-write
      // cannot leave a truncated profiles file.
      command = ["bash", "-c", 'mkdir -p "$1" && printf %s "$3" > "$2.tmp" && mv -f "$2.tmp" "$2"',
                 "_", root.configDir, root.storePath, data]
      running = true
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.lastError = "Could not write " + root.storePath
      flush()
    }
  }

  Process {
    id: probeProc
    command: ["bash", "-c",
      "hyprctl -j monitors all; printf '\\n@@\\n'; hyprctl -j workspaces; printf '\\n@@\\n'; hyprctl -j workspacerules; printf '\\n@@\\n'; "
      + "for d in /sys/bus/thunderbolt/devices/*; do [[ -r $d/unique_id ]] || continue; "
      + "printf '%s\\t%s\\t%s\\n' \"$(cat \"$d/unique_id\")\" \"$(cat \"$d/vendor_name\" 2>/dev/null)\" \"$(cat \"$d/device_name\" 2>/dev/null)\"; done"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleProbe(text)
    }
    onExited: {
      if (root.probeQueued) {
        root.probeQueued = false
        Qt.callLater(function() { probeProc.running = true })
      }
    }
  }

  Process {
    id: applyProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var message = String(text || "").trim()
        if (message !== "") root.lastError = message
      }
    }
    onExited: function(exitCode) {
      if (root.pendingLua !== "") {
        var lua = root.pendingLua
        root.pendingLua = ""
        command = ["hyprctl", "eval", lua]
        Qt.callLater(function() { applyProc.running = true })
        return
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
      return root.applyProfile(root.activeProfile.id) ? "applied " + root.activeProfile.name : "failed"
    }
    function applyId(id: string): string {
      return root.applyProfile(id) ? "applied" : "unknown profile"
    }
    function save(name: string): string { return root.saveCurrent(name) }
    function remove(id: string): string { return root.deleteProfile(id) ? "removed" : "unknown profile" }
    function autoApply(enabled: string): void { root.setAutoApply(enabled === "true") }
  }
}
