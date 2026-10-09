import Foundation
import Combine
import SwiftUI
import UIKit

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward a pairing/heartbeat secret to a redirected host.
    }
}

/// The phone only proves it is present by pinging the laptop while this app is open.
/// Flow: scan QR -> claim (5 s budget) -> heartbeats every 2 s until unpaired or the exam ends.
@MainActor final class PresenceController: ObservableObject {
    enum Screen: Equatable { case scanning, connecting, connectFailed, paired }

    @Published private(set) var screen: Screen = .scanning
    @Published private(set) var link: LinkHealth = .reconnecting
    @Published private(set) var status = PresenceController.scanPrompt
    /// Shown on the scanner screen after a bad, expired or ended pairing.
    @Published private(set) var scanHint: String?
    @Published private(set) var lastAcknowledged: Date?
    @Published private(set) var appActive = false

    static let scanPrompt = "Point the camera at the QR code on your laptop."
    private var pending: PairingLink?
    private var gate = ForegroundGate()
    private var leftApp = LeftAppTracker()
    private var task: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var session: URLSession?
    private var origin: URL?
    private var credential: String?

    var paired: Bool { screen == .paired }

    static var allowsDemoHTTP: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    // MARK: - Inputs

    /// From the in-app scanner, a tapped `examcompanion://` link, or the pasted-link fallback.
    func acceptLink(_ value: String) {
        let link: PairingLink
        do { link = try PairingLink(value, allowHTTP: Self.allowsDemoHTTP) } catch {
            if screen == .scanning || screen == .connectFailed {
                scanHint = "That isn't an exam pairing code. Scan the QR code shown on your laptop."
            }
            return
        }
        // The scanner reports the same code many times a second; ignore repeats of the one in flight.
        if link == pending && screen == .connecting { return }
        forgetPairing()
        pending = link
        connect()
    }

    func retry() {
        if pending == nil { scanAgain() } else { connect() }
    }

    func scanAgain(hint: String? = nil) {
        forgetPairing()
        screen = .scanning
        scanHint = hint
        status = Self.scanPrompt
        updateIdleTimer()
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        let active = phase == .active
        leftApp.phaseChanged(phase == .background ? .background : active ? .active : .inactive,
                             paired: credential != nil)
        appActive = active
        gate.transition(active: active)
        cancelWork()
        if !active {
            if paired {
                link = .reconnecting
                status = "Paused: open this app again so your laptop keeps answering."
            }
        } else if let origin, let credential {
            startHeartbeats(origin: origin, credential: credential)
        } else if pending != nil && screen == .connecting {
            connect() // e.g. resumed after the Local Network permission alert
        }
        updateIdleTimer()
    }

    // MARK: - Pairing

