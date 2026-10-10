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

  // The profile to apply here. It may be a fallback (a profile saved without
  // a dock, or the only candidate while the dock cannot be read).
  // A setup can have several profiles; the one chosen last is used.
  readonly property var activeProfile: Model.matchProfile(profiles, fingerprint, dock, store.selected)
  // Every profile that can be used with what is connected right now.
  readonly property var setupProfiles: Model.setupProfiles(profiles, fingerprint, dock)
  // The profiles that are exactly this setup; the only ones a save may replace.
  readonly property var ownProfiles: Model.exactProfiles(profiles, fingerprint, dock)
  // Set when the last write of the profiles file failed. Kept apart from
  // lastError, which the next apply would otherwise wipe.
  property string storeWriteError: ""
  // Connector name per workspace id, for the bar's workspace strip.
  readonly property var workspaceOwners: Model.workspaceOwnerNames(monitors, workspaces, workspaceRules)
  readonly property bool inSync: Model.matchesLive(activeProfile, monitors, workspaceOwners, workspaces)

  // ---- Applying ----
  // "idle" | "running" | "ok" | "failed"
  property string applyState: "idle"
  // The layout being evaluated right now, as { layout, kind, topology }. Kinds:
  // "profile" (a saved profile, or an edit that needs no confirmation),
  // "trial" (an edit waiting to be confirmed), and "rollback".
  property var applying: null
  // One layout asked for while another was being evaluated. It is turned into
  // Lua only after the next probe, and dropped if the screens changed.
  property var pendingApply: null
  property string applyNote: ""
  // The last layout that was applied and stands: what a rollback returns to.
  // Null while the user's own configuration is in force.
  property var standing: null
  // The topology whose profile was last applied (or released). A hotplug is
  // acted on when the topology differs from this, not from the last reading,
  // so a refresh that happens to see the change first cannot swallow it.
  property string reconciledTopology: ""

  // ---- Confirmation ----
  // A layout that changes a monitor's own settings can leave a screen dark, so
  // it is kept only if the user says so in time. The countdown starts once the
  // layout has actually gone in (`confirmArmed`); until then it can be neither
  // kept nor reverted by hand.
  // Set once a bar has brought the panel back for the confirmation at hand,
  // so that it happens once however many bars there are.
  property bool confirmPrompted: false
  // A config reload done by an apply (see startApply) whose event has not
  // arrived yet. That event is not news and must not be acted on.
  property bool ownReloadPending: false

  readonly property int confirmTimeout: 15
  // The systemd timer that takes a trial back if the shell is gone.
  readonly property string watchdogUnit: "display-profiles-trial-" + owner

  function disarmWatchdog() {
    Quickshell.execDetached(["systemctl", "--user", "stop", root.watchdogUnit + ".timer"])
  }
  property bool confirmPending: false
  property bool confirmArmed: false
  property int confirmSeconds: 0
  property var trialLayout: null
  property var rollbackLayout: null
  property var pendingSave: null
  property string confirmTopology: ""
  signal confirmationEnded(bool kept, bool saved)

  function refresh() { probe("refresh") }

  // ---- Identify ----
  // Shows each screen its number for a few seconds. The badges live in a file
  // of their own, loaded here so that they exist once however many bars do.
  property bool identifying: false

  function identify() {
    root.identifying = true
    identifyTimer.restart()
  }

  Timer {
    id: identifyTimer
    interval: 3000
    onTriggered: root.identifying = false
  }

  Loader {
    active: root.identifying
    source: Qt.resolvedUrl("IdentifyOverlay.qml")
    onLoaded: item.service = root
  }

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
    // A probe that was meant to act is tried again rather than forgotten.
    if (nextMonitors.length === 0) {
      if (reason !== "refresh" && reason !== "applied" && probeRetry.attempts < 5) {
        probeRetry.attempts += 1
        probeRetry.reason = reason
        probeRetry.restart()
      }
      return
    }
    probeRetry.attempts = 0

    var nextDock = Model.parseDock(parts[3])

    root.monitors = nextMonitors
    root.workspaces = Model.parseWorkspaces(parts[1])
    root.workspaceRules = Model.parseWorkspaceRules(parts[2])
    root.dock = nextDock
    root.fingerprint = Model.fingerprint(nextMonitors)
    root.topology = Model.topology(nextMonitors, nextDock)
    root.ready = true

    // Work queued for screens that are no longer the ones connected is moot.
    if (root.pendingApply && root.pendingApply.topology !== root.topology) root.pendingApply = null

    // A pending confirmation was about screens that are no longer the ones
    // connected, or about settings a config reload has just thrown away.
    var interrupted = root.confirmPending && (reason === "reload" || root.topology !== root.confirmTopology)
    if (interrupted) {
      root.pendingApply = null
      endConfirmation(false, false, "The displays changed, so the new layout was not kept.")
    }
    if (reason === "reload") root.standing = null

    // Last, so that listeners see a complete reading and a settled
    // confirmation state.
    root.generation += 1

    var due = reason === "startup" || reason === "reload" || interrupted
      || (reason === "hotplug" && root.topology !== root.reconciledTopology)
    if (due) {
      reconcile(reason)
    } else if (root.pendingApply && !applyProc.busy) {
      var waiting = root.pendingApply
      root.pendingApply = null
      startApply(waiting.layout, waiting.kind)
    }
  }

  // Bring Hyprland in line with the setup that is connected now: its profile,
  // or the user's own configuration when there is none to apply.
  function reconcile(reason) {
    root.reconciledTopology = root.topology
    root.pendingApply = null
    if (root.activeProfile && root.autoApply) {
      startApply(root.activeProfile, "profile")
    } else if (reason === "startup") {
      // Whatever an earlier instance left behind without cleaning up.
      release("")
    } else if (reason !== "reload") {
      release(root.owner)
    }
  }

  // Hand the screens back to the user's Hyprland configuration, if the named
  // instance ("" for any) has a layout in force. See Model.buildReleaseLua.
  function release(instance) {
    root.standing = null
    Quickshell.execDetached(["hyprctl", "eval", Model.buildReleaseLua(instance)])
  }

  // ---- Applying ----

  function startApply(layout, kind) {
    if (applyProc.busy) {
      root.pendingApply = { layout: layout, kind: kind, topology: root.topology }
      return true
    }
    // Starting now supersedes whatever was still waiting its turn.
    root.pendingApply = null
    var built = Model.buildApplyLua(layout, root.monitors, root.owner)
    if (built.lua === "") {
      root.applyState = "failed"
      root.lastError = "Nothing to apply: none of this profile's displays are connected."
      return false
    }
    root.applyNote = built.skipped.length > 0 ? "Not connected: " + built.skipped.join(", ") : ""
    root.applyState = "running"
    root.applying = { layout: layout, kind: kind, topology: root.topology, mayReload: built.plain, reloadSeen: false }
    // Workspace rules set by an earlier layout replaced the user's own in
    // place, and only a config reload brings those back. A layout without
    // dedicated workspaces therefore asks Hyprland whether such rules are
    // there and reloads first if so, all in this one command, so that
    // nothing else can come in between. stderr is folded into stdout so one
    // stream carries the whole answer.
    //
    // A trial is first given a watchdog outside the shell: a systemd timer
    // that reloads the Hyprland config, which is the user's own layout. If
    // the shell dies before the trial is kept or taken back, the screens
    // still come back. Without the watchdog the trial does not go in.
    applyProc.start(["bash", "-c",
      'if [ -n "$5" ]; then systemctl --user stop "$5.timer" >/dev/null 2>&1; '
      + 'systemd-run --user --quiet --collect --unit="$5" --on-active="$6s" --timer-property=AccuracySec=200ms '
      + '--setenv=HYPRLAND_INSTANCE_SIGNATURE="$HYPRLAND_INSTANCE_SIGNATURE" --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" '
      + 'hyprctl reload >/dev/null 2>&1 || { echo "Could not arm the safety timer, so the layout was not tried."; exit 97; }; fi; '
      + 'if [ "$2" = plain ]; then case "$(hyprctl eval "$3" 2>&1)" in *"$4"*) '
      + 'hyprctl reload >/dev/null 2>&1; printf "%s\n" "@@RELOADED";; esac; fi; hyprctl eval "$1" 2>&1',
      "_", built.lua, built.plain ? "plain" : "rules", Model.RULES_CHECK, Model.RULES_MARK,
      kind === "trial" ? root.watchdogUnit : "", String(root.confirmTimeout + 15)])
    return true
  }

  function applyProfile(id) {
    var profile = findProfile(id)
    if (!profile) return false
    if (root.confirmPending) {
      root.lastError = "Keep or go back from the current layout first."
      return false
    }
    return startApply(profile, "profile")
  }

  // Apply a layout the user has just edited. If it changes any monitor's own
  // settings it has to be confirmed, and `toSave` (a profile, or null) is only
  // written once it is.
  function applyGuarded(layout, toSave) {
    if (root.confirmPending) {
      root.lastError = "Keep or go back from the current layout first."
      return false
    }
    // A trial is never queued: what is confirmed must be what is on screen.
    if (applyProc.busy || root.pendingApply) {
      root.lastError = "Still applying the previous layout. Try again in a moment."
      return false
    }
    if (!Model.changesMonitors(layout.monitors, root.monitors)) {
      if (toSave && !writeStore(storeWith(toSave))) return false
      return startApply(layout, "profile")
    }
    if (!Model.anyAwake(root.monitors)) {
      root.lastError = "The screens are asleep, so the new layout could not be shown for you to confirm. Wake them and try again."
      return false
    }
    if (!startApply(layout, "trial")) return false
    root.trialLayout = layout
    root.rollbackLayout = root.standing && root.standing.topology === root.topology ? root.standing.layout : null
    root.pendingSave = toSave
    root.confirmTopology = root.topology
    root.confirmSeconds = root.confirmTimeout
    root.confirmArmed = false
    root.confirmPrompted = false
    root.confirmPending = true
    return true
  }

  function endConfirmation(kept, saved, message) {
    confirmTimer.stop()
    disarmWatchdog()
    root.confirmPending = false
    root.confirmArmed = false
    root.confirmPrompted = false
    root.trialLayout = null
    root.rollbackLayout = null
    root.pendingSave = null
    if (message) root.lastError = message
    root.confirmationEnded(kept, saved)
  }

  function keepChanges() {
    if (!root.confirmPending || !root.confirmArmed) return false
    var toSave = root.pendingSave
    root.standing = { layout: root.trialLayout, topology: root.topology }
    // Written before listeners hear about it, so they see the saved profile.
    var saved = toSave ? writeStore(storeWith(toSave)) : false
    endConfirmation(true, saved, "")
    return true
  }

  // Go back to what stood before the trial: the layout applied before it, or,
  // if the user's own configuration was in force, exactly that. `force` is for
  // a trial that failed while going in.
  function revertChanges(force) {
    if (!root.confirmPending || (!root.confirmArmed && force !== true)) return false
    var before = root.rollbackLayout
    endConfirmation(false, false, "")
    root.pendingApply = null
    if (before) startApply(before, "rollback")
    else release(root.owner)
    return true
  }

  function sameTopology(expected) {
    if (!expected || expected === root.topology) return true
    root.lastError = "The displays changed while you were editing. Check the arrangement and try again."
    return false
  }

  // Try an arrangement without saving it. `expectedTopology` is the topology
  // the draft was made for; a draft for other screens is refused.
  function applyDraft(draftMonitors, draftWorkspaces, expectedTopology, dedicated) {
    if (!root.ready || !sameTopology(expectedTopology)) return false
    return applyGuarded(Model.makeProfile("draft", "draft", draftMonitors, draftWorkspaces, root.dock, dedicated), null)
  }

  // A saved profile becomes the chosen one of its setup.
  function storeWith(profile) {
    return Model.selectProfile(Model.upsertProfile(root.store, profile), profile.id)
  }

  // Save an arrangement for the setup that is connected right now. With
  // `targetId` naming a profile of exactly this setup, that profile is
  // updated; otherwise a new one is added beside any that exist. Returns the
  // profile id, or "" when nothing was saved or queued.
  function saveProfile(name, draftMonitors, draftWorkspaces, expectedTopology, targetId, dedicated) {
    if (!root.ready || !canWrite() || !sameTopology(expectedTopology)) return ""
    var existing = null
    for (var i = 0; i < root.ownProfiles.length; i++)
      if (root.ownProfiles[i].id === targetId) existing = root.ownProfiles[i]
    var id = existing ? existing.id : Model.newId(profiles)
    var finalName = Model.cleanName(name)
      || (existing ? existing.name : Model.suggestName(draftMonitors, root.dock, profiles))
    var profile = Model.makeProfile(id, finalName, draftMonitors, draftWorkspaces, root.dock, dedicated)
    return applyGuarded(profile, profile) ? id : ""
  }

  // Saves over the profile in use when no name is given, and as a new profile
  // otherwise.
  function saveCurrent(name) {
    var target = Model.cleanName(name) === "" && root.activeProfile ? root.activeProfile.id : ""
    return saveProfile(name, root.monitors,
      Model.workspacesFromLive(root.monitors, root.workspaces, root.workspaceRules), root.topology, target,
      root.activeProfile ? root.activeProfile.dedicated !== false : true)
  }

  // Change to another profile saved for the setup that is connected, and
  // remember it as the one to use here.
  function switchProfile(id) {
    var found = null
    for (var i = 0; i < root.setupProfiles.length; i++)
      if (root.setupProfiles[i].id === id) found = root.setupProfiles[i]
    if (!found) {
      root.lastError = "That profile was saved for other displays."
      return false
    }
    if (root.confirmPending) {
      root.lastError = "Keep or go back from the current layout first."
      return false
    }
    if (!canWrite() || !writeStore(Model.selectProfile(root.store, id))) return false
    return startApply(found, "profile")
  }

  function nextProfile() {
    var list = root.setupProfiles
    if (list.length < 2) return false
    var index = 0
    for (var i = 0; i < list.length; i++)
      if (root.activeProfile && list[i].id === root.activeProfile.id) index = i
    return switchProfile(list[(index + 1) % list.length].id)
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
    var wasActive = root.activeProfile !== null && root.activeProfile.id === id
    if (!writeStore(Model.removeProfile(root.store, id))) return false
    // Deleting the profile that is in force puts the user's own configuration
    // back, rather than leaving a layout nothing accounts for.
    if (wasActive && !root.confirmPending) release(root.owner)
    return true
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
      '[[ -e "$1" ]] || exit 0; to=$(mktemp "$1.unreadable-$(date +%Y%m%d-%H%M%S)-XXXX") || exit 1; '
      + 'mv -f "$1" "$to" && [[ ! -e "$1" ]]', "_", root.storePath])
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
      confirmArmed: root.confirmArmed,
      dedicated: root.activeProfile ? root.activeProfile.dedicated !== false : null,
      confirmSeconds: root.confirmSeconds,
      storeWriteError: root.storeWriteError,
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
    // A command that never returns must not block everything queued behind
    // it. It is killed and reported as failed.
    property int deadline: 10000
    property Timer watchdog: Timer {
      interval: runner.deadline
      onTriggered: {
        if (!runner.busy) return
        runner.running = false
        runner.code = -1
        runner.ended = true
        if (runner.collected === null) runner.collected = ""
        runner.finish()
      }
    }
    signal done(int exitCode, string output)

    function start(argv) {
      if (busy) return false
      busy = true
      collected = null
      ended = false
      command = argv
      running = true
      watchdog.restart()
      return true
    }

    function finish() {
      if (!busy || collected === null || !ended) return
      var output = collected
      watchdog.stop()
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
    'if [[ ! -e "$1" ]]; then echo MISSING; elif [[ -r "$1" ]]; then echo FOUND; cat "$1" || exit 3; else echo UNREADABLE; fi',
    "_", root.storePath])

  // What was set through eval outlives this object. When the plugin is
  // disabled or removed, the user's own configuration takes over again.
  Component.onDestruction: Quickshell.execDetached(["hyprctl", "eval", Model.buildReleaseLua(root.owner)])

  Runner {
    id: readProc
    onDone: function(exitCode, output) {
      var newline = output.indexOf("\n")
      var marker = newline < 0 ? output.trim() : output.slice(0, newline)
      if (exitCode !== 0 || (marker !== "MISSING" && marker !== "FOUND")) {
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
      root.storeWriteError = exitCode === 0 ? ""
        : "Could not write " + root.storePath + ". The change is not saved and will be lost when the shell restarts."
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
      var done = root.applying
      root.applying = null
      // The command reloaded the config itself; the event for that is either
      // already seen or still on its way. A reload seen while the command ran
      // without doing one was somebody else's, and is acted on as usual.
      var reloaded = output.indexOf("@@RELOADED") !== -1
      var answer = output.replace("@@RELOADED", "").trim()
      if (done !== null) {
        if (reloaded && !done.reloadSeen) {
          root.ownReloadPending = true
          ownReloadWindow.restart()
        } else if (!reloaded && done.reloadSeen) {
          reloadDebounce.restart()
        }
      }
      var trial = done !== null && done.kind === "trial" && root.confirmPending
      if (exitCode !== 0 || (answer !== "" && answer !== "ok")) {
        root.applyState = "failed"
        // A trial that did not go in cleanly is not one to keep.
        if (trial) root.revertChanges(true)
        root.lastError = (answer !== "" ? answer : "hyprctl eval failed or timed out.")
          + (trial ? " Going back to the previous layout." : "")
      } else {
        root.applyState = "ok"
        root.lastError = root.applyNote
        if (trial) {
          root.confirmArmed = true
          confirmTimer.restart()
        } else if (done !== null) {
          root.standing = { layout: done.layout, topology: done.topology }
        }
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

  Timer {
    id: probeRetry
    property int attempts: 0
    property string reason: ""
    interval: 1000
    onTriggered: root.probe(reason)
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

  Timer {
    id: ownReloadWindow
    interval: 1500
    onTriggered: root.ownReloadPending = false
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event || !event.name) return
      var name = String(event.name)
      if (name.indexOf("monitoradded") === 0 || name.indexOf("monitorremoved") === 0)
        hotplugDebounce.restart()
      // A config reload drops everything set through eval, so put it back.
      else if (name === "configreloaded") {
        // An apply that may reload the config itself expects one such event.
        var running = applyProc.busy ? root.applying : null
        if (running && running.mayReload && !running.reloadSeen) running.reloadSeen = true
        else if (root.ownReloadPending) root.ownReloadPending = false
        else reloadDebounce.restart()
      }
    }
  }

  IpcHandler {
    target: "display-profiles"

    function status(): string { return root.statusJson() }
    function refresh(): void { root.refresh() }
    function identify(): void { root.identify() }
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
    function use(id: string): string {
      if (!root.findProfile(id)) return "unknown profile"
      return root.switchProfile(id) ? "switching" : "not switched: " + root.lastError
    }
    function next(): string {
      if (root.setupProfiles.length < 2) return "no other profile for this setup"
      return root.nextProfile() ? "switching" : "not switched: " + root.lastError
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
