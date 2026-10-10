// Pure logic for Display Profiles: identifying a display setup, matching it to a
// saved profile, arranging monitors, and turning a profile into the Lua that
// Hyprland evaluates. Nothing here touches the system, so it runs under Node
// for the tests in test/.

var WORKSPACE_COUNT = 10
var MIN_SHARED_EDGE = 200

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
      // Hyprland names the mirrored monitor by its id; turned into a key below.
      id: String(m.id),
      mirror: m.mirrorOf !== undefined && m.mirrorOf !== null && String(m.mirrorOf) !== "none" && String(m.mirrorOf) !== ""
        ? String(m.mirrorOf) : "",
      physicalWidth: Number(m.physicalWidth) || 0,
      physicalHeight: Number(m.physicalHeight) || 0,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      refreshRate: Number(m.refreshRate) || 0,
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      scale: Number(m.scale) || 1,
      transform: Number(m.transform) || 0,
      focused: m.focused === true,
      awake: m.dpmsStatus !== false,
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

  for (var c = 0; c < monitors.length; c++) {
    if (monitors[c].mirror === "") continue
    var source = ""
    for (var d = 0; d < monitors.length; d++)
      if (d !== c && (monitors[d].id === monitors[c].mirror || monitors[d].name === monitors[c].mirror)) source = monitors[d].key
    monitors[c].mirror = source
  }
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

// Is any enabled screen actually lit? While they are all asleep Hyprland holds
// monitor changes back, so a new layout could not be looked at and confirmed.
function anyAwake(monitors) {
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].enabled !== false && monitors[i].awake !== false) return true
  return false
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