    private func connect() {
        guard let pending else { return }
        cancelWork()
        screen = .connecting
        scanHint = nil
        status = "Connecting to laptop…"
        updateIdleTimer()
        // A cold launch from a tapped link delivers the URL before the scene is active;
        // scenePhaseChanged(.active) resumes from here.
        guard gate.active else { return }
        let generation = gate.generation
        let session = makeSession()
        self.session = session
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(PairingTimeout.seconds * 1e9))
            guard let self, !Task.isCancelled, self.gate.permits(generation), self.screen == .connecting else { return }
            self.cancelWork()
            self.screen = .connectFailed
            self.status = "Couldn't reach your laptop. Check that both are on the same Wi-Fi and the pairing QR is still showing, then try again."
            self.updateIdleTimer()
        }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let secret = try await self.claim(session, pending, generation)
                self.watchdog?.cancel()
                self.pending = nil
                self.origin = pending.origin
                self.credential = secret
                self.leftApp.reset()
                self.lastAcknowledged = nil
                self.screen = .paired
                self.link = .reconnecting
                self.status = "Paired. Checking the connection…"
                self.updateIdleTimer()
                await self.heartbeatLoop(session, pending.origin, secret, generation)
            } catch PairingError.rejected {
                guard self.gate.permits(generation), !Task.isCancelled else { return }
                self.scanAgain(hint: "This QR code has expired or was already used. Show a fresh QR code on your laptop and scan it.")
            } catch {
                // Cancelled: backgrounded, replaced, or the watchdog fired.
            }
        }
    }

    /// Probe + claim, retried every second until it works, is rejected, or the watchdog cancels it.
    private func claim(_ session: URLSession, _ pending: PairingLink, _ generation: Int) async throws -> String {
        while true {
            do {
                // The Local Network permission alert can make the scene inactive.
                // Trigger it without the one-use code, then recheck before claiming.
                var probe = URLRequest(url: pending.origin)
                probe.httpMethod = "HEAD"
                _ = try await session.data(for: probe)
                try check(generation)
                let claim: Claim = try await post(session, pending.origin, "claim", ["code": pending.code])
                try check(generation)
                guard claim.credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
                    throw PairingError.rejected
                }
                return claim.credential
            } catch PairingError.rejected {
                throw PairingError.rejected
            } catch {
                try check(generation)
                try await Task.sleep(nanoseconds: UInt64(PairingTimeout.retryDelay * 1e9))
                try check(generation)
            }
        }
    }

    // MARK: - Heartbeats

    private func startHeartbeats(origin: URL, credential: String) {
        cancelWork()
        let generation = gate.generation
        let session = makeSession()
        self.session = session
        link = .reconnecting
        status = "Reconnecting…"
        task = Task { [weak self] in
            await self?.heartbeatLoop(session, origin, credential, generation)
        }
    }

    private func heartbeatLoop(_ session: URLSession, _ origin: URL, _ secret: String, _ generation: Int) async {
        var rejections = RejectionTracker()
        let clock = ContinuousClock()
        while gate.permits(generation) && !Task.isCancelled {
            let started = clock.now
            do {
                let challenge: Challenge = try await post(session, origin, "challenge", ["credential": secret])
                try check(generation)
                var body: [String: Any] = [
                    "credential": secret, "challenge": challenge.challenge, "sequence": challenge.sequence, "active": true
                ]
                let reportingLeftApp = leftApp.pending
                if reportingLeftApp { body["leftApp"] = true }
                let ack: Acknowledgement = try await post(session, origin, "heartbeat", body)
                try check(generation)
                guard ack.ok else { throw PairingError.rejected }
                if reportingLeftApp { leftApp.reported() }
                rejections.recordSuccess()
                lastAcknowledged = Date()
                show(latestOK: true)
            } catch PairingError.rejected {
                guard gate.permits(generation), !Task.isCancelled else { return }
                if rejections.recordRejection() == .giveUp {
                    scanAgain(hint: "Your laptop ended this pairing (new QR code, or the exam finished). Scan the new QR code to pair again.")
                    return
                }
                show(latestOK: false)
            } catch {
                guard gate.permits(generation), !Task.isCancelled else { return }
                show(latestOK: false) // network blip: keep retrying on schedule
            }
            let elapsed = started.duration(to: clock.now)
            let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
            do { try await Task.sleep(nanoseconds: UInt64(HeartbeatSchedule.sleepSeconds(elapsed: seconds) * 1e9)) } catch { return }
        }
    }

    private func show(latestOK: Bool) {
        link = LinkHealthPolicy.health(latestOK: latestOK, lastAcknowledged: lastAcknowledged, now: Date())
        switch link {
        case .connected: status = "Connected to your laptop"
        case .reconnecting: status = "Reconnecting…"
        case .laptopNotResponding:
            status = "Your laptop isn't responding. Check the exam is still open on the laptop and both are on the same Wi-Fi. Retrying automatically…"
        }
    }

    // MARK: - Plumbing

    private func forgetPairing() {
        cancelWork()
        pending = nil; credential = nil; origin = nil; lastAcknowledged = nil
        leftApp.reset()
        link = .reconnecting
    }

    private func cancelWork() {
        watchdog?.cancel(); watchdog = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = IdleTimerPolicy.keepAwake(
            active: gate.active, paired: paired, connecting: screen == .connecting)
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        #if DEBUG
        if MockLaptop.enabled { config.protocolClasses = [MockLaptopProtocol.self] }
        #endif
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    private func check(_ generation: Int) throws {
        guard gate.permits(generation), !Task.isCancelled else { throw CancellationError() }
    }
    private func post<T: Decodable>(_ session: URLSession, _ origin: URL, _ path: String, _ body: [String: Any]) async throws -> T {
        var request = URLRequest(url: origin.appendingPathComponent("exam/phone-presence/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PairingError.network }
        if FailurePolicy.classify(statusCode: response.statusCode) == .definiteRejection { throw PairingError.rejected }
        guard response.statusCode == 200 else { throw PairingError.network }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private struct Claim: Decodable { let credential: String }
    private struct Challenge: Decodable { let challenge: String; let sequence: Int }
    private struct Acknowledgement: Decodable { let ok: Bool }
}
