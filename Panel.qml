import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The Display Profiles panel: a draggable map of the monitors, per-monitor
// settings, workspace assignment, and the saved profiles.
//
// Edits are made to a draft and only reach Hyprland on Apply or Save, so a
// half-finished drag never rearranges the screens being looked at.
Panel {
  id: root
  moduleName: "io.github.gillmania.display-profiles"
  manageIpc: false

  property var anchorItem: null
  // The bar identifies a panel by the widget mounted in its slot.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  property var service: null

  // ---- Draft ----
  property var draft: []
  property var draftWorkspaces: ({})
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
    draft = Model.normalize(JSON.parse(JSON.stringify(service.monitors)))
    draftWorkspaces = activeProfile
      ? Model.completeWorkspaces(draft, activeProfile.workspaces)
      : Model.workspacesFromLive(draft, service.workspaces, service.workspaceRules)
    draftTopology = service.topology
    dirty = false
    if (!Model.monitorByKey(draft, selectedKey)) {
      selectedKey = ""
      for (var i = 0; i < draft.length; i++)
        if (draft[i].focused) selectedKey = draft[i].key
      if (selectedKey === "" && draft.length > 0) selectedKey = draft[0].key
    }
  }

  function edit(key, changes) {
    // The last screen that is on must stay on.
    if (changes.enabled === false && Model.enabledCount(draft) <= 1) return
    draft = Model.editMonitor(draft, key, changes)
    draftWorkspaces = Model.completeWorkspaces(draft, draftWorkspaces)
    dirty = true
  }

  function moveTo(key, x, y) {
    draft = Model.place(draft, key, x, y)
    dirty = true
  }

  function assign(id) {
    if (!selected || selected.enabled === false) return
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

  function rotateSelected() {
    if (selected) edit(selectedKey, { transform: (Number(selected.transform) + 1) % 4 })
  }

  function applyDraft() {
    if (!serviceReady || confirming) return
    service.applyDraft(draft, draftWorkspaces, draftTopology)
  }

  // Saved at once when only workspaces changed; otherwise the service waits
  // for the layout to be confirmed, and the draft stays unsaved until then.
  function saveAs(name) {
    if (!serviceReady || confirming) return
    var id = service.saveProfile(name, draft, draftWorkspaces, draftTopology)
    if (id !== "" && !service.confirmPending) dirty = false
  }

  function save() {
    if (!serviceReady || confirming) return
    if (!activeProfile) { startNaming("") ; return }
    saveAs("")
  }

  function startNaming(profileId) {
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
    else saveAs(nameField.text)
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
    function onConfirmationEnded(kept) {
      // Kept: the screens now look like the draft. Reverted: the draft is
      // left as it was, still unsaved, so it can be adjusted and tried again.
      if (kept && root.service.inSync) root.dirty = false
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
      blocked: root.naming
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
              text: "󰍺"
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

          // ---------- Arrangement ----------
          PanelSectionHeader {
            text: "ARRANGEMENT"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Item {
            id: canvas
            width: parent.width
            height: Style.space(200)

            readonly property var bounds: Model.layoutBounds(root.draft)
            readonly property real pad: Style.space(10)
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
                readonly property var ids: root.draftWorkspaces[modelData.key] || []

                visible: modelData.enabled !== false
                x: canvas.originX + (rect.x - canvas.bounds.x) * canvas.factor
                y: canvas.originY + (rect.y - canvas.bounds.y) * canvas.factor
                width: Math.max(1, rect.width * canvas.factor - 2)
                height: Math.max(1, rect.height * canvas.factor - 2)
                z: dragArea.drag.active ? 2 : (isSelected ? 1 : 0)
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
                    text: Model.shortName(tile.modelData)
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
                    visible: tile.height > Style.space(34)
                    text: tile.ids.join(" ")
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
                  onPressed: root.selectedKey = tile.modelData.key
                  onReleased: {
                    if (!drag.active) return
                    var lx = (tile.x - canvas.originX) / canvas.factor + canvas.bounds.x
                    var ly = (tile.y - canvas.originY) / canvas.factor + canvas.bounds.y
                    root.moveTo(tile.modelData.key, lx, ly)
                  }
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "Drag a display to where it sits on your desk."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ---------- Displays ----------
          PanelSectionHeader {
            text: "DISPLAYS"
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Column {
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
                      : displayRow.modelData.name + " · " + displayRow.modelData.width + "×" + displayRow.modelData.height
                        + " · workspaces " + ((root.draftWorkspaces[displayRow.modelData.key] || []).join(" ") || "none")
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
            visible: root.selected !== null && root.selected.enabled !== false
            text: root.selected ? Model.shortName(root.selected).toUpperCase() : ""
            foreground: root.fg
            fontFamily: root.fontFamily
          }

          Flow {
            visible: root.selected !== null && root.selected.enabled !== false
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

          Flow {
            visible: root.selected !== null && root.selected.enabled !== false
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

          PanelSeparator { foreground: root.fg }

          // ---------- Actions ----------
          Flow {
            visible: !root.naming && !root.confirming
            width: parent.width
            spacing: Style.space(8)

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
              text: "Keep this layout? Going back in " + (root.confirming ? root.service.confirmSeconds : 0) + " s"
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              height: keepButton.implicitHeight
              verticalAlignment: Text.AlignVCenter
            }

            Button {
              id: keepButton
              text: "Keep"
              bordered: true
              selected: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.service.keepChanges()
            }

            Button {
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

          // The profiles file exists but could not be understood. It is never
          // overwritten; starting over renames it first.
          Button {
            visible: root.storeBroken
            text: "Set the unreadable profiles file aside and start with none"
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
                width: parent.width
                height: Math.max(profileLabels.implicitHeight, deleteButton.implicitHeight) + Style.space(10)
                foreground: root.fg
                current: isActive

                Column {
                  id: profileLabels
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(8)
                  anchors.right: renameButton.left
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
                    text: (profileRow.isActive ? "connected now · " : "")
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
                  onClicked: root.service.deleteProfile(profileRow.modelData.id)
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
