// Pure logic for Display Profiles: identifying a display setup, matching it to a
// saved profile, arranging monitors, and turning a profile into the Lua that
// Hyprland evaluates. Nothing here touches the system, so it runs under Node
// for the tests in test/.

var WORKSPACE_COUNT = 10
var SNAP_DISTANCE = 48

// ---- Identity ---------------------------------------------------------------

function clean(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isInternalName(name) {
  return /^(eDP|LVDS|DSI)-/.test(clean(name))
}

// A monitor is identified by what it is, not by the connector it happens to be
// on: DP-N names change on every dock replug. Panels without a serial (most
// laptop panels) fall back to the connector so two of them stay distinct.
function monitorKey(monitor) {
  if (!monitor) return ""
  var make = clean(monitor.make)
  var model = clean(monitor.model)
  var serial = clean(monitor.serial)
  var base = make + "|" + model
  if (serial !== "") return base + "|" + serial
  return base + "@" + clean(monitor.name)
}

function fingerprint(monitors) {
  var keys = []
  for (var i = 0; i < (monitors || []).length; i++) {
    var key = monitorKey(monitors[i])
    if (key !== "") keys.push(key)
  }
  keys.sort()
  return keys.join(" + ")
}

function parseMonitors(raw) {
  var parsed = []
  try {
    parsed = raw ? JSON.parse(String(raw)) : []
  } catch (e) {
    parsed = []
  }
  if (!Array.isArray(parsed)) return []

  var monitors = []
  for (var i = 0; i < parsed.length; i++) {
    var m = parsed[i]
    if (!m || !clean(m.name)) continue
    // A headless or fake output is not part of a physical setup.
    if (/^(HEADLESS|FALLBACK)/.test(clean(m.name))) continue
    monitors.push({
      name: clean(m.name),
      key: monitorKey(m),
      description: clean(m.description) || clean(m.name),
      make: clean(m.make),
      model: clean(m.model),
      serial: clean(m.serial),
      internal: isInternalName(m.name),
      enabled: m.disabled !== true,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      refreshRate: Number(m.refreshRate) || 0,
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      scale: Number(m.scale) || 1,
      transform: Number(m.transform) || 0,
      focused: m.focused === true,
      modes: Array.isArray(m.availableModes) ? m.availableModes.slice() : [],
      activeWorkspace: m.activeWorkspace ? Number(m.activeWorkspace.id) || 0 : 0
    })
  }
  return monitors
}

// Thunderbolt/USB4 docks expose a stable unique id. `raw` is one dock per line,
// "id<TAB>vendor<TAB>name", as printed by the probe in Service.qml. The first
// line that names a device is the dock; host controllers have no device name.
function parseDock(raw) {
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("\t")
    var id = clean(parts[0])
    var vendor = clean(parts[1])
    var name = clean(parts[2])
    if (id === "" || name === "") continue
    return { id: id, name: (vendor !== "" && name.indexOf(vendor) !== 0 ? vendor + " " : "") + name }
  }
  return null
}

function parseWorkspaces(raw) {
  var parsed = []
  try {
    parsed = raw ? JSON.parse(String(raw)) : []
  } catch (e) {
    parsed = []
  }
  if (!Array.isArray(parsed)) return []
  var workspaces = []
  for (var i = 0; i < parsed.length; i++) {
    var w = parsed[i]
    var id = Number(w && w.id)
    if (!w || !isFinite(id) || id < 1) continue
    workspaces.push({ id: id, monitor: clean(w.monitor) })
  }
  return workspaces
}

// ---- Geometry ---------------------------------------------------------------

function rotated(transform) {
  return Number(transform) % 2 === 1
}

// Size in Hyprland's layout coordinates: scaled, and swapped when rotated.
function logicalSize(monitor) {
  var scale = Number(monitor.scale) > 0 ? Number(monitor.scale) : 1
  var w = Math.round((Number(monitor.width) || 0) / scale)
  var h = Math.round((Number(monitor.height) || 0) / scale)
  return rotated(monitor.transform) ? { width: h, height: w } : { width: w, height: h }
}

