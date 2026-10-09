import Foundation
import Combine
import UIKit

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward a pairing/heartbeat secret to a redirected host.
    }
}

@MainActor final class PresenceController: ObservableObject {
    @Published private(set) var status = "Scan the pairing QR on your laptop."
    @Published private(set) var pending: PairingLink?
    @Published private(set) var paired = false
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var lastAcknowledged: Date?
    /// Optional, opt-in, additive. Heartbeat behaviour does not depend on it.
    @Published private(set) var deskCameraWanted = false
    let deskCamera = DeskCameraController()
    private var lastDeskSend: Date?
    private var gate = ForegroundGate()
    private var task: Task<Void, Never>?
    private var session: URLSession?
    private var origin: URL?
    private var credential: String?

    static var allowsDemoHTTP: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    func setDeskCamera(_ on: Bool) {
        deskCameraWanted = on
        lastDeskSend = nil
        if on && gate.active && paired { startDeskCamera() } else { deskCamera.stop() }
    }

    private func startDeskCamera() {
        deskCamera.onStatus = { [weak self] status in self?.sendDesk(status) }
        deskCamera.start()
    }

    /// Flags only, same credential as the heartbeat, at most every 5 s. Failures are ignored:
    /// the heartbeat loop owns connection status and the desk camera is best-effort.
    private func sendDesk(_ status: DeskCameraStatus) {
        let now = Date()
        guard DeskCameraPolicy.shouldSend(now: now, lastSent: lastDeskSend),
              let session, let origin, let credential, paired, gate.active else { return }
        lastDeskSend = now
        Task { [weak self] in
            guard let self else { return }
            let _: Acknowledgement? = try? await self.post(session, origin, "desk-camera", [
                "credential": credential, "people": status.people,
                "handsVisible": status.handsVisible, "framingOk": status.framingOk
            ])
        }
    }

    func acceptLink(_ value: String) {
        do {
            let link = try PairingLink(value, allowHTTP: Self.allowsDemoHTTP)
            stopAndForget()
            pending = link
            status = "Confirm the laptop address, then connect."
        } catch { status = "Invalid pairing link. Use a fresh QR from your laptop; Release builds require HTTPS." }
    }

    func setActive(_ active: Bool) {
        gate.transition(active: active)
        cancelWork()
        if !active { deskCamera.stop() }
        if !active {
            status = paired ? "Paused — app is not active. Laptop will pause answering." : "Open the app to pair."
        } else if let origin, let credential {
            begin(origin: origin, credential: credential, pairingCode: nil)
        } else {
            status = pending == nil ? "Scan the laptop QR to pair." : "Confirm the laptop address, then connect."
        }
        UIApplication.shared.isIdleTimerDisabled = IdleTimerPolicy.keepAwake(active: active, paired: paired, reconnecting: busy || credential != nil)
        if active && paired && deskCameraWanted { startDeskCamera() }
    }

    func connect(acceptInsecureDemo: Bool) {
        guard gate.active, !busy, let pending, !pending.isHTTP || acceptInsecureDemo else { return }
        begin(origin: pending.origin, credential: nil, pairingCode: pending.code)
    }

    func stopAndForget() {
        gate.transition(active: gate.active)
        cancelWork()
        deskCamera.stop(); deskCameraWanted = false
        credential = nil; origin = nil; pending = nil; paired = false; lastAcknowledged = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = "Stopped. Laptop answering pauses after its timeout. Re-pair to connect again."
    }

    private func cancelWork() {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        busy = false; connected = false
    }

