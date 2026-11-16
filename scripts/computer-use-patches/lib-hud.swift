import AppKit
import Foundation
import QuartzCore

// sv-computer-hud —— 屏幕右上角的 Computer Use 状态面板 + 高层光标覆盖层。
// 只读 JSON 状态文件，不参与任何桌面操作；鼠标事件全部穿透。

let statePath: String = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let cursorStatePath: String = statePath.isEmpty
    ? ""
    : URL(fileURLWithPath: statePath).deletingLastPathComponent().appendingPathComponent("cursor-state.json").path
let panelWidth: CGFloat = 340
let inset: CGFloat = 14

struct HudEntry {
    let status: String
    let title: String
    let detail: String
}

final class HudPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// 高层光标：绘制在所有普通窗口、微信搜索弹窗和 Dock 之上，但鼠标事件全部穿透。
final class CursorView: NSView {
    var point: NSPoint? {
        didSet { needsDisplay = true }
    }
    var clickTime: CFTimeInterval = 0
    private var animationTimer: Timer?

    func flashClick() {
        clickTime = CACurrentMediaTime()
        needsDisplay = true
        animationTimer?.invalidate()
        let timer = Timer(timeInterval: 0.03, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            if CACurrentMediaTime() - self.clickTime > 0.35 {
                timer.invalidate()
                self.animationTimer = nil
            }
            self.needsDisplay = true
        }
        animationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let point else { return }

        // 柔光底
        let glowRect = NSRect(x: point.x - 15, y: point.y - 15, width: 30, height: 30)
        NSColor.systemBlue.withAlphaComponent(0.22).setFill()
        NSBezierPath(ovalIn: glowRect).fill()

        // 箭头光标：热点在 point
        let arrow = NSBezierPath()
        arrow.move(to: point)
        arrow.line(to: NSPoint(x: point.x, y: point.y - 21))
        arrow.line(to: NSPoint(x: point.x + 6.5, y: point.y - 14.5))
        arrow.line(to: NSPoint(x: point.x + 14, y: point.y - 15.5))
        arrow.close()
        NSColor.white.setFill()
        arrow.fill()
        NSColor(calibratedWhite: 0.06, alpha: 0.92).setStroke()
        arrow.lineWidth = 1.6
        arrow.stroke()

        // 热点圆点
        let dot = NSRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)
        NSColor.systemBlue.setFill()
        NSBezierPath(ovalIn: dot).fill()

        // 点击波纹
        let elapsed = CACurrentMediaTime() - clickTime
        if elapsed >= 0 && elapsed < 0.35 {
            let progress = CGFloat(elapsed / 0.35)
            let radius = 8 + 24 * progress
            let ring = NSRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
            let path = NSBezierPath(ovalIn: ring)
            NSColor.systemBlue.withAlphaComponent(0.75 * (1 - progress)).setStroke()
            path.lineWidth = 2.5
            path.stroke()
        }
    }
}

final class HudController: NSObject {
    private let panel: HudPanel
    private let background: NSView
    private let text: NSTextField
    private var cursorPanels: [(screen: NSScreen, window: HudPanel, view: CursorView)] = []
    private var timer: Timer?
    private var cursorTimer: Timer?
    private var screenObserver: NSObjectProtocol?
    private var lastUpdated: Double = -1
    private var lastCursorUpdated: Double = -1
    private var lastClick: Double = -1
    private var lastCursorScreenPoint: (Double, Double)?
    private var lastActivity = Date()
    private var hidden = false
    private var status = "idle"

    private static func mainScreenHeight() -> CGFloat {
        NSScreen.screens.first(where: { $0.frame.origin.x == 0 && $0.frame.origin.y == 0 })?.frame.height
            ?? NSScreen.main?.frame.height
            ?? 0
    }