function rectOf(monitor) {
  var size = logicalSize(monitor)
  return { x: Number(monitor.x) || 0, y: Number(monitor.y) || 0, width: size.width, height: size.height }
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height
}

function layoutBounds(monitors) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (var i = 0; i < (monitors || []).length; i++) {
    if (monitors[i].enabled === false) continue
    var r = rectOf(monitors[i])
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// Shift the whole layout so its top-left corner sits at 0x0.
function normalize(monitors) {
  var bounds = layoutBounds(monitors)
  var result = []
  for (var i = 0; i < (monitors || []).length; i++) {
    var copy = cloneMonitor(monitors[i])
    if (copy.enabled !== false) {
      copy.x = Math.round(copy.x - bounds.x)
      copy.y = Math.round(copy.y - bounds.y)
    }
    result.push(copy)
  }
  return result
}

function cloneMonitor(monitor) {
  var copy = {}
  for (var k in monitor) copy[k] = monitor[k]
  return copy
}

// Every position where `moving` touches `other` edge to edge, aligned to one of
// its corners or centered on it.
function attachPoints(moving, other) {
  var m = logicalSize(moving)
  var o = rectOf(other)
  var points = []
  var ys = [o.y, o.y + o.height - m.height, o.y + Math.round((o.height - m.height) / 2)]
  var xs = [o.x, o.x + o.width - m.width, o.x + Math.round((o.width - m.width) / 2)]
  for (var i = 0; i < ys.length; i++) {
    points.push({ x: o.x - m.width, y: ys[i] })
    points.push({ x: o.x + o.width, y: ys[i] })
  }
  for (var j = 0; j < xs.length; j++) {
    points.push({ x: xs[j], y: o.y - m.height })
    points.push({ x: xs[j], y: o.y + o.height })
  }
  return points
}

// Place the monitor `key` as close to (x, y) as it can go while touching
// another monitor and overlapping none. Hyprland lays windows out badly on
// layouts with gaps or overlaps, so a drop always lands on a valid spot.
function place(monitors, key, x, y) {
  var moving = null
  var others = []
  for (var i = 0; i < (monitors || []).length; i++) {
    if (monitors[i].key === key) moving = cloneMonitor(monitors[i])
    else if (monitors[i].enabled !== false) others.push(monitors[i])
  }
  if (!moving) return monitors
  moving.x = Math.round(x)
  moving.y = Math.round(y)

  if (others.length > 0) {
    var best = null
    var bestDistance = Infinity
    for (var o = 0; o < others.length; o++) {
      var points = attachPoints(moving, others[o])
      for (var p = 0; p < points.length; p++) {
        var candidate = cloneMonitor(moving)
        candidate.x = points[p].x
        candidate.y = points[p].y
        var rect = rectOf(candidate)
        var free = true
        for (var c = 0; c < others.length; c++) {
          if (overlaps(rect, rectOf(others[c]))) { free = false; break }
        }
        if (!free) continue
        var dx = candidate.x - x
        var dy = candidate.y - y
        var distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = candidate }
      }
    }
    if (best) moving = best
  }

  var result = []
  for (var r = 0; r < monitors.length; r++)
    result.push(monitors[r].key === key ? moving : cloneMonitor(monitors[r]))
  return normalize(result)
}

// Pull a dragged monitor onto a neighbour's edge when it comes close, so the
// preview shows where the drop will land.
function snap(monitors, key, x, y) {
  var moving = null
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].key === key) moving = monitors[i]
  if (!moving) return { x: x, y: y }

  var size = logicalSize(moving)
  var sx = x, sy = y
  var bestX = SNAP_DISTANCE, bestY = SNAP_DISTANCE
  for (var o = 0; o < monitors.length; o++) {
    if (monitors[o].key === key || monitors[o].enabled === false) continue
    var r = rectOf(monitors[o])
    var xs = [r.x - size.width, r.x + r.width, r.x, r.x + r.width - size.width]
    var ys = [r.y - size.height, r.y + r.height, r.y, r.y + r.height - size.height]
    for (var a = 0; a < xs.length; a++) {
      var ddx = Math.abs(xs[a] - x)
      if (ddx < bestX) { bestX = ddx; sx = xs[a] }
    }
    for (var b = 0; b < ys.length; b++) {
      var ddy = Math.abs(ys[b] - y)
      if (ddy < bestY) { bestY = ddy; sy = ys[b] }
    }
  }
  return { x: sx, y: sy }
}

