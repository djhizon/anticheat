import AVFoundation
import Combine
import SwiftUI
import Vision

/// Optional "desk camera": the rear camera is analysed ON THIS PHONE with Apple's Vision framework.
/// Frames are never stored or streamed. Only the flags in `DeskCameraStatus` leave this object,
/// plus (rate-limited, via `onEvidence`) ONE still photo when a debounced flag fires.
///
/// Vision requests: VNDetectHumanRectangles + VNDetectFaceRectangles (second person),
/// VNDetectHumanHandPose (up to 4 hands, chirality), VNRecognizeText (fast; only the amount of text
/// is used, never the text), VNDetectRectangles + VNClassifyImage (paper / phone / book hints),
/// plus a luminance check for a covered or dark lens. All run on a background queue at ~2 fps.
final class DeskCameraController: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    @Published private(set) var running = false
    @Published private(set) var latest: DeskCameraStatus?
    @Published private(set) var message = "Desk camera is off."
    let session = AVCaptureSession()
    /// Always invoked on the main actor, at most every `DeskCameraPolicy.analysisInterval`.
    var onStatus: (@MainActor (DeskCameraStatus) -> Void)?
    /// One still (JPEG, <= 640 px wide) when a debounced flag fires: trigger name + bytes.
    /// Rate-limited by `EvidenceLimiter`. Always invoked on the main actor.
    var onEvidence: (@MainActor (String, Data) -> Void)?

    private let queue = DispatchQueue(label: "desk-camera.analysis")
    private var configured = false
    // Touched only on `queue`.
    private var lastAnalysis: TimeInterval = -1000
    private var lastSlow: TimeInterval?
    private var aggregator = DeskCameraAggregator()
    private var limiter = EvidenceLimiter()
    private var fixtureTimer: DispatchSourceTimer?

    func start() {
        #if DEBUG
        if let name = DeskCameraFixtures.requested { startFixture(name); return }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: run()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async { if granted { self?.run() } else { self?.deny() } }
            }
        default: deny()
        }
    }

    func stop() {
        queue.async { [weak self] in self?.fixtureTimer?.cancel(); self?.fixtureTimer = nil }
        queue.async { [session] in if session.isRunning { session.stopRunning() } }
        running = false
        latest = nil
        message = "Desk camera is off."
    }

    #if DEBUG
    /// Simulator UI tests: feed a drawn frame through the same analysis instead of AVCapture.
    private func startFixture(_ name: String) {
        running = true
        message = "Desk camera is on (test fixture: \(name)). Images stay on this phone."
        queue.async { [weak self] in
            guard let self, let buffer = DeskCameraFixtures.buffer(named: name) else { return }
            self.aggregator = DeskCameraAggregator()
            self.fixtureTimer?.cancel()
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: DeskCameraPolicy.analysisInterval)
            timer.setEventHandler { [weak self] in self?.analyze(buffer, orientation: .up) }
            self.fixtureTimer = timer
            timer.resume()
        }
    }
    #endif

    private func deny() { message = "Camera access is off. Allow it in Settings to use the desk camera." }

    private func run() {
        guard configure() else { message = "Rear camera is unavailable (the Simulator has no camera)."; return }
        running = true
        message = "Desk camera is on. Images stay on this phone."
        queue.async { [weak self] in self?.aggregator = DeskCameraAggregator() }
        queue.async { [session] in if !session.isRunning { session.startRunning() } }
    }

    private func configure() -> Bool {
        if configured { return true }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else { return false }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        // Modest input keeps Vision cheap on A12-class phones (iPhone XR); about 2 frames per second are analysed.
        session.sessionPreset = session.canSetSessionPreset(.vga640x480) ? .vga640x480 : .medium
        // On any failure, remove what this attempt added so a retry starts clean.
        var addedInput: AVCaptureInput?
        var addedOutput: AVCaptureOutput?
        func rollback() {
            if let addedOutput { session.removeOutput(addedOutput) }
            if let addedInput { session.removeInput(addedInput) }
        }
        guard session.canAddInput(input) else { return false }
        session.addInput(input)
        addedInput = input
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { rollback(); return false }
        session.addOutput(output)
        addedOutput = output
        // Low frame rate: we analyse about 2 frames per second anyway.
        let wanted = 5.0
        let supported = device.activeFormat.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= wanted && wanted <= $0.maxFrameRate }
        if supported, (try? device.lockForConfiguration()) != nil {
            device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 5)
            device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 5)
            device.unlockForConfiguration()
        }
        configured = true
        return true
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // Portrait phone, rear camera: sensor frames are rotated 90 degrees.
        analyze(buffer, orientation: .right)
    }

    /// Runs on `queue` (never the main thread). Throttled to `analysisInterval`; shared by the camera
    /// and the DEBUG fixture feed so tests exercise the real Vision pipeline.
    private func analyze(_ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        let uptime = ProcessInfo.processInfo.systemUptime
        guard uptime - lastAnalysis >= DeskCameraPolicy.analysisInterval else { return }
        lastAnalysis = uptime
        let slowDue = DeskCameraPolicy.slowTierDue(now: uptime, lastSlow: lastSlow)
        if slowDue { lastSlow = uptime }
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: orientation, options: [:])
        let grid = DeskCameraFrames.lumaGrid(buffer, orientation: orientation)

        // Fast tier. Each request is performed on its own so one failing (e.g. unsupported on the
        // Simulator) does not blind the others.
        let people = VNDetectHumanRectanglesRequest()
        people.upperBodyOnly = false
        let faces = VNDetectFaceRectanglesRequest()
        let hands = VNDetectHumanHandPoseRequest()
        hands.maximumHandCount = 4
        _ = try? handler.perform([people])
        _ = try? handler.perform([faces])
        _ = try? handler.perform([hands])
        var fast = FastObservation()
        fast.personBoxes = (people.results ?? []).filter { $0.confidence > 0.5 }.map(\.boundingBox)
        fast.faces = (faces.results ?? []).filter { $0.confidence > 0.5 }.count
        for hand in hands.results ?? [] {
            var seen = false
            for (_, p) in (try? hand.recognizedPoints(.all)) ?? [:] where p.confidence > 0.3 { fast.handPoints.append(p.location); seen = true }
            guard seen else { continue }
            fast.handCount += 1
            switch hand.chirality {
            case .left: fast.leftHands += 1
            case .right: fast.rightHands += 1
            default: break
            }
        }
        #if DEBUG
        // Vision cannot detect people or hands in drawn frames, so fixtures that stand for them carry the
        // counts a real detection would report. Everything after this point is the production path.
        if let injected = DeskCameraFixtures.injectedCounts {
            fast.personBoxes = Array(repeating: CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.7), count: injected.people)
            fast.handCount = injected.hands
            fast.leftHands = injected.hands / 2; fast.rightHands = injected.hands - injected.hands / 2
        }
        #endif
        if let stats = grid?.stats { fast.obstructed = DeskHeuristics.isObstructed(mean: stats.mean, variance: stats.variance) }

        // Slow tier (about every 2 s): text in the desk region, bright rectangles, object labels.
        var slow: SlowObservation?
        if slowDue {
            var obs = SlowObservation()
            let text = VNRecognizeTextRequest()
            text.recognitionLevel = .fast
            text.usesLanguageCorrection = false
            text.regionOfInterest = DeskHeuristics.deskRegion
            let rects = VNDetectRectanglesRequest()
            rects.maximumObservations = 6
            rects.minimumSize = 0.1
            rects.minimumAspectRatio = 0.3
            rects.minimumConfidence = 0.6
            let classify = VNClassifyImageRequest()
            _ = try? handler.perform([text])
            _ = try? handler.perform([rects])
            _ = try? handler.perform([classify])
            // Only length and confidence of each line are kept; the recognised characters are dropped here.
            let blocks = (text.results ?? []).compactMap { o -> DeskHeuristics.TextBlock? in
                guard let top = o.topCandidates(1).first else { return nil }
                return DeskHeuristics.TextBlock(characters: top.string.filter { !$0.isWhitespace }.count, confidence: top.confidence)
            }
            obs.textVisible = DeskHeuristics.textVisible(blocks)
            if let grid { obs.brightRectangles = DeskHeuristics.brightRectangles((rects.results ?? []).map(\.boundingBox), grid: grid) }
            obs.hints = DeskHeuristics.hints(from: (classify.results ?? []).map { ($0.identifier, $0.confidence) })
            slow = obs
        }

        let output = aggregator.ingest(fast, slow: slow, at: uptime)
        var evidence: [(String, Data)] = []
        let triggers = output.newTriggers.compactMap { DeskHeuristics.evidenceTrigger(flag: $0, hints: output.status.objectHints) }
        for trigger in Set(triggers).sorted() where limiter.allow(trigger, at: uptime) {
            if let jpeg = DeskCameraFrames.jpeg(buffer, orientation: orientation) { evidence.append((trigger, jpeg)) }
        }
        let status = output.status
        Task { @MainActor [weak self] in
            guard let self, self.running else { return }
            if self.latest != status { self.latest = status }
            self.onStatus?(status)
            for (trigger, jpeg) in evidence { self.onEvidence?(trigger, jpeg) }
        }
    }

    /// New exam / new pairing: the evidence budget starts again.
    func resetEvidenceBudget() { queue.async { [weak self] in self?.limiter.reset() } }
}

/// Live local preview. Not captured or sent anywhere.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
