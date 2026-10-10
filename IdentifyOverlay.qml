import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import "Model.js" as Model

// A number in the corner of every screen, the same number its tile carries in
// the panel, so it is plain which physical screen is which. Each badge is a
// small window of its own, so nothing underneath stops taking clicks.
Item {
  id: root

  property var service: null
  readonly property bool shown: service !== null && service.identifying === true

  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: badge
      required property var modelData

      readonly property int number: root.service ? Model.displayNumber(root.service.monitors, modelData.name) : 0
      readonly property var monitor: {
        var monitors = root.service ? root.service.monitors : []
        for (var i = 0; i < monitors.length; i++) if (monitors[i].name === modelData.name) return monitors[i]
        return null
      }

      screen: modelData
      visible: root.shown && number > 0
      color: "transparent"
      exclusionMode: ExclusionMode.Ignore
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      WlrLayershell.namespace: "display-profiles-identify"
      anchors { top: true; left: true }
      margins { top: Style.space(40); left: Style.space(40) }
      implicitWidth: card.width
      implicitHeight: card.height

      Rectangle {
        id: card
        width: Math.max(Style.space(170), labels.implicitWidth + Style.space(40))
        height: labels.implicitHeight + Style.space(28)
        radius: Style.cornerRadius * 2
        color: Color.popups.background
        border.color: Color.accent
        border.width: 2

        Column {
          id: labels
          anchors.centerIn: parent
          spacing: Style.space(2)

          Text {
            textFormat: Text.PlainText
            anchors.horizontalCenter: parent.horizontalCenter
            text: String(badge.number)
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.space(64)
            font.bold: true
          }

          Text {
            textFormat: Text.PlainText
            anchors.horizontalCenter: parent.horizontalCenter
            text: badge.monitor ? Model.shortName(badge.monitor) : badge.modelData.name
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            textFormat: Text.PlainText
            anchors.horizontalCenter: parent.horizontalCenter
            text: badge.modelData.name
            color: Qt.darker(Color.foreground, 1.4)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