// ---- Scale ------------------------------------------------------------------

function gcd(a, b) {
  while (b) {
    var remainder = a % b
    a = b
    b = remainder
  }
  return a
}

// Hyprland only accepts scales where the mode divides into whole logical
// pixels (in 1/120 steps). Round a requested scale up to the nearest one that
// does, the same way `omarchy hyprland monitor scaling` does.
function cleanScale(scale, width, height) {
  var requested = Number(scale)
  var w = Number(width)
  var h = Number(height)
  if (!isFinite(requested) || !isFinite(w) || !isFinite(h) || requested <= 0 || w <= 0 || h <= 0) return 1
  var divisor = gcd(Math.round(w * 120), Math.round(h * 120))
  var units = Math.round(requested * 120)
  if (units > divisor) units = divisor
  while (divisor % units !== 0) units++
  return Math.round(units / 120 * 1000000) / 1000000
}

var SCALE_PRESETS = [1, 1.25, 1.5, 2, 3]

// The distinct scales a mode can actually run at, labelled for display.
function scaleOptions(width, height) {
  var seen = {}
  var options = []
  for (var i = 0; i < SCALE_PRESETS.length; i++) {
    var value = cleanScale(SCALE_PRESETS[i], width, height)
    var label = String(Math.round(value * 100) / 100)
    if (seen[label]) continue
    seen[label] = true
    options.push({ value: value, label: label })
  }
  return options
}

function sameScale(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.011
}

// ---- Draft edits ------------------------------------------------------------

// Change one monitor of a draft, then put it back on a valid spot: a new scale
// or rotation changes its size, and a re-enabled monitor needs a place.
function editMonitor(monitors, key, changes) {
  var edited = []
  var target = null
  for (var i = 0; i < (monitors || []).length; i++) {
    var copy = cloneMonitor(monitors[i])
    if (copy.key === key) {
      for (var k in changes) copy[k] = changes[k]
      target = copy
    }
    edited.push(copy)
  }
  if (!target) return monitors
  if (target.enabled === false) return normalize(edited)

  var x = target.x
  var y = target.y
  if (changes.enabled === true) {
    var others = []
    for (var j = 0; j < edited.length; j++)
      if (edited[j].key !== key && edited[j].enabled !== false) others.push(edited[j])
    var bounds = layoutBounds(others)
    x = bounds.x + bounds.width
    y = bounds.y
  }
  return place(edited, key, x, y)
}

function enabledCount(monitors) {
  var count = 0
  for (var i = 0; i < (monitors || []).length; i++) if (monitors[i].enabled !== false) count++
  return count
}

function monitorByKey(monitors, key) {
  for (var i = 0; i < (monitors || []).length; i++) if (monitors[i].key === key) return monitors[i]
  return null
}

function shortName(monitor) {
  if (!monitor) return ""
  if (monitor.internal) return "Laptop"
  return clean(monitor.model) || clean(monitor.description) || clean(monitor.name)
}

// ---- Workspaces -------------------------------------------------------------

// workspaces: { "<monitor key>": [ids] }. Every id from 1..WORKSPACE_COUNT
// belongs to exactly one enabled monitor.
function assignWorkspace(monitors, workspaces, id, key) {
  var next = {}
  for (var i = 0; i < (monitors || []).length; i++) {
    var k = monitors[i].key
    var kept = []
    var current = (workspaces && workspaces[k]) || []
    for (var j = 0; j < current.length; j++)
      if (Number(current[j]) !== Number(id)) kept.push(Number(current[j]))
    if (k === key) kept.push(Number(id))
    kept.sort(function(a, b) { return a - b })
    next[k] = kept
  }
  return next
}

