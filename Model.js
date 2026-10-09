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
    var key = clean(monitors[i].key) || monitorKey(monitors[i])
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

  // Two monitors that report the same make, model, and serial (it happens with
  // cheap panels and some KVMs) would otherwise share one key and be edited as
  // one. They are told apart by connector instead.
  var seen = {}
  for (var a = 0; a < monitors.length; a++) seen[monitors[a].key] = (seen[monitors[a].key] || 0) + 1
  for (var b = 0; b < monitors.length; b++)
    if (seen[monitors[b].key] > 1) monitors[b].key = monitors[b].key + "@" + monitors[b].name
  return monitors
}

// Everything a generated layout depends on: which monitors, on which
// connectors, behind which dock. Unlike the fingerprint it changes when a dock
// is replugged and the connectors are renumbered.
function topology(monitors, dock) {
  var parts = []
  for (var i = 0; i < (monitors || []).length; i++) parts.push(monitors[i].key + "=" + monitors[i].name)
  parts.sort()
  return parts.join(" + ") + " # " + (dock && dock.id ? dock.id : "")
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
  return reflow(placeOne(monitors, key, x, y))
}

function placeOne(monitors, key, x, y) {
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

// Two monitors are neighbours when they share part of an edge, which is what
// lets the pointer cross from one to the other.
function touching(a, b) {
  var sharedY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  var sharedX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  if ((a.x + a.width === b.x || b.x + b.width === a.x) && sharedY > 0) return true
  if ((a.y + a.height === b.y || b.y + b.height === a.y) && sharedX > 0) return true
  return false
}

// Keys of the enabled monitors reachable from the first one through shared
// edges.
function connectedKeys(monitors) {
  var enabled = []
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].enabled !== false) enabled.push(monitors[i])
  var reached = {}
  if (enabled.length === 0) return reached
  var queue = [enabled[0]]
  reached[enabled[0].key] = true
  while (queue.length > 0) {
    var current = rectOf(queue.shift())
    for (var j = 0; j < enabled.length; j++) {
      if (reached[enabled[j].key] || !touching(current, rectOf(enabled[j]))) continue
      reached[enabled[j].key] = true
      queue.push(enabled[j])
    }
  }
  return reached
}

// Pull monitors that were left on an island back against the rest. Moving or
// switching off the monitor in the middle of a row would otherwise leave a gap
// the pointer cannot cross. Monitors that are already connected do not move.
function reflow(monitors) {
  var current = monitors || []
  for (var guard = 0; guard < current.length; guard++) {
    var reached = connectedKeys(current)
    var stray = null
    var base = []
    for (var i = 0; i < current.length; i++) {
      var m = current[i]
      if (m.enabled === false) continue
      if (reached[m.key]) base.push(m)
      else if (!stray) stray = m
    }
    if (!stray) break
    // placeOne normalizes its own subset; bring the result back into the
    // coordinates of the full layout through a monitor that did not move.
    var subset = placeOne(base.concat([stray]), stray.key, stray.x, stray.y)
    var placed = monitorByKey(subset, stray.key)
    var anchorBefore = base[0]
    var anchorAfter = monitorByKey(subset, anchorBefore.key)
    var next = []
    for (var k = 0; k < current.length; k++) {
      var copy = cloneMonitor(current[k])
      if (copy.key === stray.key) {
        copy.x = placed.x + (anchorBefore.x - anchorAfter.x)
        copy.y = placed.y + (anchorBefore.y - anchorAfter.y)
      }
      next.push(copy)
    }
    current = next
  }
  return normalize(current)
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
  if (target.enabled === false) return reflow(edited)

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

var NAME_LIMIT = 48
var SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/

function cleanName(name) {
  var text = clean(name).replace(/\s+/g, " ")
  return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT).trim() : text
}

function shorten(text, limit) {
  var value = clean(text)
  return value.length > limit ? value.slice(0, Math.max(1, limit - 1)).trim() + "…" : value
}

function inRange(value, low, high) {
  return typeof value === "number" && isFinite(value) && value >= low && value <= high
}

