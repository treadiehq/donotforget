import Foundation
import AppKit
import ApplicationServices
import Carbon

private let wsURL = URL(string: "ws://127.0.0.1:3737")!

final class WebSocketClient {
    private var session: URLSession
    private var task: URLSessionWebSocketTask?
    private var backoffSeconds: Double = 0.7
    private var isConnected = false
    private var isConnecting = false
    var onRecordingState: ((Bool) -> Void)?

    init() {
        self.session = URLSession(configuration: .default)
    }

    func connect() {
        guard !isConnecting else { return }
        isConnecting = true
        task = session.webSocketTask(with: wsURL)
        task?.resume()
        isConnected = true
        isConnecting = false
        backoffSeconds = 0.7
        listen()
        print("WS connected to \(wsURL.absoluteString)"); fflush(stdout)
    }

    private func listen() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
                   let type = json["type"] as? String,
                   type == "recordingState",
                   let payload = json["payload"] as? [String: Any],
                   let recording = payload["recording"] as? Bool {
                    self.onRecordingState?(recording)
                }
                self.listen()
            case .failure(let error):
                self.isConnected = false
                print("WS receive error: \(error.localizedDescription)"); fflush(stdout)
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        let delay = backoffSeconds
        backoffSeconds = min(backoffSeconds * 2.0, 10.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connect()
        }
    }

    func send(json: [String: Any]) {
        if !isConnected {
            connect()
        }
        guard let task else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: json, options: [])
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { [weak self] error in
                if let error {
                    self?.isConnected = false
                    print("WS send error: \(error.localizedDescription)"); fflush(stdout)
                    self?.scheduleReconnect()
                }
            }
        } catch {
            print("JSON encode error: \(error.localizedDescription)"); fflush(stdout)
        }
    }
}

final class HelperCoordinator {
    private let ws = WebSocketClient()
    private var recording = false
    private var timer: Timer?
    private var clipboardTimer: Timer?
    private var lastClipboardChangeCount: Int = 0
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private let selectionOnlyCapture = true
    private var activeSelectionSignature: String?

    private func debugLog(_ msg: String) {
        print(msg)
        fflush(stdout)
    }

    func run() {
        ws.onRecordingState = { [weak self] isRecording in
            DispatchQueue.main.async {
                self?.setRecording(isRecording)
            }
        }
        ensureAccessibilityAccess()
        ws.connect()
        installGlobalHotkey()
        debugLog("Helper running. AXTrusted=\(AXIsProcessTrusted()). Press Cmd+Shift+9 to toggle recording.")
    }

    private func ensureAccessibilityAccess() {
        if AXIsProcessTrusted() { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        debugLog("Accessibility permission is required. Enable this helper in System Settings > Privacy & Security > Accessibility.")
    }

    private func installGlobalHotkey() {
        let eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let callback: EventHandlerUPP = { _, event, _ in
            guard let event else { return noErr }
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotKeyID
            )
            if status == noErr, hotKeyID.id == 9 {
                helperGlobal?.toggleRecording()
            }
            return noErr
        }

        InstallEventHandler(
            GetApplicationEventTarget(),
            callback,
            1,
            [eventSpec],
            nil,
            &hotKeyHandler
        )

        let hotKeyID = EventHotKeyID(signature: OSType(0x53434850), id: 9) // SCHP
        let modifiers = UInt32(cmdKey | shiftKey)
        RegisterEventHotKey(UInt32(kVK_ANSI_9), modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    func toggleRecording() {
        ws.send(json: ["type": "toggleRecording"])
    }

    private func setRecording(_ next: Bool) {
        guard recording != next else { return }
        recording = next
        if recording {
            startTimer()
            debugLog("Recording ON")
        } else {
            stopTimer()
            debugLog("Recording OFF")
        }
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            self?.captureFocusedText()
        }
        RunLoop.main.add(timer!, forMode: .common)

        lastClipboardChangeCount = NSPasteboard.general.changeCount
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkClipboard()
        }
        RunLoop.main.add(clipboardTimer!, forMode: .common)
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
        clipboardTimer?.invalidate()
        clipboardTimer = nil
    }