function workspaceOwner(workspaces, id) {
  for (var key in workspaces || {}) {
    var ids = workspaces[key] || []
    for (var i = 0; i < ids.length; i++)
      if (Number(ids[i]) === Number(id)) return key
  }
  return ""
}

function primaryKey(monitors) {
  var enabled = []
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].enabled !== false) enabled.push(monitors[i])
  for (var j = 0; j < enabled.length; j++)
    if (enabled[j].internal) return enabled[j].key
  return enabled.length > 0 ? enabled[0].key : ""
}

// Drop ids that point at monitors that are gone or disabled, and hand every
// unowned id to the primary monitor.
function completeWorkspaces(monitors, workspaces) {
  var enabledKeys = {}
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].enabled !== false) enabledKeys[monitors[i].key] = true

  var owner = {}
  for (var key in workspaces || {}) {
    if (!enabledKeys[key]) continue
    var ids = workspaces[key] || []
    for (var j = 0; j < ids.length; j++) {
      var id = Number(ids[j])
      if (isFinite(id) && id >= 1 && id <= WORKSPACE_COUNT && owner[id] === undefined) owner[id] = key
    }
  }

  var primary = primaryKey(monitors)
  var result = {}
  for (var k in enabledKeys) result[k] = []
  if (primary === "") return result
  for (var w = 1; w <= WORKSPACE_COUNT; w++) {
    var target = owner[w] !== undefined ? owner[w] : primary
    result[target].push(w)
  }
  return result
}

// Workspace rules already in force (from the user's own Hyprland config, or
// from an earlier apply), as [{ id, monitor }]. `monitor` is a connector name
// or a "desc:" selector, exactly as Hyprland reports it.
function parseWorkspaceRules(raw) {
  var parsed = []
  try {
    parsed = raw ? JSON.parse(String(raw)) : []
  } catch (e) {
    parsed = []
  }
  if (!Array.isArray(parsed)) return []
  var rules = []
  for (var i = 0; i < parsed.length; i++) {
    var r = parsed[i]
    if (!r || r.enabled === false) continue
    var id = Number(r.workspaceString)
    var monitor = clean(r.monitor)
    if (!isFinite(id) || id < 1 || id > WORKSPACE_COUNT || Math.round(id) !== id || monitor === "") continue
    rules.push({ id: id, monitor: monitor })
  }
  return rules
}

function keyForSelector(monitors, selector) {
  var wanted = clean(selector)
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].name === wanted) return monitors[i].key
  if (wanted.indexOf("desc:") === 0) {
    var description = clean(wanted.slice(5))
    for (var j = 0; j < monitors.length; j++)
      if (description !== "" && monitors[j].description.indexOf(description) === 0) return monitors[j].key
  }
  return ""
}

// The workspace assignment in effect right now, as the starting point for a
// new profile. A rule says where a workspace belongs even before it has been
// opened, so rules come first; workspaces without one count where they sit.
function workspacesFromLive(monitors, liveWorkspaces, rules) {
  var workspaces = {}
  var claimed = {}
  function claim(id, key) {
    if (!key || claimed[id] || id > WORKSPACE_COUNT) return
    claimed[id] = true
    if (!workspaces[key]) workspaces[key] = []
    workspaces[key].push(id)
  }
  for (var r = 0; r < (rules || []).length; r++)
    claim(rules[r].id, keyForSelector(monitors, rules[r].monitor))
  for (var j = 0; j < (liveWorkspaces || []).length; j++)
    claim(liveWorkspaces[j].id, keyForSelector(monitors, liveWorkspaces[j].monitor))
  return completeWorkspaces(monitors, workspaces)
}

// ---- Workspace strip (bar) ---------------------------------------------------

// Connector name of the monitor each workspace 1..WORKSPACE_COUNT belongs to,
// including workspaces that have not been opened yet.
function workspaceOwnerNames(monitors, liveWorkspaces, rules) {
  var byKey = workspacesFromLive(monitors, liveWorkspaces, rules)
  var names = {}
  for (var i = 0; i < (monitors || []).length; i++) {
    var ids = byKey[monitors[i].key] || []
    for (var j = 0; j < ids.length; j++) names[ids[j]] = monitors[i].name
  }
  return names
}

