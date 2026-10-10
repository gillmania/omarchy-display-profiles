import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The Display Setups panel: a draggable map of the monitors, per-monitor
// settings, workspace assignment, and the saved profiles.
//
// Edits are made to a draft and only reach Hyprland on Apply or Save, so a
// half-finished drag never rearranges the screens being looked at.
Panel {
  id: root
  moduleName: "io.github.gillmania.display-setups"
  manageIpc: false

  property var anchorItem: null
  // The bar identifies a panel by the widget mounted in its slot.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  property var service: null

  // ---- Draft ----
  property var draft: []
  property var draftWorkspaces: ({})
  // Whether the layout also says which workspaces belong on which display.
  property bool draftDedicated: false
  // Whether the map and the per-display controls are shown.
  property bool arranging: false
  property string selectedKey: ""
  property bool dirty: false
  // The topology the draft was made for. Apply and Save hand it to the
  // service, which refuses a draft made for other screens.
  property string draftTopology: ""

  // ---- Naming (new profile or rename) ----
  property bool naming: false
  property string renamingId: ""

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.5)
  readonly property string fontFamily: bar && bar.fontFamily ? bar.fontFamily : Style.font.family

  readonly property bool serviceReady: service !== null && service.ready === true
  readonly property var activeProfile: serviceReady ? service.activeProfile : null
  readonly property var profiles: serviceReady ? service.profiles : []
  readonly property var selected: Model.monitorByKey(draft, selectedKey)
  readonly property bool confirming: serviceReady && service.confirmPending === true
  readonly property bool storeBroken: serviceReady
    && (service.storeState === "corrupt" || service.storeState === "unsupported")
  readonly property string statusLine: {
    if (!serviceReady) return "LOADING"
    if (confirming) return "KEEP THIS LAYOUT?"
    if (service.applyState === "failed") return "APPLY FAILED"
    if (dirty) return "UNSAVED CHANGES"
    if (!activeProfile) return "NEW SETUP · NOT SAVED"
    return service.inSync ? "ACTIVE" : "SAVED · NOT APPLIED"
  }

  function loadDraft() {
    if (!serviceReady) return
    draft = Model.withPolicies(Model.normalize(JSON.parse(JSON.stringify(service.monitors))), service.policySource)
    draftWorkspaces = activeProfile
      ? Model.completeWorkspaces(draft, activeProfile.workspaces)
      : Model.workspacesFromLive(draft, service.workspaces, service.workspaceRules)
    draftDedicated = activeProfile ? activeProfile.dedicated !== false : false
    draftTopology = service.topology
    dirty = false
    if (!Model.monitorByKey(draft, selectedKey)) {
      selectedKey = ""
      for (var i = 0; i < draft.length; i++)
        if (draft[i].focused) selectedKey = draft[i].key
      if (selectedKey === "" && draft.length > 0) selectedKey = draft[0].key
    }
  }

  // While a layout waits to be confirmed the draft is frozen: what gets kept
  // (and saved) is the layout that was sent, not something edited since.
  function edit(key, changes) {
    if (confirming) return
    // At least one screen has to keep a desktop of its own.
    var next = Model.editMonitor(draft, key, changes)
    if (Model.enabledCount(next) < 1) return
    draft = next
    draftWorkspaces = Model.completeWorkspaces(draft, draftWorkspaces)
    dirty = true
  }

  function moveTo(key, x, y, tolerance) {
    // Assigning the draft again snaps a tile dragged meanwhile back in place.
    if (confirming) { draft = draft.slice(); return }
    draft = Model.place(draft, key, x, y, tolerance)
    dirty = true
  }

  function setDedicated(on) {
    if (confirming || draftDedicated === on) return
    draftDedicated = on
    dirty = true
  }

  function assign(id) {
    // A display that is off or mirrors another has no desktop to put them on.
    if (confirming || !draftDedicated || !Model.hasDesktop(selected)) return
    draftWorkspaces = Model.assignWorkspace(draft, draftWorkspaces, id, selectedKey)
    draftWorkspaces = Model.completeWorkspaces(draft, draftWorkspaces)
    dirty = true
  }

  function cycleSelection(delta) {
    if (draft.length === 0) return
    var index = 0
    for (var i = 0; i < draft.length; i++) if (draft[i].key === selectedKey) index = i
    selectedKey = draft[(index + delta + draft.length) % draft.length].key
  }

  // One of the quick choices (mirror, extend, external only, laptop only). It
  // is tried at once, like pressing Apply.
  function quick(choice) {
    if (confirming || !serviceReady) return
    var next = Model.quickLayout(draft, choice)
    if (!next || Model.enabledCount(next) < 1) return
    draft = next
    draftWorkspaces = Model.completeWorkspaces(draft, draftWorkspaces)
    dirty = true
    applyDraft()
  }

  // "" for a desktop of its own, or the key of the display to show.
  function setMirror(value) {
    if (!selected) return
    edit(selectedKey, { mirror: String(value), enabled: true })
  }

  function setResolution(value) {
    var parts = String(value).split("x")
    if (!selected || parts.length !== 2) return
    edit(selectedKey, Model.modeChange(selected, Number(parts[0]), Number(parts[1])))
  }

  function setRate(value) {
    if (selected && Number(value) > 0) edit(selectedKey, { refreshRate: Number(value) })
  }

  function rotateSelected() {
    if (selected) edit(selectedKey, { transform: (Number(selected.transform) + 1) % 4 })
  }

  function applyDraft() {
    if (!serviceReady || confirming) return
    service.applyDraft(draft, draftWorkspaces, draftTopology, draftDedicated)
  }

  // Saved at once when only workspaces changed; otherwise the service waits
  // for the layout to be confirmed, and the draft stays unsaved until then.
  function saveAs(name, targetId) {
    if (!serviceReady || confirming) return
    var id = service.saveProfile(name, draft, draftWorkspaces, draftTopology, targetId, draftDedicated)
    if (id !== "" && !service.confirmPending) dirty = false
  }

  function save() {
    if (!serviceReady || confirming) return
    if (!activeProfile) { startNaming("") ; return }
    saveAs("", activeProfile.id)
  }

  function startNaming(profileId) {
    if (confirming) return
    renamingId = profileId
    var existing = profileId !== "" ? service.findProfile(profileId) : null
    nameField.text = existing ? existing.name : Model.suggestName(draft, service.dock, profiles)
    naming = true
    nameField.forceActiveFocus()
    nameField.selectAll()
  }

  function confirmNaming() {
    if (!naming) return
    if (renamingId !== "") service.renameProfile(renamingId, nameField.text)
    else saveAs(nameField.text, "")
    cancelNaming()
  }

  function cancelNaming() {
    naming = false
    renamingId = ""
    keyCatcher.forceActiveFocus()
  }

  function open() {
    if (service) service.refresh()
    loadDraft()
    // With a single display there is nothing quick to choose between.
    if (draft.length < 2 && profiles.length === 0) arranging = true
    root.controller.show()
  }

  function close() {
    if (naming) cancelNaming()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  onServiceReadyChanged: if (serviceReady && draft.length === 0) loadDraft()

  // Follow the live setup while nothing is being edited, and always when the
  // screens themselves change: a draft for screens that are gone is moot.
  // `generation` is bumped once per reading, after all of its fields are set.
  Connections {
    target: root.service
    function onGenerationChanged() {
      if (root.confirming) return
      if (root.service.topology !== root.draftTopology) {
        if (root.naming) root.cancelNaming()
        root.loadDraft()
      } else if (!root.dirty) {
        root.loadDraft()
      }
    }
    function onStoreChanged() {
      if (!root.dirty && !root.confirming) root.loadDraft()
    }
    function onConfirmationEnded(kept, saved) {
      // Saved: the draft is the profile now. Otherwise the draft is left as
      // it was, still unsaved, so it can be adjusted and tried again; unless
      // the screens changed meanwhile, which makes it a draft for nothing.
      if (saved) root.dirty = false
      if (saved || root.service.topology !== root.draftTopology) root.loadDraft()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(480))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(760))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.naming || resolutionPicker.popupOpen || ratePicker.popupOpen || mirrorPicker.popupOpen || vrrPicker.popupOpen
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.cycleSelection(dx)
        else if (dy !== 0) root.cycleSelection(dy)
      }
      onActivateRequested: {
        if (root.confirming) root.service.keepChanges()
        else root.applyDraft()
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (root.confirming) {
          if (t === "k" || t === "K") root.service.keepChanges()
          else if (t === "u" || t === "U") root.service.revertChanges()
          return
        }
        if (t === "i" || t === "I") { root.service.identify(); return }
        if (t >= "1" && t <= "9") root.assign(Number(t))
        else if (t === "0") root.assign(10)
        else if (t === "a" || t === "A") root.applyDraft()
        else if (t === "s" || t === "S") root.save()
        else if (t === "r" || t === "R") root.rotateSelected()
        else if (t === "e" || t === "E") {
          if (root.selected) root.edit(root.selectedKey, { enabled: root.selected.enabled === false })
        }
      }

      ScrollView {
        id: scrollArea
        anchors.fill: parent
        clip: true
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical.policy: column.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff

        Column {
          id: column
          width: scrollArea.availableWidth
          spacing: Style.space(12)

          // ---------- Hero ----------
          Item {
            width: parent.width
            implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

            Text {
              id: heroIcon
              textFormat: Text.PlainText
              text: "󰨇"
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Column {
              id: heroLabels
              anchors.left: heroIcon.right
              anchors.leftMargin: Style.space(14)
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                text: root.activeProfile ? root.activeProfile.name : "Displays"
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
                elide: Text.ElideRight
                width: parent.width
              }

              Text {
                textFormat: Text.PlainText
                text: root.statusLine
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
                elide: Text.ElideRight
                width: parent.width
              }
            }
          }

          PanelSeparator { foreground: root.fg }

          // ---------- Quick choices ----------
          // The fast way for the common case: a projector or a second screen
          // was plugged in and it should mirror or extend, now.
          Flow {
            id: quickRow
            readonly property var choices: Model.quickChoices(root.draft)
            readonly property string current: Model.quickChoiceOf(root.draft)
            visible: choices.length > 0
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: quickRow.choices

              Button {
                required property var modelData
                text: modelData.label
                bordered: true
                selected: quickRow.current === modelData.id
                foreground: root.fg
                fontFamily: root.fontFamily
                onClicked: root.quick(modelData.id)
              }
            }
          }

          // The panel opens on the short view: the quick choices and the saved
          // setups. Everything for arranging by hand is behind this button.
          Button {
            text: root.arranging ? "󰅁  Done arranging" : "󰍹  Arrange displays…"
            leftAlign: true
            width: parent.width
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.arranging = !root.arranging
          }

          // ---------- Arrangement ----------
          PanelSectionHeader {
            visible: root.arranging
            text: "ARRANGEMENT"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Item {
            id: canvas
            visible: root.arranging
            width: parent.width
            height: Style.space(240)

            readonly property var bounds: Model.layoutBounds(root.draft)
            // Room around the layout to drag a display above, below or beside
            // the others.
            readonly property real pad: Style.space(30)
            // How far a dragged display is pulled onto a guide, in layout
            // pixels, and where it would land if dropped now.
            readonly property real reach: Style.space(8) / Math.max(factor, 0.001)
            property var ghost: null
            readonly property real factor: {
              if (bounds.width <= 0 || bounds.height <= 0) return 1
              return Math.min((width - pad * 2) / bounds.width, (height - pad * 2) / bounds.height)
            }
            readonly property real originX: (width - bounds.width * factor) / 2
            readonly property real originY: (height - bounds.height * factor) / 2

            Rectangle {
              anchors.fill: parent
              color: "transparent"
              border.width: 1
              border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)
              radius: Style.cornerRadius
            }

            Repeater {
              model: root.draft

              Rectangle {
                id: tile
                required property var modelData
                readonly property var rect: Model.rectOf(modelData)
                readonly property bool isSelected: modelData.key === root.selectedKey
                readonly property var ids: root.draftDedicated ? (root.draftWorkspaces[modelData.key] || []) : []

                visible: Model.hasDesktop(modelData)
                readonly property string mirroredBy: {
                  var names = []
                  for (var i = 0; i < root.draft.length; i++)
                    if (root.draft[i].enabled !== false && root.draft[i].mirror === modelData.key)
                      names.push(Model.displayNumber(root.draft, root.draft[i].name))
                  return names.length > 0 ? "mirrored on " + names.join(", ") : ""
                }
                x: canvas.originX + (rect.x - canvas.bounds.x) * canvas.factor
                y: canvas.originY + (rect.y - canvas.bounds.y) * canvas.factor
                width: Math.max(1, rect.width * canvas.factor - 2)
                height: Math.max(1, rect.height * canvas.factor - 2)
                z: dragArea.drag.active ? 3 : (isSelected ? 1 : 0)
                opacity: dragArea.drag.active ? 0.6 : 1
                radius: Style.cornerRadius
                color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, isSelected ? 0.22 : 0.08)
                border.width: isSelected ? 2 : 1
                border.color: isSelected ? Color.accent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.35)

                Column {
                  anchors.centerIn: parent
                  width: parent.width - Style.space(6)
                  spacing: Style.space(1)

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    horizontalAlignment: Text.AlignHCenter
                    text: Model.displayNumber(root.draft, tile.modelData.name) + "  " + Model.shortName(tile.modelData)
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                  }

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    horizontalAlignment: Text.AlignHCenter
                    visible: tile.height > Style.space(34) && text !== ""
                    text: tile.mirroredBy !== "" ? tile.mirroredBy : tile.ids.join(" ")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                MouseArea {
                  id: dragArea
                  anchors.fill: parent
                  cursorShape: drag.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor
                  drag.target: tile
                  drag.threshold: 4
                  drag.minimumX: -tile.width / 2
                  drag.maximumX: canvas.width - tile.width / 2
                  drag.minimumY: -tile.height / 2
                  drag.maximumY: canvas.height - tile.height / 2

                  function layoutX() { return (tile.x - canvas.originX) / canvas.factor + canvas.bounds.x }
                  function layoutY() { return (tile.y - canvas.originY) / canvas.factor + canvas.bounds.y }

                  onPressed: root.selectedKey = tile.modelData.key
                  onPositionChanged: {
                    if (!drag.active || root.confirming) { canvas.ghost = null; return }
                    var spot = Model.landing(root.draft, tile.modelData.key, layoutX(), layoutY(), canvas.reach)
                    canvas.ghost = spot
                      ? { x: spot.x, y: spot.y, width: tile.rect.width, height: tile.rect.height }
                      : null
                  }
                  onReleased: {
                    canvas.ghost = null
                    if (!drag.active) return
                    root.moveTo(tile.modelData.key, layoutX(), layoutY(), canvas.reach)
                  }
                  onCanceled: { canvas.ghost = null; root.draft = root.draft.slice() }
                }
              }
            }

            // Where the dragged display will land.
            Rectangle {
              visible: canvas.ghost !== null
              z: 2
              x: canvas.ghost ? canvas.originX + (canvas.ghost.x - canvas.bounds.x) * canvas.factor : 0
              y: canvas.ghost ? canvas.originY + (canvas.ghost.y - canvas.bounds.y) * canvas.factor : 0
              width: canvas.ghost ? Math.max(1, canvas.ghost.width * canvas.factor - 2) : 0
              height: canvas.ghost ? Math.max(1, canvas.ghost.height * canvas.factor - 2) : 0
              radius: Style.cornerRadius
              color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18)
              border.width: 2
              border.color: Color.accent
            }
          }

          Text {
            visible: root.arranging
            textFormat: Text.PlainText
            width: parent.width
            text: "Drag a display to where it sits on your desk. The outline shows where it will land. Press i to show each screen its number."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ---------- Displays ----------
          PanelSectionHeader {
            visible: root.arranging
            text: "DISPLAYS"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Column {
            visible: root.arranging
            width: parent.width
            spacing: Style.space(2)

            Repeater {
              model: root.draft

              CursorSurface {
                id: displayRow
                required property var modelData
                width: parent.width
                height: Math.max(rowLabels.implicitHeight, powerButton.implicitHeight) + Style.space(10)
                foreground: root.fg
                current: modelData.key === root.selectedKey
                hasCursor: rowMouse.containsMouse

                MouseArea {
                  id: rowMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  onClicked: root.selectedKey = displayRow.modelData.key
                }

                Column {
                  id: rowLabels
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(8)
                  anchors.right: powerButton.left
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(1)

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: displayRow.modelData.description
                    color: displayRow.modelData.enabled === false ? root.dim : root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: displayRow.modelData.enabled === false
                      ? displayRow.modelData.name + " · off"
                      : displayRow.modelData.mirror
                      ? displayRow.modelData.name + " · " + displayRow.modelData.width + "×" + displayRow.modelData.height
                        + " · mirrors " + Model.shortName(Model.monitorByKey(root.draft, displayRow.modelData.mirror) || displayRow.modelData)
                      : displayRow.modelData.name + " · " + displayRow.modelData.width + "×" + displayRow.modelData.height
                        + (root.draftDedicated
                          ? " · workspaces " + ((root.draftWorkspaces[displayRow.modelData.key] || []).join(" ") || "none")
                          : "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                Button {
                  id: powerButton
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  text: displayRow.modelData.enabled === false ? "Off" : "On"
                  bordered: true
                  selected: displayRow.modelData.enabled !== false
                  foreground: root.fg
                  fontFamily: root.fontFamily
                  onClicked: {
                    root.selectedKey = displayRow.modelData.key
                    root.edit(displayRow.modelData.key, { enabled: displayRow.modelData.enabled === false })
                  }
                }
              }
            }
          }

          // ---------- Selected display ----------
          PanelSectionHeader {
            visible: root.arranging && root.selected !== null && root.selected.enabled !== false
            text: root.selected ? Model.shortName(root.selected).toUpperCase() : ""
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Row {
            visible: root.arranging && root.selected !== null && root.selected.enabled !== false
            width: parent.width
            spacing: Style.space(8)

            Dropdown {
              id: resolutionPicker
              width: (parent.width - parent.spacing) / 2
              label: "RESOLUTION"
              foreground: root.fg
              fontFamily: root.fontFamily
              options: root.selected
                ? Model.resolutionOptions(root.selected).map(function(o) { return { value: o.width + "x" + o.height, label: o.label } })
                : []
              value: root.selected ? root.selected.width + "x" + root.selected.height : ""
              onChanged: function(value) { root.setResolution(value) }
            }

            Dropdown {
              id: ratePicker
              width: (parent.width - parent.spacing) / 2
              label: "REFRESH RATE"
              foreground: root.fg
              fontFamily: root.fontFamily
              options: root.selected
                ? Model.rateOptions(root.selected, root.selected.width, root.selected.height).map(function(o) { return { value: String(o.value), label: o.label } })
                : []
              value: {
                if (!root.selected) return ""
                var rates = Model.rateOptions(root.selected, root.selected.width, root.selected.height)
                for (var i = 0; i < rates.length; i++)
                  if (Model.sameRate(rates[i].value, root.selected.refreshRate)) return String(rates[i].value)
                return ""
              }
              onChanged: function(value) { root.setRate(value) }
            }
          }

          Dropdown {
            id: vrrPicker
            visible: root.arranging && root.selected !== null && Model.hasDesktop(root.selected)
            width: parent.width
            label: "ADAPTIVE SYNC (VRR)"
            foreground: root.fg
            fontFamily: root.fontFamily
            options: Model.VRR_OPTIONS
            value: root.selected && Model.validVrr(root.selected.vrrPolicy) !== null ? String(root.selected.vrrPolicy) : ""
            onChanged: function(value) {
              if (root.selected) root.edit(root.selectedKey, { vrrPolicy: value === "" ? null : Number(value) })
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.arranging && root.selected !== null
            width: parent.width
            text: Model.details(root.selected)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Dropdown {
            id: mirrorPicker
            visible: root.arranging && root.selected !== null && root.selected.enabled !== false && options.length > 1
            width: parent.width
            label: "SHOWS"
            foreground: root.fg
            fontFamily: root.fontFamily
            options: {
              var list = [{ value: "", label: "Its own desktop" }]
              if (!root.selected) return list
              for (var i = 0; i < root.draft.length; i++) {
                var other = root.draft[i]
                // Only a display with its own desktop can be mirrored, and not
                // one that is itself showing this display.
                if (other.key === root.selectedKey || !Model.hasDesktop(other)) continue
                list.push({ value: other.key, label: "Mirror of " + Model.displayNumber(root.draft, other.name) + "  " + Model.shortName(other) })
              }
              return list
            }
            value: root.selected ? (root.selected.mirror || "") : ""
            onChanged: function(value) { root.setMirror(value) }
          }

          Flow {
            visible: root.arranging && root.selected !== null && root.selected.enabled !== false
            width: parent.width
            spacing: Style.space(6)

            Text {
              textFormat: Text.PlainText
              text: "Scale"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              height: rotateButton.implicitHeight
              verticalAlignment: Text.AlignVCenter
            }

            Repeater {
              model: root.selected ? Model.scaleOptions(root.selected.width, root.selected.height) : []

              Button {
                required property var modelData
                text: modelData.label
                bordered: true
                selected: root.selected !== null && Model.sameScale(root.selected.scale, modelData.value)
                foreground: root.fg
                fontFamily: root.fontFamily
                onClicked: root.edit(root.selectedKey, { scale: modelData.value })
              }
            }

            Button {
              id: rotateButton
              text: "Rotate " + (root.selected ? (Number(root.selected.transform) % 4) * 90 : 0) + "°"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.rotateSelected()
            }
          }

          Button {
            visible: root.arranging
            text: (root.draftDedicated ? "󰄬  " : "󰅖  ") + "Dedicated workspaces"
            leftAlign: true
            width: parent.width
            foreground: root.fg
            fontFamily: root.fontFamily
            tooltipText: "Keep chosen workspaces on each display. Off, only the displays are arranged."
            onClicked: root.setDedicated(!root.draftDedicated)
          }

          Flow {
            visible: root.arranging && root.draftDedicated && Model.hasDesktop(root.selected)
            width: parent.width
            spacing: Style.space(6)

            Text {
              textFormat: Text.PlainText
              text: "Workspaces"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              height: rotateButton.implicitHeight
              verticalAlignment: Text.AlignVCenter
            }

            Repeater {
              model: Model.WORKSPACE_COUNT

              Button {
                required property int index
                readonly property int workspaceId: index + 1
                text: String(workspaceId)
                bordered: true
                selected: Model.workspaceOwner(root.draftWorkspaces, workspaceId) === root.selectedKey
                foreground: root.fg
                fontFamily: root.fontFamily
                tooltipText: {
                  var owner = Model.monitorByKey(root.draft, Model.workspaceOwner(root.draftWorkspaces, workspaceId))
                  return owner ? "Workspace " + workspaceId + " is on " + Model.shortName(owner) : ""
                }
                onClicked: root.assign(workspaceId)
              }
            }
          }

          PanelSeparator { visible: root.arranging; foreground: root.fg }

          // ---------- Actions ----------
          Flow {
            visible: !root.naming && !root.confirming
            width: parent.width
            spacing: Style.space(8)

            Button {
              text: "Identify"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              tooltipText: "Show each screen its number for a few seconds"
              onClicked: if (root.serviceReady) root.service.identify()
            }

            Button {
              text: "Apply"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              tooltipText: "Try this arrangement without saving it"
              onClicked: root.applyDraft()
            }

            Button {
              text: root.activeProfile ? "Save to " + Model.shorten(root.activeProfile.name, 24) : "Save as profile…"
              bordered: true
              selected: root.dirty || !root.activeProfile
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.save()
            }

            Button {
              visible: root.activeProfile !== null
              text: "Save as new…"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              tooltipText: "Keep another profile for these same displays, such as one with some of them off"
              onClicked: root.startNaming("")
            }

            Button {
              visible: root.dirty
              text: "Discard changes"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.loadDraft()
            }
          }

          // Shown after a layout that changed a display's own settings. With
          // no answer the previous layout comes back, so a screen that went
          // dark never needs to be fixed blind.
          Flow {
            visible: root.confirming
            width: parent.width
            spacing: Style.space(8)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.confirming && root.service.confirmArmed
                ? "Keep this layout? Going back in " + root.service.confirmSeconds + " s"
                : "Applying…"
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Button {
              visible: root.confirming && root.service.confirmArmed
              text: "Keep"
              bordered: true
              selected: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.service.keepChanges()
            }

            Button {
              visible: root.confirming && root.service.confirmArmed
              text: "Go back now"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.service.revertChanges()
            }
          }

          Row {
            visible: root.naming
            width: parent.width
            spacing: Style.space(8)

            TextField {
              id: nameField
              width: parent.width - nameSave.implicitWidth - nameCancel.implicitWidth - Style.space(16)
              placeholderText: "Profile name"
              foreground: root.fg
              font.family: root.fontFamily
              onAccepted: root.confirmNaming()
              Keys.onEscapePressed: root.cancelNaming()
            }

            Button {
              id: nameSave
              text: "Save"
              bordered: true
              selected: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.confirmNaming()
            }

            Button {
              id: nameCancel
              text: "Cancel"
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.cancelNaming()
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.serviceReady && root.service.lastError !== ""
            width: parent.width
            text: root.serviceReady ? root.service.lastError : ""
            color: bar ? bar.urgent : Color.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            textFormat: Text.PlainText
            visible: root.serviceReady && root.service.storeWriteError !== ""
            width: parent.width
            text: root.serviceReady ? root.service.storeWriteError : ""
            color: bar ? bar.urgent : Color.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            textFormat: Text.PlainText
            visible: root.storeBroken
            width: parent.width
            text: root.storeBroken ? root.service.storeError + " It has been left untouched, and nothing can be saved until it is fixed or set aside." : ""
            color: bar ? bar.urgent : Color.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // The profiles file exists but could not be understood. It is never
          // overwritten; starting over renames it first.
          Button {
            visible: root.storeBroken
            text: "Set the file aside and start over"
            tooltipText: "The file is renamed, not deleted"
            bordered: true
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.service.resetStore()
          }

          // ---------- Profiles ----------
          PanelSectionHeader {
            text: "PROFILES"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Text {
            textFormat: Text.PlainText
            visible: root.profiles.length === 0
            width: parent.width
            text: "No profiles yet. Save this arrangement and it comes back every time these displays are connected."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Column {
            width: parent.width
            spacing: Style.space(2)

            Repeater {
              model: root.profiles

              CursorSurface {
                id: profileRow
                required property var modelData
                readonly property bool isActive: root.activeProfile !== null && root.activeProfile.id === modelData.id
                readonly property bool usable: {
                  var list = root.serviceReady ? root.service.setupProfiles : []
                  for (var i = 0; i < list.length; i++) if (list[i].id === modelData.id) return true
                  return false
                }
                width: parent.width
                height: Math.max(profileLabels.implicitHeight, deleteButton.implicitHeight) + Style.space(10)
                foreground: root.fg
                current: isActive

                Column {
                  id: profileLabels
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(8)
                  anchors.right: useButton.visible ? useButton.left : renameButton.left
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(1)

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: profileRow.modelData.name
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: (profileRow.isActive ? "in use · " : profileRow.usable ? "for these displays · " : "")
                      + profileRow.modelData.monitors.length
                      + (profileRow.modelData.monitors.length === 1 ? " display" : " displays")
                      + (profileRow.modelData.dock ? " · " + profileRow.modelData.dock.name : "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                Button {
                  id: useButton
                  visible: profileRow.usable && !profileRow.isActive
                  anchors.right: renameButton.left
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Use"
                  bordered: true
                  selected: true
                  foreground: root.fg
                  fontFamily: root.fontFamily
                  onClicked: if (!root.confirming) root.service.switchProfile(profileRow.modelData.id)
                }

                Button {
                  id: renameButton
                  anchors.right: deleteButton.left
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Rename"
                  bordered: true
                  foreground: root.fg
                  fontFamily: root.fontFamily
                  onClicked: root.startNaming(profileRow.modelData.id)
                }

                Button {
                  id: deleteButton
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Delete"
                  bordered: true
                  foreground: root.fg
                  fontFamily: root.fontFamily
                  onClicked: if (!root.confirming) root.service.deleteProfile(profileRow.modelData.id)
                }
              }
            }
          }

          Button {
            text: (root.serviceReady && root.service.autoApply ? "󰄬  " : "󰅖  ") + "Apply the saved profile automatically when displays change"
            leftAlign: true
            width: parent.width
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: if (root.serviceReady) root.service.setAutoApply(!root.service.autoApply)
          }
        }
      }
    }
  }
}