    private func begin(origin: URL, credential: String?, pairingCode: String?) {
        cancelWork()
        let generation = gate.generation
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        self.session = session
        busy = true
        status = pairingCode == nil ? "Reconnecting…" : "Pairing…"
        UIApplication.shared.isIdleTimerDisabled = IdleTimerPolicy.keepAwake(active: gate.active, paired: paired, reconnecting: true)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                var secret = credential
                if let pairingCode {
                    secret = try await self.claimWithRetry(session, origin, pairingCode, generation)
                    self.pending = nil
                }
                guard let secret else { throw PairingError.rejected }
                self.credential = secret; self.origin = origin; self.paired = true; self.busy = false
                UIApplication.shared.isIdleTimerDisabled = true
                var rejections = RejectionTracker()
                let clock = ContinuousClock()
                while self.gate.permits(generation) && !Task.isCancelled {
                    let started = clock.now
                    do {
                        try self.check(generation)
                        let challenge: Challenge = try await self.post(session, origin, "challenge", ["credential": secret])
                        try self.check(generation)
                        let ack: Acknowledgement = try await self.post(session, origin, "heartbeat", [
                            "credential": secret, "challenge": challenge.challenge, "sequence": challenge.sequence, "active": true
                        ])
                        try self.check(generation)
                        guard ack.ok else { throw PairingError.rejected }
                        rejections.recordSuccess()
                        self.connected = true; self.lastAcknowledged = Date()
                        self.status = "Connected — keep this app open."
                    } catch PairingError.rejected {
                        // Credentials survive an API restart and a claim code is single-use, so the only
                        // thing the protocol allows is one fresh challenge before giving up.
                        try self.check(generation)
                        if rejections.recordRejection() == .giveUp { throw PairingError.rejected }
                        self.connected = false
                        self.status = "Reconnecting…"
                    } catch {
                        try self.check(generation)
                        self.connected = false
                        self.status = "Connection lost — check Wi-Fi and laptop servers. Retrying while open…"
                    }
                    let elapsed = started.duration(to: clock.now)
                    let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
                    try await Task.sleep(nanoseconds: UInt64(HeartbeatSchedule.sleepSeconds(elapsed: seconds) * 1e9))
                }
            } catch PairingError.network {
                // Pairing never completed (retries exhausted); keep the unused QR so the user can tap Connect again.
                guard self.gate.permits(generation), !Task.isCancelled else { return }
                self.busy = false; self.connected = false
                self.status = "Could not reach the laptop. Check Wi-Fi, then tap Connect to try again."
                UIApplication.shared.isIdleTimerDisabled = IdleTimerPolicy.keepAwake(active: self.gate.active, paired: self.paired, reconnecting: false)
            } catch {
                guard self.gate.permits(generation), !Task.isCancelled else { return }
                self.busy = false; self.connected = false
                self.status = "Pairing expired, was replaced, or was rejected. Create a new QR on the laptop."
                self.credential = nil; self.paired = false; self.pending = nil
                self.deskCamera.stop()
                UIApplication.shared.isIdleTimerDisabled = false
            }
        }
    }

    /// Probe + claim. Transient failures retry with backoff while the QR stays pending; only a definite
    /// rejection (401/403/404/410) surfaces as `.rejected`.
    private func claimWithRetry(_ session: URLSession, _ origin: URL, _ code: String, _ generation: Int) async throws -> String {
        var attempt = 1
        while true {
            do {
                // The Local Network permission alert can make the scene inactive.
                // Trigger it without a one-use secret, then recheck before claiming.
                var probe = URLRequest(url: origin)
                probe.httpMethod = "HEAD"
                _ = try await session.data(for: probe)
                try check(generation)
                let claim: Claim = try await post(session, origin, "claim", ["code": code])
                try check(generation)
                guard claim.credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw PairingError.rejected }
                return claim.credential
            } catch PairingError.rejected {
                throw PairingError.rejected
            } catch {
                try check(generation)
                guard let delay = PairingRetryPolicy.delayAfter(attempt: attempt) else { throw PairingError.network }
                status = "Reconnecting…"
                try await Task.sleep(nanoseconds: UInt64(delay * 1e9))
                try check(generation)
                attempt += 1
            }
        }
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