// A stored profile, checked field by field. Returns a clean copy, or null when
// anything is off: a profile is turned into monitor settings, so a half-valid
// one is not worth guessing at.
function validProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null
  if (typeof p.id !== "string" || !SAFE_ID.test(p.id)) return null
  if (typeof p.name !== "string" || typeof p.fingerprint !== "string") return null
  var dock = null
  if (p.dock !== null && p.dock !== undefined) {
    if (typeof p.dock !== "object" || typeof p.dock.id !== "string" || clean(p.dock.id) === "") return null
    dock = { id: clean(p.dock.id), name: clean(p.dock.name) }
  }
  if (!Array.isArray(p.monitors) || p.monitors.length < 1 || p.monitors.length > 16) return null
  var monitors = []
  var keys = {}
  for (var i = 0; i < p.monitors.length; i++) {
    var m = p.monitors[i]
    if (!m || typeof m !== "object" || typeof m.key !== "string" || clean(m.key) === "" || keys[m.key]) return null
    if (!inRange(m.width, 0, 20000) || !inRange(m.height, 0, 20000)) return null
    if (!inRange(m.x, -100000, 100000) || !inRange(m.y, -100000, 100000)) return null
    if (!inRange(m.scale, 0.25, 8) || !inRange(m.refreshRate, 0, 1000)) return null
    if (!inRange(m.transform, 0, 7) || Math.round(m.transform) !== m.transform) return null
    keys[m.key] = true
    monitors.push({
      key: m.key,
      description: clean(m.description),
      internal: m.internal === true,
      enabled: m.enabled !== false,
      width: m.width, height: m.height, refreshRate: m.refreshRate,
      x: m.x, y: m.y, scale: m.scale, transform: m.transform
    })
  }
  var workspaces = {}
  if (p.workspaces !== undefined && p.workspaces !== null) {
    if (typeof p.workspaces !== "object" || Array.isArray(p.workspaces)) return null
    for (var key in p.workspaces) {
      var ids = p.workspaces[key]
      if (!Array.isArray(ids)) return null
      for (var w = 0; w < ids.length; w++)
        if (!inRange(ids[w], 1, WORKSPACE_COUNT) || Math.round(ids[w]) !== ids[w]) return null
      workspaces[key] = ids.slice()
    }
  }
  return { id: p.id, name: cleanName(p.name), fingerprint: p.fingerprint, dock: dock, monitors: monitors, workspaces: workspaces }
}

// Read the profiles file. `status` says whether the result may ever be written
// back: "missing" and "ok" may, "corrupt" and "unsupported" must not, because
// writing would destroy a file this version could not understand.
function loadStore(raw, exists) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  if (!exists || text.trim() === "") return { status: "missing", store: emptyStore(), error: "" }
  var parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { status: "corrupt", store: emptyStore(), error: "The profiles file is not valid JSON." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { status: "corrupt", store: emptyStore(), error: "The profiles file does not hold a profile list." }
  if (typeof parsed.version === "number" && parsed.version > 1)
    return { status: "unsupported", store: emptyStore(),
             error: "The profiles file was written by a newer version of Display Profiles." }
  if (parsed.version !== 1 || !Array.isArray(parsed.profiles))
    return { status: "corrupt", store: emptyStore(), error: "The profiles file does not hold a profile list." }
  var profiles = []
  var ids = {}
  for (var i = 0; i < parsed.profiles.length; i++) {
    var profile = validProfile(parsed.profiles[i])
    if (!profile || ids[profile.id])
      return { status: "corrupt", store: emptyStore(), error: "Profile " + (i + 1) + " in the profiles file is not valid." }
    ids[profile.id] = true
    profiles.push(profile)
  }
  return { status: "ok", store: { version: 1, autoApply: parsed.autoApply !== false, profiles: profiles }, error: "" }
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
    name: cleanName(name),
    fingerprint: fingerprint(monitors),
    dock: dock ? { id: dock.id, name: dock.name } : null,
    monitors: list,
    workspaces: completeWorkspaces(list, workspaces)
  }
}