// The workspaces the bar lists: the first five, plus any other that exists.
function stripIds(liveIds) {
  var seen = {}
  var ids = []
  function add(value) {
    var id = Number(value)
    if (!isFinite(id) || Math.round(id) !== id || id < 1 || id > WORKSPACE_COUNT || seen[id]) return
    seen[id] = true
    ids.push(id)
  }
  for (var i = 1; i <= 5; i++) add(i)
  for (var j = 0; j < (liveIds || []).length; j++) add(liveIds[j])
  ids.sort(function(a, b) { return a - b })
  return ids
}

// Split the listed workspaces into runs of neighbours on the same monitor, as
// [{ monitor, ids }]. Where a workspace sits right now (liveOwners) wins over
// where it is meant to open (plannedOwners). Numbers stay in order, so a
// monitor whose workspaces are not consecutive gets more than one run.
function workspaceRuns(ids, liveOwners, plannedOwners) {
  var runs = []
  for (var i = 0; i < (ids || []).length; i++) {
    var id = ids[i]
    var monitor = clean((liveOwners && liveOwners[id]) || (plannedOwners && plannedOwners[id]))
    var last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last && last.monitor === monitor) last.ids.push(id)
    else runs.push({ monitor: monitor, ids: [id] })
  }
  return runs
}

// ---- Profiles ---------------------------------------------------------------

function emptyStore() {
  return { version: 1, autoApply: true, profiles: [] }
}

function parseStore(raw) {
  var store = null
  try {
    store = raw ? JSON.parse(String(raw)) : null
  } catch (e) {
    store = null
  }
  if (!store || typeof store !== "object" || store.version !== 1 || !Array.isArray(store.profiles))
    return emptyStore()
  var profiles = []
  for (var i = 0; i < store.profiles.length; i++) {
    var p = store.profiles[i]
    if (!p || !clean(p.id) || !Array.isArray(p.monitors)) continue
    profiles.push(p)
  }
  return { version: 1, autoApply: store.autoApply !== false, profiles: profiles }
}

function profileMonitor(monitor) {
  return {
    key: monitor.key,
    description: monitor.description,
    internal: monitor.internal === true,
    enabled: monitor.enabled !== false,
    width: monitor.width,
    height: monitor.height,
    refreshRate: monitor.refreshRate,
    x: monitor.x,
    y: monitor.y,
    scale: monitor.scale,
    transform: monitor.transform
  }
}

function suggestName(monitors, dock, profiles) {
  var external = 0
  for (var i = 0; i < (monitors || []).length; i++) if (!monitors[i].internal) external++
  var base = dock && dock.name ? dock.name
    : external === 0 ? "Laptop only"
    : external === 1 ? "One external display"
    : external + " external displays"
  var taken = {}
  for (var j = 0; j < (profiles || []).length; j++) taken[clean(profiles[j].name)] = true
  if (!taken[base]) return base
  for (var n = 2; n < 100; n++) if (!taken[base + " " + n]) return base + " " + n
  return base
}

function newId(profiles) {
  var taken = {}
  for (var i = 0; i < (profiles || []).length; i++) taken[profiles[i].id] = true
  for (var n = 1; n < 100000; n++) if (!taken["p" + n]) return "p" + n
  return "p" + Date.now()
}

function makeProfile(id, name, monitors, workspaces, dock) {
  var list = []
  for (var i = 0; i < (monitors || []).length; i++) list.push(profileMonitor(monitors[i]))
  return {
    id: id,
    name: clean(name),
    fingerprint: fingerprint(monitors),
    dock: dock ? { id: dock.id, name: dock.name } : null,
    monitors: list,
    workspaces: completeWorkspaces(list, workspaces)
  }
}

