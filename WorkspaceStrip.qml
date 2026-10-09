import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Workspace switcher that shows which display each workspace belongs to.
//
// Neighbouring workspaces on the same display share a line under their
// numbers. The line is strong for the display this bar is on and faint for
// the others, so each screen's bar points out its own workspaces.
Item {
  id: root

  property var bar: null
  property var service: null

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal
  readonly property color foreground: bar ? bar.barForeground : Color.foreground

  // The monitor this copy of the bar is drawn on.
  readonly property string screenName: {
    var window = root.QsWindow.window
    return window && window.screen ? String(window.screen.name || "") : ""
  }

  // Kept as a string so the buttons are only rebuilt when the grouping really
  // changes, not on every workspace event.
  readonly property string runsJson: {
    var values = Hyprland.workspaces.values
    var liveIds = []
    var liveOwners = {}
    for (var i = 0; i < values.length; i++) {
      var workspace = values[i]
      liveIds.push(workspace.id)
      if (workspace.monitor) liveOwners[workspace.id] = String(workspace.monitor.name || "")
    }
    var planned = root.service && root.service.workspaceOwners ? root.service.workspaceOwners : null
    return JSON.stringify(Model.workspaceRuns(Model.stripIds(liveIds), liveOwners, planned))
  }
  readonly property var runs: JSON.parse(runsJson)

  function workspaceById(id) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) if (values[i].id === id) return values[i]
    return null
  }

  function displayLabel(connector) {
    var monitors = root.service && root.service.monitors ? root.service.monitors : []
    for (var i = 0; i < monitors.length; i++)
      if (monitors[i].name === connector) return Model.shortName(monitors[i]) + " (" + connector + ")"
    return connector
  }

  function focusWorkspace(id) {
    if (!root.bar) return
    root.bar.run("hyprctl dispatch " + Util.shellQuote("hl.dsp.focus({ workspace = \"" + Number(id) + "\" })"))
  }

  implicitWidth: groups.implicitWidth
  implicitHeight: groups.implicitHeight

  GridLayout {
    id: groups
    anchors.fill: parent
    columns: root.vertical ? 1 : Math.max(1, root.runs.length)
    columnSpacing: root.vertical ? 0 : Style.space(6)
    rowSpacing: root.vertical ? Style.space(6) : 0

    Repeater {
      model: root.runs

      Item {
        id: group
        required property var modelData

        readonly property bool onThisScreen: modelData.monitor !== "" && modelData.monitor === root.screenName

        implicitWidth: buttons.implicitWidth
        implicitHeight: buttons.implicitHeight

        GridLayout {
          id: buttons
          anchors.fill: parent
          columns: root.vertical ? 1 : group.modelData.ids.length
          columnSpacing: root.vertical ? 0 : Style.space(1)
          rowSpacing: root.vertical ? Style.space(2) : 0

          Repeater {
            model: group.modelData.ids

            WidgetButton {
              required property int modelData

              readonly property var workspace: root.workspaceById(modelData)
              readonly property bool occupied: workspace !== null && workspace.toplevels.values.length > 0
              readonly property bool focused: Hyprland.focusedWorkspace !== null && Hyprland.focusedWorkspace.id === modelData

              bar: root.bar
              text: focused ? "󱓻" : (modelData === 10 ? "0" : String(modelData))
              opacity: occupied || focused ? 1 : 0.5
              horizontalMargin: 6
              verticalPadding: 6
              fixedWidth: root.vertical ? root.barSize : Style.space(20)
              fixedHeight: root.barSize
              tooltipText: group.modelData.monitor !== ""
                ? "Workspace " + modelData + " on " + root.displayLabel(group.modelData.monitor)
                : ""
              onPressed: function() { root.focusWorkspace(modelData) }
            }
          }
        }

        // The line that ties the group to its display: under the numbers on a
        // horizontal bar, beside them on a vertical one.
        Rectangle {
          visible: group.modelData.monitor !== ""
          color: root.foreground
          opacity: group.onThisScreen ? 0.9 : 0.3
          radius: 1
          x: root.vertical ? 2 : Style.space(4)
          y: root.vertical ? Style.space(4) : group.height - 4
          width: root.vertical ? 2 : group.width - Style.space(8)
          height: root.vertical ? group.height - Style.space(8) : 2
        }
      }
    }
  }
}