    override init() {
        background = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: 96))
        background.wantsLayer = true
        background.layer?.cornerRadius = 14
        background.layer?.masksToBounds = true
        background.layer?.backgroundColor = NSColor(calibratedWhite: 0.06, alpha: 0.88).cgColor
        background.layer?.borderWidth = 1
        background.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        background.autoresizingMask = [.width, .height]

        text = NSTextField(wrappingLabelWithString: "")
        text.frame = NSRect(x: inset, y: 12, width: panelWidth - inset * 2, height: 72)
        text.isEditable = false
        text.isSelectable = false
        text.drawsBackground = false
        text.isBordered = false
        text.lineBreakMode = .byTruncatingTail
        text.autoresizingMask = [.width]

        panel = HudPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 96),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = background
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.title = "SV HUD"
        // 状态面板不进入屏幕截图，避免干扰 screen_observe
        panel.sharingType = .none

        background.addSubview(text)
        super.init()
        rebuildCursorWindows()
    }
    func start() {
        NSApp.setActivationPolicy(.accessory)
        render(status: "idle", current: "等待桌面操作…", detail: "", entries: [])
        position()
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        rebuildCursorWindows()

        timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if let timer {
            RunLoop.main.add(timer, forMode: .common)
        }

        cursorTimer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.tickCursor()
        }
        if let cursorTimer {
            RunLoop.main.add(cursorTimer, forMode: .common)
        }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.rebuildCursorWindows()
        }
    }

    private func rebuildCursorWindows() {
        for entry in cursorPanels {
            entry.window.orderOut(nil)
        }
        cursorPanels = NSScreen.screens.map { screen in
            let frame = screen.frame
            let view = CursorView(frame: NSRect(origin: .zero, size: frame.size))
            view.wantsLayer = true
            let window = HudPanel(
                contentRect: NSRect(origin: .zero, size: frame.size),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            window.contentView = view
            window.title = "SV Cursor"
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            window.ignoresMouseEvents = true
            window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 1)
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            window.hidesOnDeactivate = false
            window.isReleasedWhenClosed = false
            window.sharingType = .none
            window.setFrame(frame, display: false)
            return (screen, window, view)
        }
        if let point = lastCursorScreenPoint {
            updateCursorPoints(point.0, point.1)
        }
    }

    private func updateCursorPoints(_ px: Double, _ py: Double) {
        let mainHeight = HudController.mainScreenHeight()
        for entry in cursorPanels {
            let frame = entry.screen.frame
            let localX = px - frame.minX
            let localY = (mainHeight - py) - frame.minY
            if localX >= 0 && localX <= frame.width && localY >= 0 && localY <= frame.height {
                entry.view.point = NSPoint(x: localX, y: localY)
                if !entry.window.isVisible {
                    entry.window.orderFrontRegardless()
                }
            } else {
                entry.view.point = nil
            }
        }
    }

    private func tickCursor() {
        guard !cursorStatePath.isEmpty,
              let data = try? Data(contentsOf: URL(fileURLWithPath: cursorStatePath)),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let root = object as? [String: Any] else {
            return
        }
        let updated = (root["updatedAt"] as? NSNumber)?.doubleValue ?? 0
        let visible = root["visible"] as? Bool ?? false
        if updated > lastCursorUpdated {
            lastCursorUpdated = updated
            let px = (root["x"] as? NSNumber)?.doubleValue ?? 0
            let py = (root["y"] as? NSNumber)?.doubleValue ?? 0
            lastCursorScreenPoint = (px, py)
            let click = (root["click"] as? NSNumber)?.doubleValue ?? 0
            if visible {
                updateCursorPoints(px, py)
                if click > lastClick {
                    lastClick = click
                    for entry in cursorPanels where entry.view.point != nil {
                        entry.view.flashClick()
                    }
                }
            } else {
                hideCursor()
            }
        }
        let now = Date().timeIntervalSince1970 * 1000
        if lastCursorScreenPoint != nil && lastCursorUpdated > 0 && now - lastCursorUpdated > 3000 {
            hideCursor()
            lastCursorScreenPoint = nil
        }
    }

    private func hideCursor() {
        for entry in cursorPanels {
            entry.view.point = nil
            if entry.window.isVisible {
                entry.window.orderOut(nil)
            }
        }
    }

    private func tick() {
        let now = Date()
        if now.timeIntervalSince(lastActivity) > 900 {
            NSApp.terminate(nil)
            return
        }
        guard !statePath.isEmpty,
              let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let root = object as? [String: Any] else {
            return
        }
        let updated = (root["updatedAt"] as? NSNumber)?.doubleValue ?? 0
        if updated > lastUpdated {
            lastUpdated = updated
            lastActivity = now
            apply(root)
        }
        if status != "running" && !hidden && now.timeIntervalSince(lastActivity) > 15 {
            hide()
        }
    }

    private func apply(_ root: [String: Any]) {
        status = root["status"] as? String ?? "idle"
        let current = root["current"] as? String ?? ""
        let detail = root["detail"] as? String ?? ""
        let raw = root["entries"] as? [[String: Any]] ?? []
        let entries = raw.map { item in
            HudEntry(
                status: item["status"] as? String ?? "success",
                title: item["title"] as? String ?? "",
                detail: item["detail"] as? String ?? ""
            )
        }
        render(status: status, current: current, detail: detail, entries: entries)
        show()
    }

    private func render(status: String, current: String, detail: String, entries: [HudEntry]) {
        let accent: NSColor
        let glyph: String
        let header: String
        switch status {
        case "running":
            accent = .controlAccentColor
            glyph = "●"
            header = "Computer Use · 执行中"
        case "success":
            accent = .systemGreen
            glyph = "✓"
            header = "Computer Use · 完成"
        case "error":
            accent = .systemRed
            glyph = "✗"
            header = "Computer Use · 失败"
        default:
            accent = .secondaryLabelColor
            glyph = "●"
            header = "Computer Use"
        }

        let body = NSMutableAttributedString()
        body.append(NSAttributedString(
            string: "\(glyph) ",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .foregroundColor: accent,
            ]
        ))
        body.append(NSAttributedString(
            string: "\(header)\n",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(0.72),
            ]
        ))
        if !current.isEmpty {
            body.append(NSAttributedString(
                string: "\(current)\n",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
                    .foregroundColor: NSColor.white,
                ]
            ))
        }
        if !detail.isEmpty {
            body.append(NSAttributedString(
                string: "\(detail)\n",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11),
                    .foregroundColor: NSColor.white.withAlphaComponent(0.62),
                ]
            ))
        }
        if !entries.isEmpty {
            body.append(NSAttributedString(
                string: "────────────────────\n",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 9),
                    .foregroundColor: NSColor.white.withAlphaComponent(0.20),
                ]
            ))
            for entry in entries.suffix(6) {
                let entryColor: NSColor
                let entryGlyph: String
                switch entry.status {
                case "error":
                    entryColor = .systemRed
                    entryGlyph = "✗"
                case "running":
                    entryColor = .systemBlue
                    entryGlyph = "•"
                default:
                    entryColor = .systemGreen
                    entryGlyph = "✓"
                }
                body.append(NSAttributedString(
                    string: "\(entryGlyph) ",
                    attributes: [
                        .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                        .foregroundColor: entryColor,
                    ]
                ))
                body.append(NSAttributedString(
                    string: "\(entry.title)\n",
                    attributes: [
                        .font: NSFont.systemFont(ofSize: 11),
                        .foregroundColor: NSColor.white.withAlphaComponent(0.92),
                    ]
                ))
            }
        }

        text.attributedStringValue = body
        let bounds = body.boundingRect(
            with: NSSize(width: panelWidth - inset * 2, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let textHeight = ceil(bounds.height)
        text.frame = NSRect(x: inset, y: 12, width: panelWidth - inset * 2, height: textHeight)
        panel.setContentSize(NSSize(width: panelWidth, height: textHeight + 24))
        position()
    }

    private func position() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(
            x: visible.maxX - size.width - 16,
            y: visible.maxY - size.height - 16
        ))
    }

    private func show() {
        if hidden {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.15
                panel.animator().alphaValue = 1
            }
            hidden = false
        } else if !panel.isVisible {
            panel.orderFrontRegardless()
        }
    }

    private func hide() {
        guard !hidden else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.panel.orderOut(nil)
            self?.hidden = true
        })
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = HudController()
controller.start()
app.run()