    private func axAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let value else { return nil }
        return value
    }

    private func toString(_ any: AnyObject?) -> String? {
        guard let any else { return nil }
        if let s = any as? String {
            return s
        }
        if let s = any as? NSAttributedString {
            return s.string
        }
        return nil
    }

    private func selectedTextViaRanges(_ element: AXUIElement) -> String? {
        guard let rangesAny = axAttribute(element, kAXSelectedTextRangesAttribute as String) else { return nil }
        guard let ranges = rangesAny as? [AXValue], let first = ranges.first else { return nil }
        guard AXValueGetType(first) == .cfRange else { return nil }

        var cfRange = CFRange()
        guard AXValueGetValue(first, .cfRange, &cfRange) else { return nil }

        guard let rangeValue = AXValueCreate(.cfRange, &cfRange) else { return nil }
        var value: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXStringForRangeParameterizedAttribute as CFString,
            rangeValue,
            &value
        )
        guard status == .success else { return nil }
        return toString(value as AnyObject?)
    }

    private func selectedTextViaTextMarkerRange(_ element: AXUIElement) -> String? {
        guard let markerRange = axAttribute(element, kAXSelectedTextMarkerRangeAttribute as String) else { return nil }
        var value: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXStringForTextMarkerRangeParameterizedAttribute as CFString,
            markerRange,
            &value
        )
        guard status == .success else { return nil }
        return toString(value as AnyObject?)
    }

    private func focusedApplicationElement(systemWide: AXUIElement) -> AXUIElement? {
        guard let appAny = axAttribute(systemWide, kAXFocusedApplicationAttribute as String),
              CFGetTypeID(appAny) == AXUIElementGetTypeID()
        else {
            return nil
        }
        return (appAny as! AXUIElement)
    }

    private func axRole(_ element: AXUIElement) -> String? {
        return toString(axAttribute(element, kAXRoleAttribute as String))
    }

    private func collectWebAreas(from element: AXUIElement, depth: Int = 0, into result: inout [AXUIElement]) {
        guard depth < 8 else { return }
        if let role = axRole(element), role == "AXWebArea" {
            result.append(element)
        }
        guard let childrenAny = axAttribute(element, kAXChildrenAttribute as String),
              let children = childrenAny as? [AXUIElement]
        else { return }
        for child in children.prefix(20) {
            collectWebAreas(from: child, depth: depth + 1, into: &result)
        }
    }

    private func findSelectedTextRecursive(from element: AXUIElement, depth: Int = 0) -> String? {
        guard depth < 12 else { return nil }

        if let sel = toString(axAttribute(element, kAXSelectedTextAttribute as String)),
           !sel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return sel
        }
        if let marker = selectedTextViaTextMarkerRange(element),
           !marker.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return marker
        }

        guard let childrenAny = axAttribute(element, kAXChildrenAttribute as String),
              let children = childrenAny as? [AXUIElement]
        else { return nil }

        for child in children.prefix(30) {
            if let found = findSelectedTextRecursive(from: child, depth: depth + 1) {
                return found
            }
        }
        return nil
    }

    private func focusedElementCandidates(systemWide: AXUIElement) -> [AXUIElement] {
        var out: [AXUIElement] = []
        func add(_ element: AXUIElement) {
            let sig = "\(element)"
            if !out.contains(where: { "\($0)" == sig }) {
                out.append(element)
            }
        }

        if let focusedAny = axAttribute(systemWide, kAXFocusedUIElementAttribute as String),
           CFGetTypeID(focusedAny) == AXUIElementGetTypeID() {
            add(focusedAny as! AXUIElement)
        }

        if let focusedApp = focusedApplicationElement(systemWide: systemWide) {
            if let appFocusedAny = axAttribute(focusedApp, kAXFocusedUIElementAttribute as String),
               CFGetTypeID(appFocusedAny) == AXUIElementGetTypeID() {
                add(appFocusedAny as! AXUIElement)
            }
            if let windowAny = axAttribute(focusedApp, kAXFocusedWindowAttribute as String),
               CFGetTypeID(windowAny) == AXUIElementGetTypeID() {
                let window = windowAny as! AXUIElement
                add(window)
                if let windowFocusedAny = axAttribute(window, kAXFocusedUIElementAttribute as String),
                   CFGetTypeID(windowFocusedAny) == AXUIElementGetTypeID() {
                    add(windowFocusedAny as! AXUIElement)
                }
                var webAreas: [AXUIElement] = []
                collectWebAreas(from: window, into: &webAreas)
                for wa in webAreas { add(wa) }
            }
            add(focusedApp)
        }
        return out
    }

    private func extractSelectedTextOnly(from element: AXUIElement, verbose: Bool = false) -> String? {
        let role = axRole(element) ?? "?"

        var rawRef: CFTypeRef?
        let selStatus = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &rawRef)
        if selStatus == .success, let raw = rawRef {
            let str = toString(raw as AnyObject)
            if verbose { debugLog("[ax-detail] \(role): kAXSelectedText status=ok val=\"\(str?.prefix(40) ?? "nil")\"") }
            if let s = str, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
        } else {
            if verbose { debugLog("[ax-detail] \(role): kAXSelectedText status=\(selStatus.rawValue)") }
        }

        if let markerSelected = selectedTextViaTextMarkerRange(element),
           !markerSelected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if verbose { debugLog("[ax-detail] \(role): textMarkerRange hit len=\(markerSelected.count)") }
            return markerSelected
        } else {
            if verbose { debugLog("[ax-detail] \(role): textMarkerRange miss") }
        }

        if let rangedSelected = selectedTextViaRanges(element),
           !rangedSelected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if verbose { debugLog("[ax-detail] \(role): selectedRanges hit len=\(rangedSelected.count)") }
            return rangedSelected
        } else {
            if verbose { debugLog("[ax-detail] \(role): selectedRanges miss") }
        }

        return nil
    }

    private func extractText(from element: AXUIElement, verbose: Bool = false) -> (source: String, text: String)? {
        if let selected = extractSelectedTextOnly(from: element, verbose: verbose) {
            return ("selection", selected)
        }
        if !selectionOnlyCapture {
            if let value = toString(axAttribute(element, kAXValueAttribute as String)),
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return ("focused", value)
            }
            if let title = toString(axAttribute(element, kAXTitleAttribute as String)),
               !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return ("focused", title)
            }
        }
        return nil
    }

    private func extractTextWithParents(from element: AXUIElement, verbose: Bool = false) -> (source: String, text: String)? {
        if let direct = extractText(from: element, verbose: verbose) {
            return direct
        }

        var current: AXUIElement? = element
        var depth = 0
        while depth < 6, let node = current {
            guard let parentAny = axAttribute(node, kAXParentAttribute as String),
                  CFGetTypeID(parentAny) == AXUIElementGetTypeID()
            else { break }
            let parent = parentAny as! AXUIElement
            if let fromParent = extractText(from: parent, verbose: verbose) {
                return fromParent
            }
            current = parent
            depth += 1
        }
        return nil
    }

    private let minimumSelectionLength = 3
    private var tickCount = 0

    private func checkClipboard() {
        guard recording else { return }
        let pasteboard = NSPasteboard.general
        let currentCount = pasteboard.changeCount
        guard currentCount != lastClipboardChangeCount else { return }
        lastClipboardChangeCount = currentCount

        guard let text = pasteboard.string(forType: .string) else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= minimumSelectionLength else { return }

        let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"

        if appName.lowercased() == "electron" {
            return
        }

        var windowTitle: String?
        if AXIsProcessTrusted() {
            let systemWide = AXUIElementCreateSystemWide()
            if let focusedApp = focusedApplicationElement(systemWide: systemWide),
               let windowAny = axAttribute(focusedApp, kAXFocusedWindowAttribute as String),
               CFGetTypeID(windowAny) == AXUIElementGetTypeID() {
                let window = windowAny as! AXUIElement
                windowTitle = toString(axAttribute(window, kAXTitleAttribute as String))
            }
        }

        let normalizedText = trimmed.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let signature = "\(appName)|\(windowTitle ?? "")|clipboard|\(normalizedText)"
        if signature == activeSelectionSignature {
            return
        }
        activeSelectionSignature = signature

        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let payload: [String: Any] = [
            "type": "capture",
            "payload": [
                "ts": nowMs,
                "app": appName,
                "window": windowTitle ?? "",
                "source": "clipboard",
                "text": text
            ]
        ]
        ws.send(json: payload)
        debugLog("[capture] clipboard from \(appName): \(normalizedText.prefix(60))...")
    }

    private func captureFocusedText() {
        tickCount += 1
        guard recording else { return }
        guard AXIsProcessTrusted() else { return }

        let systemWide = AXUIElementCreateSystemWide()
        let candidates = focusedElementCandidates(systemWide: systemWide)
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"

        if candidates.isEmpty {
            debugLog("[debug] \(appName): no AX candidates found")
            return
        }

        var windowTitle: String?
        if let focusedApp = focusedApplicationElement(systemWide: systemWide),
           let windowAny = axAttribute(focusedApp, kAXFocusedWindowAttribute as String),
           CFGetTypeID(windowAny) == AXUIElementGetTypeID() {
            let window = windowAny as! AXUIElement
            if let title = toString(axAttribute(window, kAXTitleAttribute as String)) {
                windowTitle = title
            }
        }

        let verbose = (tickCount % 5 == 1)
        var source = "focused"
        var text: String?

        for (idx, element) in candidates.enumerated() {
            let role = axRole(element) ?? "?"
            if let result = extractTextWithParents(from: element, verbose: verbose) {
                source = result.source
                text = result.text
                debugLog("[debug] \(appName): hit on candidate \(idx) (role=\(role)), source=\(source), len=\(result.text.count)")
                break
            } else {
                if verbose {
                    debugLog("[debug] \(appName): miss on candidate \(idx) (role=\(role))")
                }
            }
        }

        if text == nil {
            if let focusedApp = focusedApplicationElement(systemWide: systemWide),
               let windowAny = axAttribute(focusedApp, kAXFocusedWindowAttribute as String),
               CFGetTypeID(windowAny) == AXUIElementGetTypeID() {
                let window = windowAny as! AXUIElement
                if let deepFound = findSelectedTextRecursive(from: window) {
                    source = "selection"
                    text = deepFound
                    debugLog("[debug] \(appName): deep-search hit, len=\(deepFound.count)")
                }
            }
        }

        guard let text else {
            if verbose {
                debugLog("[debug] \(appName): no text extracted from \(candidates.count) candidates")
            }
            return
        }
        let normalizedText = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedText.isEmpty else { return }

        if appName.lowercased() == "electron", (windowTitle ?? "").lowercased().contains("session capture") {
            return
        }

        if selectionOnlyCapture {
            guard source == "selection" else {
                activeSelectionSignature = nil
                return
            }
            guard normalizedText.count >= minimumSelectionLength else {
                return
            }
        }

        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let signature = "\(appName)|\(windowTitle ?? "")|\(source)|\(normalizedText)"
        if signature == activeSelectionSignature {
            return
        }
        activeSelectionSignature = signature

        let payload: [String: Any] = [
            "type": "capture",
            "payload": [
                "ts": nowMs,
                "app": appName,
                "window": windowTitle ?? "",
                "source": source,
                "text": text
            ]
        ]
        ws.send(json: payload)
        debugLog("[capture] sent (\(source)) from \(appName): \(normalizedText.prefix(60))...")
    }
}

private var helperGlobal: HelperCoordinator?

let helper = HelperCoordinator()
helperGlobal = helper
helper.run()
RunLoop.main.run()