// The profile for this setup. The monitor set decides; the dock only breaks a
// tie between setups that look identical (the same serial-less monitors at
// home and at work).
function matchProfile(profiles, print, dock) {
  var sameSetup = []
  for (var i = 0; i < (profiles || []).length; i++)
    if (profiles[i].fingerprint === print) sameSetup.push(profiles[i])
  if (sameSetup.length === 0) return null

  var dockId = dock ? dock.id : ""
  for (var j = 0; j < sameSetup.length; j++)
    if (((sameSetup[j].dock && sameSetup[j].dock.id) || "") === dockId) return sameSetup[j]
  for (var k = 0; k < sameSetup.length; k++)
    if (!sameSetup[k].dock) return sameSetup[k]
  return sameSetup.length === 1 ? sameSetup[0] : null
}

function upsertProfile(store, profile) {
  var profiles = []
  var replaced = false
  for (var i = 0; i < store.profiles.length; i++) {
    if (store.profiles[i].id === profile.id) { profiles.push(profile); replaced = true }
    else profiles.push(store.profiles[i])
  }
  if (!replaced) profiles.push(profile)
  return { version: 1, autoApply: store.autoApply !== false, profiles: profiles }
}

function removeProfile(store, id) {
  var profiles = []
  for (var i = 0; i < store.profiles.length; i++)
    if (store.profiles[i].id !== id) profiles.push(store.profiles[i])
  return { version: 1, autoApply: store.autoApply !== false, profiles: profiles }
}

// Does the live setup already look like the profile? Used to tell the user
// whether there is anything to apply or save.
function matchesLive(profile, monitors, liveWorkspaces) {
  if (!profile) return false
  var live = {}
  for (var i = 0; i < (monitors || []).length; i++) live[monitors[i].key] = monitors[i]
  for (var j = 0; j < profile.monitors.length; j++) {
    var want = profile.monitors[j]
    var have = live[want.key]
    if (!have) return false
    if ((want.enabled !== false) !== (have.enabled !== false)) return false
    if (want.enabled === false) continue
    if (want.x !== have.x || want.y !== have.y) return false
    if (want.width !== have.width || want.height !== have.height) return false
    if (Math.abs(want.scale - have.scale) > 0.011) return false
    if (want.transform !== have.transform) return false
  }
  if (liveWorkspaces) {
    for (var w = 0; w < liveWorkspaces.length; w++) {
      var ws = liveWorkspaces[w]
      if (ws.id > WORKSPACE_COUNT) continue
      var ownerKey = workspaceOwner(profile.workspaces, ws.id)
      if (ownerKey === "" || !live[ownerKey]) continue
      if (live[ownerKey].name !== ws.monitor) return false
    }
  }
  return true
}

// ---- Applying ---------------------------------------------------------------

var SAFE_NAME = /^[A-Za-z0-9._-]+$/