// The profile saved for exactly this setup: the same monitors behind the same
// dock. A profile from another dock never matches, so the layout of one desk
// is neither applied at another nor overwritten by saving there.
//
// Two cases cannot be told apart and fall back to the monitors alone: a
// profile saved without a dock, and a setup whose dock cannot be read right
// now. With several candidates in that position nothing matches rather than
// guessing.
function matchProfile(profiles, print, dock) {
  var sameSetup = []
  for (var i = 0; i < (profiles || []).length; i++)
    if (profiles[i].fingerprint === print) sameSetup.push(profiles[i])
  if (sameSetup.length === 0) return null

  var dockId = dock && dock.id ? dock.id : ""
  var dockless = []
  for (var j = 0; j < sameSetup.length; j++) {
    var savedDock = (sameSetup[j].dock && sameSetup[j].dock.id) || ""
    if (savedDock === dockId) return sameSetup[j]
    if (savedDock === "") dockless.push(sameSetup[j])
  }
  if (dockId !== "") return dockless.length === 1 ? dockless[0] : null
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

// Does the live setup already look like the profile? `owners` maps workspace
// id to connector name (workspaceOwnerNames), so workspaces that have not been
// opened yet count too.
function matchesLive(profile, monitors, owners) {
  if (!profile) return false
  var live = {}
  for (var i = 0; i < (monitors || []).length; i++) live[monitors[i].key] = monitors[i]
  var present = []
  for (var j = 0; j < profile.monitors.length; j++) {
    var want = profile.monitors[j]
    var have = live[want.key]
    if (!have) return false
    if ((want.enabled !== false) !== (have.enabled !== false)) return false
    present.push(want)
    if (want.enabled === false) continue
    if (want.x !== have.x || want.y !== have.y) return false
    if (want.width !== have.width || want.height !== have.height) return false
    if (Math.abs(num(want.refreshRate, 0) - num(have.refreshRate, 0)) > 0.1) return false
    if (Math.abs(want.scale - have.scale) > 0.011) return false
    if (want.transform !== have.transform) return false
  }
  if (owners) {
    var wanted = completeWorkspaces(present, profile.workspaces)
    for (var key in wanted) {
      for (var w = 0; w < wanted[key].length; w++)
        if (owners[wanted[key][w]] !== live[key].name) return false
    }
  }
  return true
}

// Would applying `wanted` change any monitor's own settings, as opposed to
// only moving workspaces? Those are the changes that can leave a screen dark,
// so they are the ones that ask for confirmation.
function changesMonitors(wanted, monitors) {
  var live = {}
  for (var i = 0; i < (monitors || []).length; i++) live[monitors[i].key] = monitors[i]
  for (var j = 0; j < (wanted || []).length; j++) {
    var want = wanted[j]
    var have = live[want.key]
    if (!have) continue
    if ((want.enabled !== false) !== (have.enabled !== false)) return true
    if (want.enabled === false) continue
    if (want.x !== have.x || want.y !== have.y) return true
    if (want.width !== have.width || want.height !== have.height) return true
    if (Math.abs(num(want.refreshRate, 0) - num(have.refreshRate, 0)) > 0.1) return true
    if (Math.abs(num(want.scale, 1) - num(have.scale, 1)) > 0.011) return true
    if (num(want.transform, 0) !== num(have.transform, 0)) return true
  }
  return false
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
//
// `owner` names the service instance applying it, so that an older instance
// shutting down late does not switch these rules off (see buildReleaseLua).
function buildApplyLua(profile, monitors, owner) {
  var nameByKey = {}
  for (var i = 0; i < (monitors || []).length; i++) {
    var live = monitors[i]
    if (SAFE_NAME.test(live.name)) nameByKey[live.key] = live.name
  }

  var lines = []
  var disables = []
  var skipped = []
  var enabledNames = {}
  var enabledCount = 0
  for (var j = 0; j < ((profile && profile.monitors) || []).length; j++) {
    var m = profile.monitors[j]
    if (m && m.enabled !== false && nameByKey[m.key]) enabledCount++
  }
  // Never apply a profile that would turn every connected screen off.
  if (enabledCount === 0) return { lua: "", skipped: [] }

  for (var k = 0; k < profile.monitors.length; k++) {
    var want = profile.monitors[k]
    if (!want) continue
    var name = nameByKey[want.key]
    if (!name) { skipped.push(want.description || want.key); continue }
    if (want.enabled === false) {
      disables.push('hl.monitor({ output = "' + name + '", disabled = true })')
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

  // Screens are switched on before any is switched off, so a failure part way
  // through leaves more screens lit rather than fewer.
  lines = lines.concat(disables)

  // Every apply issues a rule for each of the workspaces 1..WORKSPACE_COUNT,
  // and Hyprland updates an existing rule for the same workspace in place. So
  // nothing has to be switched off first, and repeated applies do not pile up
  // dead rules. The handles are kept only to mark that this plugin has state
  // in Hyprland.
  lines.push("__display_profiles_rules = {}")
  lines.push('__display_profiles_owner = "' + (SAFE_NAME.test(clean(owner)) ? clean(owner) : "") + '"')

  // Workspaces of a monitor that is off or not connected go to the primary
  // rather than being left without a rule.
  var present = []
  for (var p = 0; p < profile.monitors.length; p++) {
    if (!profile.monitors[p]) continue
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

// Hand the screens back to the user's own Hyprland configuration. Rules set
// through eval update the user's rules in place, so they cannot be taken out
// one by one; a config reload is what restores exactly what the user wrote,
// and it drops everything buildApplyLua left behind.
//
// With an `owner`, this only happens if that instance was the last to apply,
// so an instance torn down late does not undo a newer one. Without one, it
// happens if any instance left something. If nothing was ever applied, the
// chunk does nothing.
function buildReleaseLua(owner) {
  var token = clean(owner)
  if (token !== "" && !SAFE_NAME.test(token)) return ""
  return [
    token === "" ? "if __display_profiles_owner ~= nil then"
                 : 'if __display_profiles_owner == "' + token + '" then',
    "__display_profiles_rules = nil",
    "__display_profiles_owner = nil",
    'hl.exec_cmd("hyprctl reload")',
    "end"
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
    loadStore: loadStore,
    validProfile: validProfile,
    cleanName: cleanName,
    shorten: shorten,
    topology: topology,
    reflow: reflow,
    connectedKeys: connectedKeys,
    changesMonitors: changesMonitors,
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
