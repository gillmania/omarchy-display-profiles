const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

function hyprMonitors(list) {
  return JSON.stringify(list.map((m) => ({
    name: m.name,
    description: [m.make, m.model, m.serial].filter(Boolean).join(" "),
    make: m.make,
    model: m.model,
    serial: m.serial || "",
    width: m.width,
    height: m.height,
    refreshRate: m.refreshRate || 60,
    x: m.x || 0,
    y: m.y || 0,
    scale: m.scale || 1,
    transform: m.transform || 0,
    disabled: m.disabled === true,
    availableModes: [],
    activeWorkspace: { id: 1 }
  })))
}

const LAPTOP = { name: "eDP-1", make: "AU Optronics", model: "0xA48F", width: 1920, height: 1080, scale: 1.25 }
const DELL_A = { name: "DP-7", make: "Dell Inc.", model: "DELL U2715H", serial: "AAA", width: 2560, height: 1440, x: 1536 }
const DELL_B = { name: "DP-8", make: "Dell Inc.", model: "DELL U2715H", serial: "BBB", width: 2560, height: 1440, x: 4096 }

function docked() {
  return Model.parseMonitors(hyprMonitors([LAPTOP, DELL_A, DELL_B]))
}

test("a monitor keeps its key when its connector name changes", () => {
  const before = Model.parseMonitors(hyprMonitors([DELL_A]))[0]
  const after = Model.parseMonitors(hyprMonitors([{ ...DELL_A, name: "DP-5" }]))[0]
  assert.equal(before.key, after.key)
})

test("serial-less panels are told apart by connector", () => {
  const a = Model.monitorKey({ name: "eDP-1", make: "BOE", model: "X" })
  const b = Model.monitorKey({ name: "DP-1", make: "BOE", model: "X" })
  assert.notEqual(a, b)
})

test("the fingerprint ignores connector order and replug renames", () => {
  const one = Model.fingerprint(docked())
  const two = Model.fingerprint(Model.parseMonitors(hyprMonitors([
    { ...DELL_B, name: "DP-5" }, LAPTOP, { ...DELL_A, name: "DP-6" }
  ])))
  assert.equal(one, two)
  assert.notEqual(one, Model.fingerprint(Model.parseMonitors(hyprMonitors([LAPTOP]))))
})

test("malformed monitor JSON yields no monitors", () => {
  assert.deepEqual(Model.parseMonitors("not json"), [])
  assert.deepEqual(Model.parseMonitors("{}"), [])
  assert.deepEqual(Model.parseMonitors(""), [])
})

test("the dock is the first thunderbolt device with a name", () => {
  const raw = "a01a\t\t\ndfd8\tHP\tThunderbolt Dock G4\n"
  assert.deepEqual(Model.parseDock(raw), { id: "dfd8", name: "HP Thunderbolt Dock G4" })
  assert.equal(Model.parseDock("a01a\t\t\n"), null)
  assert.equal(Model.parseDock(""), null)
})

test("logical size follows scale and rotation", () => {
  assert.deepEqual(Model.logicalSize({ width: 1920, height: 1080, scale: 1.25, transform: 0 }), { width: 1536, height: 864 })
  assert.deepEqual(Model.logicalSize({ width: 2560, height: 1440, scale: 1, transform: 1 }), { width: 1440, height: 2560 })
})

test("placing a monitor lands it touching a neighbour without overlap", () => {
  const monitors = docked()
  // Drop the laptop roughly underneath the first Dell.
  const placed = Model.place(monitors, monitors[0].key, 2000, 1500)
  const byKey = Object.fromEntries(placed.map((m) => [m.key, m]))
  const laptop = Model.rectOf(byKey[monitors[0].key])
  const dell = Model.rectOf(byKey[monitors[1].key])
  assert.equal(laptop.y, dell.y + dell.height)
  for (const a of placed) for (const b of placed)
    if (a !== b) assert.equal(Model.overlaps(Model.rectOf(a), Model.rectOf(b)), false)
  const bounds = Model.layoutBounds(placed)
  assert.equal(bounds.x, 0)
  assert.equal(bounds.y, 0)
})