// Does the monitor have a desktop of its own? One that is switched off has
// none, and neither has one that mirrors another: it shows that one's picture
// and takes no place in the arrangement.
function hasDesktop(monitor) {
  return !!monitor && monitor.enabled !== false && !monitor.mirror
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
    if (!hasDesktop(monitors[i])) continue
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
    if (hasDesktop(copy)) {
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
// `tolerance` is how far, in layout pixels, the drop is pulled onto a guide.
function place(monitors, key, x, y, tolerance) {
  return reflow(placeOne(monitors, key, x, y, tolerance), key)
}

function clamp(value, low, high) {
  return low > high ? value : Math.max(low, Math.min(high, value))
}

// Where the monitor `key` would land if dropped at (x, y), in the coordinates
// of `monitors` as they are. The monitor slides freely along a neighbour's
// edge, so it can sit anywhere against it and not only at its corners.
function landing(monitors, key, x, y, tolerance) {
  var moving = null
  var others = []
  for (var i = 0; i < (monitors || []).length; i++) {
    if (monitors[i].key === key) moving = monitors[i]
    else if (hasDesktop(monitors[i])) others.push(rectOf(monitors[i]))
  }
  if (!moving) return null
  if (others.length === 0) return { x: Math.round(x), y: Math.round(y) }

  var size = logicalSize(moving)
  var want = snap(monitors, key, Math.round(x), Math.round(y), tolerance)
  var candidates = [{ x: want.x, y: want.y }]

  for (var o = 0; o < others.length; o++) {
    var r = others[o]
    // Keep a real stretch of shared edge, never just a corner.
    var shareX = Math.min(size.width, r.width, MIN_SHARED_EDGE)
    var shareY = Math.min(size.height, r.height, MIN_SHARED_EDGE)
    var xLow = r.x - size.width + shareX, xHigh = r.x + r.width - shareX
    var yLow = r.y - size.height + shareY, yHigh = r.y + r.height - shareY
    var cx = clamp(want.x, xLow, xHigh)
    var cy = clamp(want.y, yLow, yHigh)
    var rows = [r.y - size.height, r.y + r.height]
    var columns = [r.x - size.width, r.x + r.width]
    for (var a = 0; a < rows.length; a++) {
      candidates.push({ x: cx, y: rows[a] })
      // Slide along the edge until clear of whatever is in the way.
      for (var b = 0; b < others.length; b++) {
        var left = others[b].x - size.width, right = others[b].x + others[b].width
        if (left >= xLow && left <= xHigh) candidates.push({ x: left, y: rows[a] })
        if (right >= xLow && right <= xHigh) candidates.push({ x: right, y: rows[a] })
      }
    }
    for (var c = 0; c < columns.length; c++) {
      candidates.push({ x: columns[c], y: cy })
      for (var d = 0; d < others.length; d++) {
        var above = others[d].y - size.height, below = others[d].y + others[d].height
        if (above >= yLow && above <= yHigh) candidates.push({ x: columns[c], y: above })
        if (below >= yLow && below <= yHigh) candidates.push({ x: columns[c], y: below })
      }
    }
  }
  for (var m = 0; m < monitors.length; m++) {
    if (monitors[m].key === key || !hasDesktop(monitors[m])) continue
    candidates = candidates.concat(attachPoints(moving, monitors[m]))
  }

  var best = null
  var bestDistance = Infinity
  for (var p = 0; p < candidates.length; p++) {
    var rect = { x: candidates[p].x, y: candidates[p].y, width: size.width, height: size.height }
    var free = true
    var attached = false
    for (var q = 0; q < others.length; q++) {
      if (overlaps(rect, others[q])) { free = false; break }
      if (sharedEdge(rect, others[q]) >= Math.min(MIN_SHARED_EDGE, rect.width, rect.height, others[q].width, others[q].height))
        attached = true
    }
    if (!free || !attached) continue
    var dx = rect.x - want.x
    var dy = rect.y - want.y
    var distance = dx * dx + dy * dy
    if (distance < bestDistance) { bestDistance = distance; best = candidates[p] }
  }
  return best || { x: want.x, y: want.y }
}

function placeOne(monitors, key, x, y, tolerance) {
  var spot = landing(monitors, key, x, y, tolerance)
  if (!spot) return monitors
  var result = []
  for (var r = 0; r < monitors.length; r++) {
    var copy = cloneMonitor(monitors[r])
    if (copy.key === key) { copy.x = spot.x; copy.y = spot.y }
    result.push(copy)
  }
  return normalize(result)
}

// How much edge two rectangles share, in layout pixels; 0 when they do not
// sit edge to edge.
function sharedEdge(a, b) {
  var sharedY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  var sharedX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  if (a.x + a.width === b.x || b.x + b.width === a.x) return Math.max(0, sharedY)
  if (a.y + a.height === b.y || b.y + b.height === a.y) return Math.max(0, sharedX)
  return 0
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

// Keys of the enabled monitors reachable through shared edges from the
// monitor `startKey`, or from the first one when that is not given.
function connectedKeys(monitors, startKey) {
  var enabled = []
  for (var i = 0; i < (monitors || []).length; i++)
    if (hasDesktop(monitors[i])) enabled.push(monitors[i])
  var reached = {}
  if (enabled.length === 0) return reached
  var start = enabled[0]
  for (var s = 0; s < enabled.length; s++) if (enabled[s].key === startKey) start = enabled[s]
  var queue = [start]
  reached[start.key] = true
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
// the pointer cannot cross. The monitors connected to `anchorKey` (the one
// that was just moved, so that it stays where it was dropped; the first one
// otherwise) stay where they are; every other one is put, one at a time,
// against those that are settled so far. Each is checked against the whole
// settled set, so the result is connected and free of overlaps.
function reflow(monitors, anchorKey) {
  var current = []
  for (var i = 0; i < (monitors || []).length; i++) current.push(cloneMonitor(monitors[i]))
  var reached = connectedKeys(current, anchorKey)
  var settled = []
  var strays = []
  for (var j = 0; j < current.length; j++) {
    if (!hasDesktop(current[j])) continue
    if (reached[current[j].key]) settled.push(current[j])
    else strays.push(current[j])
  }
  if (settled.length === 0) return normalize(current)

  var anchor = settled[0]
  for (var k = 0; k < strays.length; k++) {
    var stray = strays[k]
    // placeOne normalizes its own subset; bring the result back into the
    // coordinates of the full layout through a monitor that did not move.
    var subset = placeOne(settled.concat([stray]), stray.key, stray.x, stray.y)
    var placed = monitorByKey(subset, stray.key)
    var moved = monitorByKey(subset, anchor.key)
    stray.x = placed.x + (anchor.x - moved.x)
    stray.y = placed.y + (anchor.y - moved.y)
    settled.push(stray)
  }
  return normalize(current)
}

// Pull a position onto the nearest guide within `tolerance`: a neighbour's
// edges, its middle, or centered on one of its edges. The last one is what
// centers a laptop under the seam between two monitors.
function snap(monitors, key, x, y, tolerance) {
  var moving = null
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].key === key) moving = monitors[i]
  var reach = Number(tolerance) > 0 ? Number(tolerance) : 0
  if (!moving || reach === 0) return { x: x, y: y }

  var size = logicalSize(moving)
  var sx = x, sy = y
  var bestX = reach, bestY = reach
  for (var o = 0; o < monitors.length; o++) {
    if (monitors[o].key === key || !hasDesktop(monitors[o])) continue
    var r = rectOf(monitors[o])
    var halfW = Math.round(size.width / 2), halfH = Math.round(size.height / 2)
    var xs = [r.x - size.width, r.x + r.width, r.x, r.x + r.width - size.width,
      r.x + Math.round((r.width - size.width) / 2), r.x - halfW, r.x + r.width - halfW]
    var ys = [r.y - size.height, r.y + r.height, r.y, r.y + r.height - size.height,
      r.y + Math.round((r.height - size.height) / 2), r.y - halfH, r.y + r.height - halfH]
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

// ---- Modes ------------------------------------------------------------------

// The modes a monitor offers, from Hyprland's "2560x1440@59.95Hz" strings,
// without duplicates.
function parseModes(list) {
  var modes = []
  var seen = {}
  for (var i = 0; i < (list || []).length; i++) {
    var match = /^(\d{3,5})x(\d{3,5})@(\d{1,4}(?:\.\d+)?)Hz$/.exec(clean(list[i]))
    if (!match) continue
    var mode = { width: Number(match[1]), height: Number(match[2]), refreshRate: Number(match[3]) }
    var id = mode.width + "x" + mode.height + "@" + mode.refreshRate.toFixed(2)
    if (seen[id]) continue
    seen[id] = true
    modes.push(mode)
  }
  return modes
}

// The resolutions a monitor offers, largest first. The one it runs at now is
// always among them, even when Hyprland lists no modes at all.
function resolutionOptions(monitor) {
  var modes = parseModes(monitor.modes)
  modes.push({ width: Number(monitor.width) || 0, height: Number(monitor.height) || 0 })
  var seen = {}
  var options = []
  for (var i = 0; i < modes.length; i++) {
    var id = modes[i].width + "x" + modes[i].height
    if (seen[id] || modes[i].width <= 0 || modes[i].height <= 0) continue
    seen[id] = true
    options.push({ width: modes[i].width, height: modes[i].height, label: modes[i].width + "×" + modes[i].height })
  }
  options.sort(function(a, b) { return b.width * b.height - a.width * a.height || b.width - a.width })
  return options
}

// The refresh rates offered at one resolution, fastest first. Rates that would
// read the same (59.94 and 60.00 both say "60") are kept apart by one decimal
// more.
function rateOptions(monitor, width, height) {
  var modes = parseModes(monitor.modes)
  if (Number(monitor.width) === Number(width) && Number(monitor.height) === Number(height))
    modes.push({ width: Number(width), height: Number(height), refreshRate: Number(monitor.refreshRate) || 0 })
  var rates = []
  for (var i = 0; i < modes.length; i++) {
    if (modes[i].width !== Number(width) || modes[i].height !== Number(height)) continue
    var known = false
    for (var j = 0; j < rates.length; j++) if (Math.abs(rates[j] - modes[i].refreshRate) < 0.02) known = true
    if (!known && modes[i].refreshRate > 0) rates.push(modes[i].refreshRate)
  }
  rates.sort(function(a, b) { return b - a })
  var whole = {}
  for (var k = 0; k < rates.length; k++) whole[Math.round(rates[k])] = (whole[Math.round(rates[k])] || 0) + 1
  var options = []
  for (var r = 0; r < rates.length; r++)
    options.push({
      value: rates[r],
      label: (whole[Math.round(rates[r])] > 1 ? rates[r].toFixed(2) : String(Math.round(rates[r]))) + " Hz"
    })
  return options
}

// What changing the resolution means for the rest of a monitor's settings:
// the fastest rate offered at it, and a scale it can actually run at.
function modeChange(monitor, width, height) {
  var rates = rateOptions(monitor, width, height)
  var rate = rates.length > 0 ? rates[0].value : Number(monitor.refreshRate) || 60
  // Keep the rate when the new resolution offers the same one.
  for (var i = 0; i < rates.length; i++)
    if (Math.abs(rates[i].value - Number(monitor.refreshRate)) < 0.02) rate = rates[i].value
  return { width: Number(width), height: Number(height), refreshRate: rate,
           scale: cleanScale(monitor.scale, width, height) }
}

function sameRate(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.02
}

// ---- Quick choices ----------------------------------------------------------

var QUICK_CHOICES = [
  { id: "mirror", label: "Mirror" },
  { id: "extend", label: "Extend" },
  { id: "external", label: "External only" },
  { id: "laptop", label: "Laptop only" }
]

// The monitor the others are told apart from: the laptop's own panel, or the
// first monitor on a machine without one.
function mainMonitor(monitors) {
  for (var i = 0; i < (monitors || []).length; i++) if (monitors[i].internal) return monitors[i]
  return (monitors || []).length > 0 ? monitors[0] : null
}

// The quick choices that make sense for what is connected. With one monitor
// there is nothing to choose; without a laptop panel the two that switch
// "the laptop" on or off are left out.
function quickChoices(monitors) {
  if ((monitors || []).length < 2) return []
  var main = mainMonitor(monitors)
  var choices = []
  for (var i = 0; i < QUICK_CHOICES.length; i++)
    if (main.internal || QUICK_CHOICES[i].id === "mirror" || QUICK_CHOICES[i].id === "extend") choices.push(QUICK_CHOICES[i])
  return choices
}

// The layout a quick choice stands for, as a new draft:
//   mirror    every other monitor shows what the main one shows
//   extend    every monitor has its own desktop, side by side
//   external  the laptop panel is off, the others extend
//   laptop    only the laptop panel is on
// Monitors that already have a desktop keep their place.
function quickLayout(monitors, choice) {
  var main = mainMonitor(monitors)
  if (!main || (monitors || []).length < 2) return null
  if ((choice === "external" || choice === "laptop") && !main.internal) return null
  var draft = []
  var joining = []
  for (var i = 0; i < monitors.length; i++) {
    var copy = cloneMonitor(monitors[i])
    var isMain = copy.key === main.key
    var had = hasDesktop(copy)
    copy.mirror = ""
    if (choice === "mirror") {
      copy.enabled = true
      if (!isMain) copy.mirror = main.key
    } else if (choice === "extend") {
      copy.enabled = true
    } else if (choice === "external") {
      copy.enabled = !isMain
    } else if (choice === "laptop") {
      copy.enabled = isMain
    } else {
      return null
    }
    if (hasDesktop(copy) && !had) joining.push(copy.key)
    draft.push(copy)
  }
  // Monitors that get a desktop back go to the right of those that have one.
  for (var j = 0; j < joining.length; j++) {
    var settled = []
    for (var k = 0; k < draft.length; k++)
      if (hasDesktop(draft[k]) && joining.indexOf(draft[k].key, j) === -1) settled.push(draft[k])
    var bounds = layoutBounds(settled)
    for (var t = 0; t < draft.length; t++)
      if (draft[t].key === joining[j]) { draft[t].x = bounds.x + bounds.width; draft[t].y = bounds.y }
  }
  return reflow(draft)
}

// Which quick choice the layout is, or "" when it is none of them (some
// monitors mirrored and others not, say).
function quickChoiceOf(monitors) {
  var main = mainMonitor(monitors)
  if (!main || (monitors || []).length < 2) return ""
  var others = 0, othersOn = 0, othersMirror = 0
  for (var i = 0; i < monitors.length; i++) {
    if (monitors[i].key === main.key) continue
    others++
    if (monitors[i].enabled !== false) othersOn++
    if (monitors[i].enabled !== false && monitors[i].mirror === main.key) othersMirror++
    else if (monitors[i].enabled !== false && monitors[i].mirror) return ""
  }
  var mainOn = main.enabled !== false
  if (mainOn && main.mirror) return ""
  if (mainOn && othersOn === others && othersMirror === others) return "mirror"
  if (mainOn && othersOn === others && othersMirror === 0) return "extend"
  if (!mainOn && othersOn === others && othersMirror === 0) return "external"
  if (mainOn && othersOn === 0) return "laptop"
  return ""
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
  // Nothing may go on mirroring a monitor that no longer has a picture of its
  // own to show.
  if (!hasDesktop(target))
    for (var d = 0; d < edited.length; d++) if (edited[d].mirror === key) edited[d].mirror = ""
  if (!hasDesktop(target)) return reflow(edited)

  var x = target.x
  var y = target.y
  if (changes.enabled === true || changes.mirror === "") {
    var others = []
    for (var j = 0; j < edited.length; j++)
      if (edited[j].key !== key && hasDesktop(edited[j])) others.push(edited[j])
    var bounds = layoutBounds(others)
    x = bounds.x + bounds.width
    y = bounds.y
  }
  return place(edited, key, x, y)
}

function enabledCount(monitors) {
  var count = 0
  for (var i = 0; i < (monitors || []).length; i++) if (hasDesktop(monitors[i])) count++
  return count
}

function monitorByKey(monitors, key) {
  for (var i = 0; i < (monitors || []).length; i++) if (monitors[i].key === key) return monitors[i]
  return null
}

// The number a display carries in the panel and on its identify badge: its
// place among the connected displays, counting from 1. 0 when not found.
function displayNumber(monitors, name) {
  for (var i = 0; i < (monitors || []).length; i++)
    if (monitors[i].name === name) return i + 1
  return 0
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
    if (hasDesktop(monitors[i])) enabled.push(monitors[i])
  for (var j = 0; j < enabled.length; j++)
    if (enabled[j].internal) return enabled[j].key
  return enabled.length > 0 ? enabled[0].key : ""
}

// Drop ids that point at monitors that are gone or disabled, and hand every
// unowned id to the primary monitor.
function completeWorkspaces(monitors, workspaces) {
  var enabledKeys = {}
  for (var i = 0; i < (monitors || []).length; i++)
    if (hasDesktop(monitors[i])) enabledKeys[monitors[i].key] = true

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
    if (!r || !hasDesktop(r)) continue
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
  return { version: 1, autoApply: true, selected: [], profiles: [] }
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
    if (m.enabled !== undefined && typeof m.enabled !== "boolean") return null
    if (m.internal !== undefined && typeof m.internal !== "boolean") return null
    if (m.mirror !== undefined && typeof m.mirror !== "string") return null
    keys[m.key] = true
    monitors.push({
      key: m.key,
      description: clean(m.description),
      internal: m.internal === true,
      enabled: m.enabled !== false,
      mirror: m.enabled !== false && m.mirror ? m.mirror : "",
      width: m.width, height: m.height, refreshRate: m.refreshRate,
      x: m.x, y: m.y, scale: m.scale, transform: m.transform
    })
  }
  // A mirror must show a monitor of this profile that has a picture of its
  // own: not itself, not one that is off, not another mirror.
  var desktops = 0
  for (var q = 0; q < monitors.length; q++) {
    if (hasDesktop(monitors[q])) desktops++
    if (monitors[q].mirror === "") continue
    var shown = null
    for (var t = 0; t < monitors.length; t++) if (monitors[t].key === monitors[q].mirror) shown = monitors[t]
    if (!shown || shown === monitors[q] || !hasDesktop(shown)) return null
  }
  var workspaces = {}
  if (p.workspaces !== undefined && p.workspaces !== null) {
    if (typeof p.workspaces !== "object" || Array.isArray(p.workspaces)) return null
    var assigned = {}
    for (var key in p.workspaces) {
      var ids = p.workspaces[key]
      if (!keys[key] || !Array.isArray(ids)) return null
      for (var w = 0; w < ids.length; w++) {
        if (!inRange(ids[w], 1, WORKSPACE_COUNT) || Math.round(ids[w]) !== ids[w] || assigned[ids[w]]) return null
        assigned[ids[w]] = true
      }
      workspaces[key] = ids.slice()
    }
  }
  // The fingerprint is what a profile is matched by; one that does not
  // describe the profile's own monitors would match the wrong setup.
  if (p.fingerprint !== fingerprint(monitors)) return null
  if (p.dedicated !== undefined && typeof p.dedicated !== "boolean") return null
  var dedicated = p.dedicated !== false
  return { id: p.id, name: cleanName(p.name), fingerprint: p.fingerprint, dock: dock,
           dedicated: dedicated, monitors: monitors, workspaces: dedicated ? workspaces : {} }
}

// Read the profiles file. `status` says whether the result may ever be written
// back: "missing" and "ok" may, "corrupt" and "unsupported" must not, because
// writing would destroy a file this version could not understand.
function loadStore(raw, exists) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  if (!exists) return { status: "missing", store: emptyStore(), error: "" }
  if (text.trim() === "") return { status: "corrupt", store: emptyStore(), error: "The profiles file is empty." }
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
  var selected = []
  if (Array.isArray(parsed.selected))
    for (var s = 0; s < parsed.selected.length; s++)
      if (typeof parsed.selected[s] === "string") selected.push(parsed.selected[s])
  return { status: "ok", store: makeStore({ autoApply: parsed.autoApply !== false }, profiles, selected), error: "" }
}

function profileMonitor(monitor) {
  return {
    key: monitor.key,
    description: monitor.description,
    internal: monitor.internal === true,
    enabled: monitor.enabled !== false,
    mirror: monitor.enabled !== false && monitor.mirror ? String(monitor.mirror) : "",
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

// `dedicated` is whether the profile also says which workspaces belong on
// which display. Without it only the displays themselves are arranged and the
// workspaces are left to the user's own configuration.
function makeProfile(id, name, monitors, workspaces, dock, dedicated) {
  var list = []
  for (var i = 0; i < (monitors || []).length; i++) list.push(profileMonitor(monitors[i]))
  if (dedicated === false) return {
    id: id,
    name: cleanName(name),
    fingerprint: fingerprint(monitors),
    dock: dock ? { id: dock.id, name: dock.name } : null,
    dedicated: false,
    monitors: list,
    workspaces: {}
  }
  return {
    id: id,
    name: cleanName(name),
    fingerprint: fingerprint(monitors),
    dock: dock ? { id: dock.id, name: dock.name } : null,
    dedicated: true,
    monitors: list,
    workspaces: completeWorkspaces(list, workspaces)
  }
}

function dockIdOf(holder) {
  return (holder && holder.id) || ""
}

// The profiles saved for this setup: the same monitors behind the same dock.
// There can be several (say "all screens" and "laptop only" at one desk). A
// profile from another dock never counts, so the layout of one desk is
// neither applied at another nor overwritten by saving there.
//
// Two cases cannot be told apart and fall back to the monitors alone:
// profiles saved without a dock, and a setup whose dock cannot be read right
// now. In the second case profiles from different docks would be a guess, so
// nothing is offered.
function setupProfiles(profiles, print, dock) {
  var sameSetup = []
  for (var i = 0; i < (profiles || []).length; i++)
    if (profiles[i].fingerprint === print) sameSetup.push(profiles[i])
  if (sameSetup.length === 0) return []

  var dockId = dockIdOf(dock)
  var exact = [], dockless = []
  var oneDock = true
  for (var j = 0; j < sameSetup.length; j++) {
    var savedDock = dockIdOf(sameSetup[j].dock)
    if (savedDock === dockId) exact.push(sameSetup[j])
    if (savedDock === "") dockless.push(sameSetup[j])
    if (savedDock !== dockIdOf(sameSetup[0].dock)) oneDock = false
  }
  if (exact.length > 0) return exact
  if (dockId !== "") return dockless
  return oneDock ? sameSetup : []
}

// The profile to use for this setup: the one chosen last among its profiles
// (`selected` lists the chosen profile ids), or the first one saved.
function matchProfile(profiles, print, dock, selected) {
  var candidates = setupProfiles(profiles, print, dock)
  for (var i = 0; i < candidates.length; i++)
    if ((selected || []).indexOf(candidates[i].id) !== -1) return candidates[i]
  return candidates.length > 0 ? candidates[0] : null
}

// The profiles that are this setup and nothing else: same monitors, same dock
// (or none on both sides). Saving goes by these, so a profile that only
// matched as a fallback is never overwritten from another desk.
function exactProfiles(profiles, print, dock) {
  var result = []
  for (var i = 0; i < (profiles || []).length; i++) {
    var p = profiles[i]
    if (p.fingerprint === print && dockIdOf(p.dock) === dockIdOf(dock)) result.push(p)
  }
  return result
}

function exactProfile(profiles, print, dock) {
  var all = exactProfiles(profiles, print, dock)
  return all.length > 0 ? all[0] : null
}

function makeStore(store, profiles, selected) {
  var known = {}
  for (var i = 0; i < profiles.length; i++) known[profiles[i].id] = true
  var chosen = []
  for (var j = 0; j < (selected || []).length; j++)
    if (known[selected[j]] && chosen.indexOf(selected[j]) === -1) chosen.push(selected[j])
  return { version: 1, autoApply: store.autoApply !== false, selected: chosen, profiles: profiles }
}

function upsertProfile(store, profile) {
  var profiles = []
  var replaced = false
  for (var i = 0; i < store.profiles.length; i++) {
    if (store.profiles[i].id === profile.id) { profiles.push(profile); replaced = true }
    else profiles.push(store.profiles[i])
  }
  if (!replaced) profiles.push(profile)
  return makeStore(store, profiles, store.selected)
}

function removeProfile(store, id) {
  var profiles = []
  for (var i = 0; i < store.profiles.length; i++)
    if (store.profiles[i].id !== id) profiles.push(store.profiles[i])
  return makeStore(store, profiles, store.selected)
}

// Make `id` the chosen profile of its setup. At most one profile per setup
// (same monitors, same dock) is chosen at a time.
function selectProfile(store, id) {
  var target = null
  for (var i = 0; i < store.profiles.length; i++)
    if (store.profiles[i].id === id) target = store.profiles[i]
  if (!target) return store
  var chosen = []
  for (var j = 0; j < (store.selected || []).length; j++) {
    var other = null
    for (var k = 0; k < store.profiles.length; k++)
      if (store.profiles[k].id === store.selected[j]) other = store.profiles[k]
    if (!other || other.id === id) continue
    if (other.fingerprint === target.fingerprint && dockIdOf(other.dock) === dockIdOf(target.dock)) continue
    chosen.push(other.id)
  }
  chosen.push(id)
  return makeStore(store, store.profiles, chosen)
}

// Does the live setup already look like the profile? `owners` maps workspace
// id to connector name (workspaceOwnerNames), so workspaces that have not been
// opened yet count too.
function matchesLive(profile, monitors, owners, liveWorkspaces) {
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
    if ((want.mirror || "") !== (have.mirror || "")) return false
    if (!want.mirror && (want.x !== have.x || want.y !== have.y)) return false
    if (want.width !== have.width || want.height !== have.height) return false
    if (Math.abs(num(want.refreshRate, 0) - num(have.refreshRate, 0)) > 0.1) return false
    if (Math.abs(want.scale - have.scale) > 0.011) return false
    if (want.transform !== have.transform) return false
  }
  if (owners && profile.dedicated !== false) {
    var wanted = completeWorkspaces(present, profile.workspaces)
    for (var key in wanted) {
      for (var w = 0; w < wanted[key].length; w++)
        if (owners[wanted[key][w]] !== live[key].name) return false
    }
    // A workspace that was moved by hand sits somewhere its rule does not say.
    for (var l = 0; l < (liveWorkspaces || []).length; l++) {
      var ws = liveWorkspaces[l]
      var ownerKey = ws.id <= WORKSPACE_COUNT ? workspaceOwner(wanted, ws.id) : ""
      if (ownerKey !== "" && live[ownerKey].name !== ws.monitor) return false
    }
  }
  return true
}

// Would applying `wanted` change any monitor's own settings, as opposed to
// only moving workspaces? Those are the changes that can leave a screen dark,
// so they are the ones that ask for confirmation.
// Moving a screen cannot leave anyone without a picture, so positions are not
// part of this: only a change that could black a screen out counts.
function changesMonitors(wanted, monitors) {
  var live = {}
  for (var i = 0; i < (monitors || []).length; i++) live[monitors[i].key] = monitors[i]
  for (var j = 0; j < (wanted || []).length; j++) {
    var want = wanted[j]
    var have = live[want.key]
    if (!have) continue
    if ((want.enabled !== false) !== (have.enabled !== false)) return true
    if (want.enabled === false) continue
    if ((want.mirror || "") !== (have.mirror || "")) return true
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
  var mirrors = []
  var disables = []
  var skipped = []
  var enabledNames = {}
  var enabledCount = 0
  for (var j = 0; j < ((profile && profile.monitors) || []).length; j++) {
    var m = profile.monitors[j]
    if (m && hasDesktop(m) && nameByKey[m.key]) enabledCount++
  }
  // Never apply a profile that would turn every connected screen off.
  if (enabledCount === 0) return { lua: "", skipped: [], plain: false }

  for (var k = 0; k < profile.monitors.length; k++) {
    var want = profile.monitors[k]
    if (!want) continue
    var name = nameByKey[want.key]
    if (!name) { skipped.push(want.description || want.key); continue }
    if (want.enabled === false) {
      disables.push('hl.monitor({ output = "' + name + '", disabled = true })')
      continue
    }
    var width = Math.round(num(want.width, 0))
    var height = Math.round(num(want.height, 0))
    var mode = width > 0 && height > 0
      ? width + "x" + height + "@" + luaNumber(want.refreshRate, 60, 3)
      : "preferred"
    // A rule set through eval updates the one already there, so what is not
    // said stays as it was: "on" and "not a mirror" have to be said outright.
    var settings = 'mode = "' + mode + '", scale = ' + luaNumber(want.scale, 1, 6)
      + ", transform = " + Math.round(num(want.transform, 0)) % 8 + ", disabled = false"
    var shown = want.mirror ? nameByKey[want.mirror] : ""
    var source = null
    for (var s2 = 0; s2 < profile.monitors.length; s2++)
      if (profile.monitors[s2] && profile.monitors[s2].key === want.mirror) source = profile.monitors[s2]
    if (shown && hasDesktop(source)) {
      mirrors.push('hl.monitor({ output = "' + name + '", ' + settings + ', position = "auto", mirror = "' + shown + '" })')
      continue
    }
    // A mirror whose source is not connected shows its own desktop instead.
    enabledNames[want.key] = name
    lines.push('hl.monitor({ output = "' + name + '", ' + settings + ', position = "'
      + Math.round(num(want.x, 0)) + "x" + Math.round(num(want.y, 0)) + '", mirror = "" })')
  }

  // Desktops first, then the screens that mirror them, and screens are
  // switched off last, so a failure part way through leaves more screens lit
  // rather than fewer.
  lines = lines.concat(mirrors).concat(disables)
  // Ownership is recorded before the first change, so that a chunk failing
  // part way through still leaves something for the release to find.
  lines.unshift('__display_profiles_owner = "' + (SAFE_NAME.test(clean(owner)) ? clean(owner) : "") + '"')

  // Every apply issues a rule for each of the workspaces 1..WORKSPACE_COUNT,
  // and Hyprland updates an existing rule for the same workspace in place. So
  // nothing has to be switched off first, and repeated applies do not pile up
  // dead rules. The handles are kept only to mark that this plugin has state
  // in Hyprland.
  lines.push("__display_profiles_rules = {}")
  // A profile without dedicated workspaces arranges the displays and leaves
  // the workspaces to the user's own rules. `plain` tells the caller that
  // rules an earlier layout left behind have to be cleared first.
  if (profile.dedicated === false) return { lua: lines.join("\n"), skipped: skipped, plain: true }
  // Set before the first rule, so a chunk failing part way still says so.
  lines.push("__display_profiles_has_rules = true")

  // Workspaces of a monitor that is off or not connected go to the primary
  // rather than being left without a rule.
  var present = []
  for (var p = 0; p < profile.monitors.length; p++) {
    if (!profile.monitors[p]) continue
    var candidate = cloneMonitor(profile.monitors[p])
    if (!enabledNames[candidate.key]) candidate.enabled = false
    else candidate.mirror = ""
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

  return { lua: lines.concat(moves).join("\n"), skipped: skipped, plain: false }
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
// A chunk that fails, with RULES_MARK in its message, when workspace rules
// from a layout with dedicated workspaces are in Hyprland. The answer lives in
// Hyprland's own Lua state, so it is right after a shell restart too.
var RULES_MARK = "DISPLAY_PROFILES_RULES"
var RULES_CHECK = 'if __display_profiles_has_rules then error("' + RULES_MARK + '") end'

function buildReleaseLua(owner) {
  var token = clean(owner)
  if (token !== "" && !SAFE_NAME.test(token)) return ""
  return [
    token === "" ? "if __display_profiles_owner ~= nil then"
                 : 'if __display_profiles_owner == "' + token + '" then',
    "__display_profiles_rules = nil",
    "__display_profiles_has_rules = nil",
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
    anyAwake: anyAwake,
    exactProfile: exactProfile,
    exactProfiles: exactProfiles,
    setupProfiles: setupProfiles,
    selectProfile: selectProfile,
    touching: touching,
    reflow: reflow,
    landing: landing,
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
    RULES_MARK: RULES_MARK,
    RULES_CHECK: RULES_CHECK,
    cleanScale: cleanScale,
    scaleOptions: scaleOptions,
    parseModes: parseModes,
    resolutionOptions: resolutionOptions,
    rateOptions: rateOptions,
    modeChange: modeChange,
    sameRate: sameRate,
    sameScale: sameScale,
    editMonitor: editMonitor,
    enabledCount: enabledCount,
    monitorByKey: monitorByKey,
    shortName: shortName,
    displayNumber: displayNumber,
    hasDesktop: hasDesktop,
    quickChoices: quickChoices,
    quickLayout: quickLayout,
    quickChoiceOf: quickChoiceOf,
    mainMonitor: mainMonitor,
    workspaceOwnerNames: workspaceOwnerNames,
    stripIds: stripIds,
    workspaceRuns: workspaceRuns
  }
}
