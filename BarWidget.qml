import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// Bar button for Display Profiles, and the host for its panel.
//
// Left click opens the arrangement panel. Right click re-applies the profile
// saved for the setup that is connected right now.
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

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: { resolveService(); injectPanel() }
  onSettingsChanged: injectPanel()
  Component.onCompleted: resolveService()

  Timer {
    interval: 500
    repeat: true
    running: root.service === null
    onTriggered: root.resolveService()
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

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍺"
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