test("a drop on top of another monitor is pushed to a free edge", () => {
  const monitors = docked()
  const placed = Model.place(monitors, monitors[2].key, monitors[1].x + 10, 10)
  for (const a of placed) for (const b of placed)
    if (a !== b) assert.equal(Model.overlaps(Model.rectOf(a), Model.rectOf(b)), false)
})

test("a single monitor is placed at the origin", () => {
  const monitors = Model.parseMonitors(hyprMonitors([LAPTOP]))
  const placed = Model.place(monitors, monitors[0].key, 500, 300)
  assert.equal(placed[0].x, 0)
  assert.equal(placed[0].y, 0)
})

test("every workspace has exactly one owner", () => {
  const monitors = docked()
  const [laptop, a, b] = monitors.map((m) => m.key)
  let ws = Model.completeWorkspaces(monitors, { [a]: [5, 6], [b]: [7, 8] })
  assert.deepEqual(ws[laptop], [1, 2, 3, 4, 9, 10])
  ws = Model.assignWorkspace(monitors, ws, 4, a)
  assert.deepEqual(ws[a], [4, 5, 6])
  assert.deepEqual(ws[laptop], [1, 2, 3, 9, 10])
  const all = Object.values(ws).flat().sort((x, y) => x - y)
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test("workspaces owned by a disabled monitor fall back to the primary", () => {
  const monitors = docked()
  monitors[2].enabled = false
  const ws = Model.completeWorkspaces(monitors, { [monitors[2].key]: [7, 8] })
  assert.equal(ws[monitors[2].key], undefined)
  assert.ok(ws[monitors[0].key].includes(7))
})

test("a profile matches only the monitors and dock it was saved on", () => {
  const monitors = docked()
  const print = Model.fingerprint(monitors)
  const home = Model.makeProfile("p1", "Home", monitors, {}, { id: "dock-home", name: "Home dock" })
  const work = Model.makeProfile("p2", "Work", monitors, {}, { id: "dock-work", name: "Work dock" })
  assert.equal(Model.matchProfile([home, work], print, { id: "dock-work" }).id, "p2")
  assert.equal(Model.matchProfile([home, work], print, { id: "dock-home" }).id, "p1")
  // Another dock is another desk, even with a single saved profile: matching
  // it would apply Home's layout at Work and let a save there overwrite Home.
  assert.equal(Model.matchProfile([home, work], print, { id: "other" }), null)
  assert.equal(Model.matchProfile([home], print, { id: "dock-work" }), null)
  // A dock that cannot be read right now: one candidate is taken, two are not.
  assert.equal(Model.matchProfile([home], print, null).id, "p1")
  assert.equal(Model.matchProfile([home, work], print, null), null)
  // A profile saved without a dock matches the monitors wherever they are.
  const plain = Model.makeProfile("p3", "Plain", monitors, {}, null)
  assert.equal(Model.matchProfile([plain], print, { id: "dock-work" }).id, "p3")
  assert.equal(Model.matchProfile([plain, work], print, { id: "dock-work" }).id, "p2")
  assert.equal(Model.matchProfile([home], "something else", null), null)
})

test("saving at a second dock adds a profile instead of replacing the first", () => {
  const monitors = docked()
  const print = Model.fingerprint(monitors)
  let store = Model.upsertProfile(Model.emptyStore(),
    Model.makeProfile("p1", "Home", monitors, {}, { id: "dock-home", name: "Home dock" }))
  const workDock = { id: "dock-work", name: "Work dock" }
  const existing = Model.matchProfile(store.profiles, print, workDock)
  const id = existing ? existing.id : Model.newId(store.profiles)
  store = Model.upsertProfile(store, Model.makeProfile(id, "Work", monitors, {}, workDock))
  assert.deepEqual(store.profiles.map((p) => p.name), ["Home", "Work"])
})

test("the store survives a round trip", () => {
  const monitors = docked()
  let store = Model.emptyStore()
  store = Model.upsertProfile(store, Model.makeProfile("p1", "Home", monitors, {}, null))
  store = Model.upsertProfile(store, Model.makeProfile("p1", "Home renamed", monitors, {}, null))
  assert.equal(store.profiles.length, 1)
  assert.equal(store.profiles[0].name, "Home renamed")
  const reread = Model.loadStore(JSON.stringify(store), true)
  assert.equal(reread.status, "ok")
  assert.deepEqual(reread.store, store)
  assert.equal(Model.removeProfile(store, "p1").profiles.length, 0)
})

test("a store that cannot be understood is reported, never treated as empty", () => {
  assert.equal(Model.loadStore("", false).status, "missing")
  assert.equal(Model.loadStore("  \n", true).status, "missing")
  assert.equal(Model.loadStore("{broken", true).status, "corrupt")
  assert.equal(Model.loadStore("[]", true).status, "corrupt")
  assert.equal(Model.loadStore('{"version":2,"profiles":[]}', true).status, "unsupported")
  assert.equal(Model.loadStore('{"version":1,"profiles":[]}', true).status, "ok")
  const good = Model.makeProfile("p1", "Home", docked(), {}, null)
  const broken = (change) => {
    const copy = JSON.parse(JSON.stringify(good))
    change(copy)
    return Model.loadStore(JSON.stringify({ version: 1, profiles: [copy] }), true).status
  }
  assert.equal(broken(() => {}), "ok")
  assert.equal(broken((p) => { p.monitors = [null] }), "corrupt")
  assert.equal(broken((p) => { p.monitors = [] }), "corrupt")
  assert.equal(broken((p) => { p.monitors[0].scale = 0 }), "corrupt")
  assert.equal(broken((p) => { p.monitors[0].x = "12" }), "corrupt")
  assert.equal(broken((p) => { p.monitors[0].transform = 9 }), "corrupt")
  assert.equal(broken((p) => { p.monitors[1].key = p.monitors[0].key }), "corrupt")
  assert.equal(broken((p) => { p.workspaces = { a: [11] } }), "corrupt")
  assert.equal(broken((p) => { p.id = 'x"; os.exit()' }), "corrupt")
  const twice = JSON.stringify({ version: 1, profiles: [good, good] })
  assert.equal(Model.loadStore(twice, true).status, "corrupt")
})

test("profile names are trimmed to a length the panel can show", () => {
  const profile = Model.makeProfile("p1", "  A   very " + "long ".repeat(30), docked(), {}, null)
  assert.ok(profile.name.length <= 48)
  assert.ok(profile.name.startsWith("A very long"))
  assert.equal(Model.shorten("Thunderbolt Dock G4 at home", 12).length, 12)
})


test("names are suggested from the dock and kept unique", () => {
  const monitors = docked()
  const dock = { id: "x", name: "HP Thunderbolt Dock G4" }
  assert.equal(Model.suggestName(monitors, dock, []), "HP Thunderbolt Dock G4")
  assert.equal(Model.suggestName(monitors, dock, [{ name: "HP Thunderbolt Dock G4" }]), "HP Thunderbolt Dock G4 2")
  assert.equal(Model.suggestName(Model.parseMonitors(hyprMonitors([LAPTOP])), null, []), "Laptop only")
  assert.equal(Model.suggestName(monitors, null, []), "2 external displays")
})

test("the apply chunk addresses monitors by their current connector", () => {
  const monitors = docked()
  const profile = Model.makeProfile("p1", "Home", monitors, { [monitors[1].key]: [5, 6] }, null)
  // Replug: the Dells come back under new names.
  const replugged = Model.parseMonitors(hyprMonitors([LAPTOP, { ...DELL_A, name: "DP-5" }, { ...DELL_B, name: "DP-6" }]))
  const { lua, skipped } = Model.buildApplyLua(profile, replugged)
  assert.deepEqual(skipped, [])
  assert.match(lua, /hl\.monitor\(\{ output = "DP-5", mode = "2560x1440@60", position = "1536x0", scale = 1, transform = 0 \}\)/)
  assert.match(lua, /workspace = "5", monitor = "DP-5", default = true/)
  assert.match(lua, /workspace = "6", monitor = "DP-5", default = false/)
  assert.match(lua, /hl\.dsp\.workspace\.move\(\{ workspace = 5, monitor = "DP-5" \}\)/)
  assert.doesNotMatch(lua, /DP-7/)
})

test("monitors missing from the live setup are skipped, not guessed", () => {
  const monitors = docked()
  const profile = Model.makeProfile("p1", "Home", monitors, { [monitors[2].key]: [7, 8] }, null)
  const { lua, skipped } = Model.buildApplyLua(profile, Model.parseMonitors(hyprMonitors([LAPTOP, DELL_A])))
  assert.equal(skipped.length, 1)
  assert.doesNotMatch(lua, /DP-8/)
  // The orphaned workspaces go to the primary instead of being left unruled.
  assert.match(lua, /workspace = "7", monitor = "eDP-1"/)
})

test("unsafe connector names never reach the Lua chunk", () => {
  const evil = { ...DELL_A, name: 'DP-7" }) os.execute("id") --' }
  const monitors = Model.parseMonitors(hyprMonitors([LAPTOP, evil]))
  const profile = Model.makeProfile("p1", "Evil", monitors, {}, null)
  const { lua } = Model.buildApplyLua(profile, monitors)
  assert.doesNotMatch(lua, /os\.execute/)
  assert.match(lua, /output = "eDP-1"/)
})

test("hostile numbers in a profile file are neutralised", () => {
  const monitors = Model.parseMonitors(hyprMonitors([LAPTOP]))
  const profile = Model.makeProfile("p1", "Edited", monitors, {}, null)
  profile.monitors[0].scale = '1 }) os.execute("id") --'
  profile.monitors[0].x = "0x0\" }) os.execute(\"id\")"
  profile.workspaces[monitors[0].key] = ['1" }) os.execute("id") --']
  const { lua } = Model.buildApplyLua(profile, monitors)
  assert.doesNotMatch(lua, /os\.execute/)
})

test("a profile that would switch every screen off is not applied", () => {
  const monitors = Model.parseMonitors(hyprMonitors([LAPTOP]))
  const profile = Model.makeProfile("p1", "Dark", monitors, {}, null)
  profile.monitors[0].enabled = false
  assert.equal(Model.buildApplyLua(profile, monitors).lua, "")
})

test("a disabled monitor is switched off and loses its workspaces", () => {
  const monitors = docked()
  monitors[2].enabled = false
  const profile = Model.makeProfile("p1", "One Dell", monitors, { [monitors[2].key]: [7, 8] }, null)
  const { lua } = Model.buildApplyLua(profile, docked())
  assert.match(lua, /hl\.monitor\(\{ output = "DP-8", disabled = true \}\)/)
  assert.doesNotMatch(lua, /monitor = "DP-8"/)
})

test("matchesLive tells an applied profile from a drifted one", () => {
  const monitors = docked()
  const profile = Model.makeProfile("p1", "Home", monitors, {}, null)
  const owners = {}
  for (let id = 1; id <= 10; id++) owners[id] = "eDP-1"
  assert.equal(Model.matchesLive(profile, monitors, owners), true)
  const moved = docked()
  moved[1].x += 100
  assert.equal(Model.matchesLive(profile, moved, owners), false)
  // A workspace that is headed for another monitor counts even if unopened.
  assert.equal(Model.matchesLive(profile, monitors, Object.assign({}, owners, { 5: "DP-7" })), false)
  const slower = docked()
  slower[1].refreshRate = 30
  assert.equal(Model.matchesLive(profile, slower, owners), false)
})

test("only changes to a monitor's own settings ask for confirmation", () => {
  const live = docked()
  assert.equal(Model.changesMonitors(docked(), live), false)
  const off = docked()
  off[1].enabled = false
  assert.equal(Model.changesMonitors(off, live), true)
  const scaled = docked()
  scaled[0].scale = 1
  assert.equal(Model.changesMonitors(scaled, live), true)
})

test("monitors that report the same identity are kept apart", () => {
  const twins = Model.parseMonitors(hyprMonitors([LAPTOP,
    Object.assign({}, DELL_A, { name: "DP-3" }), Object.assign({}, DELL_A, { name: "DP-4", x: 4096 })]))
  assert.notEqual(twins[1].key, twins[2].key)
  assert.equal(Model.fingerprint(twins).split(" + ").length, 3)
})

test("topology changes when connectors are renumbered or the dock changes", () => {
  const before = docked()
  const after = docked()
  after[1].name = "DP-9"
  assert.equal(Model.fingerprint(before), Model.fingerprint(after))
  assert.notEqual(Model.topology(before, null), Model.topology(after, null))
  assert.notEqual(Model.topology(before, { id: "a" }), Model.topology(before, { id: "b" }))
})

test("switching off or moving the middle monitor leaves no gap", () => {
  const row = Model.normalize(docked())
  assert.equal(Object.keys(Model.connectedKeys(row)).length, 3)
  const withoutMiddle = Model.editMonitor(row, row[1].key, { enabled: false })
  assert.equal(Object.keys(Model.connectedKeys(withoutMiddle)).length, 2)
  const a = Model.rectOf(withoutMiddle[0]), b = Model.rectOf(withoutMiddle[2])
  assert.equal(Model.overlaps(a, b), false)
  const moved = Model.place(row, row[1].key, 0, -5000)
  assert.equal(Object.keys(Model.connectedKeys(moved)).length, 3)
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
    assert.equal(Model.overlaps(Model.rectOf(moved[i]), Model.rectOf(moved[j])), false)
  // A layout that is already connected is left exactly as it is.
  const offset = Model.normalize(docked())
  offset[1].y = 100
  assert.deepEqual(Model.reflow(offset), Model.normalize(offset))
})

test("screens are switched on before any is switched off, and release is owner-bound", () => {
  const monitors = docked()
  const profile = Model.makeProfile("p1", "Home", monitors, {}, null)
  profile.monitors[0].enabled = false
  const lua = Model.buildApplyLua(profile, monitors, "abc123").lua
  assert.ok(lua.indexOf('output = "DP-7", mode') < lua.indexOf("disabled = true"))
  assert.match(lua, /__display_profiles_owner = "abc123"/)
  assert.match(Model.buildReleaseLua("abc123"), /^if __display_profiles_owner == "abc123" then/)
  assert.match(Model.buildReleaseLua("abc123"), /hyprctl reload/)
  assert.equal(Model.buildReleaseLua('x" then os.exit() --'), "")
  assert.match(Model.buildReleaseLua(), /^if __display_profiles_owner ~= nil then/)
  // Rules are updated in place, so an apply never has to disable old ones.
  assert.doesNotMatch(lua, /set_enabled/)
  // A null entry in a hand-built layout must not throw.
  const holed = { monitors: [null].concat(profile.monitors), workspaces: {} }
  assert.doesNotThrow(() => Model.buildApplyLua(holed, monitors, "abc123"))
})

test("scale options are the distinct scales a mode can run at", () => {
  // 2560x1440 cannot run at 1.5 or 3; the options show what Hyprland will use.
  assert.deepEqual(Model.scaleOptions(2560, 1440).map((o) => o.label), ["1", "1.25", "1.6", "2", "3.2"])
  assert.deepEqual(Model.scaleOptions(1920, 1080).map((o) => o.label), ["1", "1.25", "1.5", "2", "3"])
  for (const o of Model.scaleOptions(1920, 515))
    assert.equal(Model.cleanScale(o.value, 1920, 515), o.value)
})

test("editing a monitor keeps the layout free of overlaps", () => {
  const monitors = docked()
  // Rotating the middle Dell makes it narrower and taller.
  const rotated = Model.editMonitor(monitors, monitors[1].key, { transform: 1 })
  for (const a of rotated) for (const b of rotated)
    if (a !== b) assert.equal(Model.overlaps(Model.rectOf(a), Model.rectOf(b)), false)
  assert.equal(Model.monitorByKey(rotated, monitors[1].key).transform, 1)
})

test("re-enabling a monitor puts it beside the others", () => {
  const monitors = docked()
  const off = Model.editMonitor(monitors, monitors[2].key, { enabled: false })
  assert.equal(Model.enabledCount(off), 2)
  const on = Model.editMonitor(off, monitors[2].key, { enabled: true })
  assert.equal(Model.enabledCount(on), 3)
  for (const a of on) for (const b of on)
    if (a !== b) assert.equal(Model.overlaps(Model.rectOf(a), Model.rectOf(b)), false)
})

test("a new profile starts from the workspace rules already in force", () => {
  const monitors = docked()
  const rules = Model.parseWorkspaceRules(JSON.stringify([
    { workspaceString: "5", enabled: true, monitor: "DP-7" },
    { workspaceString: "6", enabled: true, monitor: "DP-7" },
    { workspaceString: "7", enabled: true, monitor: "desc:Dell Inc. DELL U2715H BBB" },
    { workspaceString: "8", enabled: false, monitor: "DP-8" },
    { workspaceString: "special:scratch", enabled: true, monitor: "DP-8" },
    { workspaceString: "2", enabled: true, monitor: "HDMI-A-9" }
  ]))
  assert.equal(rules.length, 4)
  // Workspace 5 has never been opened and 6 was dragged to the laptop: the
  // rules still say both belong to the first Dell.
  const live = [{ id: 6, monitor: "eDP-1" }, { id: 3, monitor: "DP-8" }]
  const ws = Model.workspacesFromLive(monitors, live, rules)
  assert.deepEqual(ws[monitors[1].key], [5, 6])
  assert.deepEqual(ws[monitors[2].key], [3, 7])
  // A rule for a monitor that is not connected leaves the workspace to the primary.
  assert.ok(ws[monitors[0].key].includes(2))
  assert.ok(ws[monitors[0].key].includes(8))
})

test("workspace strip: owners include workspaces that are not open yet", () => {
  const monitors = docked()
  const rules = JSON.stringify([
    { workspaceString: "5", monitor: "DP-7" },
    { workspaceString: "6", monitor: "DP-7" },
    { workspaceString: "7", monitor: "DP-8" }
  ])
  const owners = Model.workspaceOwnerNames(monitors, [{ id: 1, monitor: "eDP-1" }], Model.parseWorkspaceRules(rules))
  assert.equal(owners[1], "eDP-1")
  assert.equal(owners[6], "DP-7")
  assert.equal(owners[7], "DP-8")
  assert.equal(owners[10], "eDP-1")
})

test("workspace strip: lists the first five plus whatever else exists", () => {
  assert.deepEqual(Model.stripIds([7, 2, 7, -98, 11, 9]), [1, 2, 3, 4, 5, 7, 9])
})

test("workspace strip: neighbours on one display form a run, live position wins", () => {
  const planned = { 1: "eDP-1", 2: "eDP-1", 3: "eDP-1", 4: "eDP-1", 5: "DP-7", 6: "DP-7", 7: "DP-8" }
  assert.deepEqual(Model.workspaceRuns([1, 2, 3, 4, 5, 7], {}, planned), [
    { monitor: "eDP-1", ids: [1, 2, 3, 4] },
    { monitor: "DP-7", ids: [5] },
    { monitor: "DP-8", ids: [7] }
  ])
  // Workspace 3 was moved to the Dell by hand: the strip shows where it is.
  assert.deepEqual(Model.workspaceRuns([1, 2, 3, 4], { 3: "DP-7" }, planned), [
    { monitor: "eDP-1", ids: [1, 2] },
    { monitor: "DP-7", ids: [3] },
    { monitor: "eDP-1", ids: [4] }
  ])
  // Without any owner information everything is one unmarked run.
  assert.deepEqual(Model.workspaceRuns([1, 2], null, null), [{ monitor: "", ids: [1, 2] }])
})