function num(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

function luaNumber(value, fallback, decimals) {
  var n = num(value, fallback)
  var text = n.toFixed(decimals)
  return decimals > 0 ? text.replace(/0+$/, "").replace(/\.$/, "") : text
}

// The Lua chunk that puts a profile into effect, for `hyprctl eval`. Every
// value interpolated into it is a validated connector name or a number, so a
// hostile monitor name or an edited profile file cannot inject code.
//
// Returns { lua, skipped }: `skipped` lists profile monitors that are not
// connected. An empty `lua` means there is nothing safe to apply.
function buildApplyLua(profile, monitors) {
  var nameByKey = {}
  for (var i = 0; i < (monitors || []).length; i++) {
    var live = monitors[i]
    if (SAFE_NAME.test(live.name)) nameByKey[live.key] = live.name
  }

  var lines = []
  var skipped = []
  var enabledNames = {}
  var enabledCount = 0
  for (var j = 0; j < ((profile && profile.monitors) || []).length; j++) {
    var m = profile.monitors[j]
    if (m.enabled !== false && nameByKey[m.key]) enabledCount++
  }
  // Never apply a profile that would turn every connected screen off.
  if (enabledCount === 0) return { lua: "", skipped: [] }

  for (var k = 0; k < profile.monitors.length; k++) {
    var want = profile.monitors[k]
    var name = nameByKey[want.key]
    if (!name) { skipped.push(want.description || want.key); continue }
    if (want.enabled === false) {
      lines.push('hl.monitor({ output = "' + name + '", disabled = true })')
      continue
    }
    enabledNames[want.key] = name
    var width = Math.round(num(want.width, 0))
    var height = Math.round(num(want.height, 0))
    var mode = width > 0 && height > 0
      ? width + "x" + height + "@" + luaNumber(want.refreshRate, 60, 3)
      : "preferred"
    lines.push('hl.monitor({ output = "' + name + '", mode = "' + mode + '", position = "'
      + Math.round(num(want.x, 0)) + "x" + Math.round(num(want.y, 0)) + '", scale = '
      + luaNumber(want.scale, 1, 6) + ", transform = " + Math.round(num(want.transform, 0)) % 8 + " })")
  }

  // Rules from the previous apply are switched off first; the handles live in
  // a global because every eval is a separate chunk.
  lines.push("__display_profiles_rules = __display_profiles_rules or {}")
  lines.push("for _, rule in ipairs(__display_profiles_rules) do pcall(function() rule:set_enabled(false) end) end")
  lines.push("__display_profiles_rules = {}")

  // Workspaces of a monitor that is off or not connected go to the primary
  // rather than being left without a rule.
  var present = []
  for (var p = 0; p < profile.monitors.length; p++) {
    var candidate = cloneMonitor(profile.monitors[p])
    if (!enabledNames[candidate.key]) candidate.enabled = false
    present.push(candidate)
  }
  var workspaces = completeWorkspaces(present, profile.workspaces)
  var moves = []
  for (var key in workspaces) {
    var target = enabledNames[key]
    if (!target) continue
    var ids = workspaces[key]
    for (var w = 0; w < ids.length; w++) {
      var id = Math.round(Number(ids[w]))
      if (!isFinite(id) || id < 1 || id > WORKSPACE_COUNT) continue
      lines.push('__display_profiles_rules[#__display_profiles_rules + 1] = hl.workspace_rule({ workspace = "'
        + id + '", monitor = "' + target + '", default = ' + (w === 0 ? "true" : "false") + " })")
      moves.push("if hl.get_workspace(" + id + ') then hl.dispatch(hl.dsp.workspace.move({ workspace = '
        + id + ', monitor = "' + target + '" })) end')
    }
  }

  return { lua: lines.concat(moves).join("\n"), skipped: skipped }
}

// Undo what buildApplyLua left behind in Hyprland's Lua state. Monitor
// settings themselves are restored by `hyprctl reload`.
function buildReleaseLua() {
  return [
    "for _, rule in ipairs(__display_profiles_rules or {}) do pcall(function() rule:set_enabled(false) end) end",
    "__display_profiles_rules = nil"
  ].join("\n")
}

if (typeof module !== "undefined") {
  module.exports = {
    WORKSPACE_COUNT: WORKSPACE_COUNT,
    monitorKey: monitorKey,
    fingerprint: fingerprint,
    parseMonitors: parseMonitors,
    parseDock: parseDock,
    parseWorkspaces: parseWorkspaces,
    logicalSize: logicalSize,
    rectOf: rectOf,
    overlaps: overlaps,
    layoutBounds: layoutBounds,
    normalize: normalize,
    place: place,
    snap: snap,
    assignWorkspace: assignWorkspace,
    workspaceOwner: workspaceOwner,
    primaryKey: primaryKey,
    completeWorkspaces: completeWorkspaces,
    parseWorkspaceRules: parseWorkspaceRules,
    workspacesFromLive: workspacesFromLive,
    emptyStore: emptyStore,
    parseStore: parseStore,
    suggestName: suggestName,
    newId: newId,
    makeProfile: makeProfile,
    matchProfile: matchProfile,
    upsertProfile: upsertProfile,
    removeProfile: removeProfile,
    matchesLive: matchesLive,
    buildApplyLua: buildApplyLua,
    buildReleaseLua: buildReleaseLua,
    cleanScale: cleanScale,
    scaleOptions: scaleOptions,
    sameScale: sameScale,
    editMonitor: editMonitor,
    enabledCount: enabledCount,
    monitorByKey: monitorByKey,
    shortName: shortName,
    workspaceOwnerNames: workspaceOwnerNames,
    stripIds: stripIds,
    workspaceRuns: workspaceRuns
  }
}
