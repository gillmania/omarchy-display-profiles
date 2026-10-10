import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import qs.Ui

// Bar button for Display Profiles, and the host for its panel.
//
// Left click opens the arrangement panel. Right click re-applies the profile
// saved for the setup that is connected right now.
//
// With `"workspaces": true` in its shell.json entry the widget also lists the
// workspaces, grouped by the display they belong to, so it can stand in for
// the built-in workspace switcher.
BarWidget {
  id: root
  moduleName: "io.github.gillmania.display-profiles"

  // The service is this plugin's own headless half. It can finish loading
  // after the widget does, so it is looked up until it is there.
  property var service: null

  function resolveService() {
    if (root.service) return
    var shell = root.bar && root.bar.shell ? root.bar.shell : null
    if (!shell || typeof shell.serviceFor !== "function") return
    var found = shell.serviceFor(root.moduleName)
    if (found) {
      root.service = found
      root.injectPanel()
    }
  }

  readonly property string statusText: {
    if (!service || !service.ready) return "Display Profiles"
    if (!service.activeProfile) return "Display Profiles: this setup is not saved"
    return "Display Profiles: " + service.activeProfile.name
  }

  readonly property bool showWorkspaces: {
    var value = setting("workspaces", false)
    return value === true || value === "true"
  }

  // ---- Panel contract: Bar.findPanelWidget needs open/close/opened here.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.service
  }

  implicitWidth: content.implicitWidth
  implicitHeight: content.implicitHeight

  onBarChanged: { resolveService(); injectPanel() }
  onSettingsChanged: injectPanel()
  Component.onCompleted: resolveService()

  Timer {
    interval: 500
    repeat: true
    running: root.service === null
    onTriggered: root.resolveService()
  }

  // A layout that waits for "Keep this layout?" must not count down unseen.
  // Applying it rebuilds the bars, which closes the panel, so the panel is
  // brought back once on the screen that has the focus.
  readonly property bool confirmWaiting: service !== null && service.confirmArmed === true
  readonly property bool onFocusedScreen: {
    var window = root.QsWindow.window
    var focused = Hyprland.focusedMonitor
    return window && window.screen && focused ? window.screen.name === focused.name : false
  }
  property bool confirmShown: false
  onConfirmWaitingChanged: if (!confirmWaiting) confirmShown = false

  Timer {
    interval: 400
    running: root.confirmWaiting && !root.confirmShown && root.onFocusedScreen && panelLoader.item !== null
    onTriggered: {
      root.confirmShown = true
      if (!root.opened) root.open()
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  GridLayout {
    id: content
    anchors.fill: parent
    columns: root.vertical ? 1 : 2
    columnSpacing: 0
    rowSpacing: 0

    Loader {
      id: stripLoader
      active: root.showWorkspaces
      visible: active
      source: Qt.resolvedUrl("WorkspaceStrip.qml")
      onLoaded: {
        item.bar = Qt.binding(function() { return root.bar })
        item.service = Qt.binding(function() { return root.service })
      }
    }

    BarIconButton {
      id: button
      bar: root.bar
      // Not the two-monitor glyph: Omarchy's own Display widget uses that.
      text: "󰨇"
      tooltipText: root.statusText
      onPressed: function(b) {
        if (b === Qt.RightButton) {
          if (root.service && root.service.activeProfile)
            root.service.applyProfile(root.service.activeProfile.id)
        } else {
          root.toggle()
        }
      }
    }
  }
}
