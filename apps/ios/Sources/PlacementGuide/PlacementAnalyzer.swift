import AVFoundation
import SwiftUI
import UIKit
import Vision

/// Lightweight framing checks on the desk-camera preview, at most 2 frames per second.
/// It attaches its OWN video-data output to the existing capture session, so it does not touch the
/// desk-camera analysis pipeline. Frames are analysed in memory and discarded; nothing is stored or sent.
/// (If the Vision pipeline later exposes the same signals, feed `ingest(...)` instead of attaching.)
final class PlacementAnalyzer: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    @Published private(set) var personInFrame = false
    @Published private(set) var handsVisible = false
    @Published private(set) var lightingOk = false
    @Published private(set) var hasFrames = false

    static let minInterval: TimeInterval = 0.5   // <= 2 fps
    private static let grace: TimeInterval = 1.5  // a tick stays green this long after the last hit

    private let queue = DispatchQueue(label: "placement-guide.analysis")
    private let lock = NSLock()
    private var output: AVCaptureVideoDataOutput?
    private weak var attachedSession: AVCaptureSession?
    private var lastRun = Date.distantPast       // queue only
    private var lastPerson = Date.distantPast    // queue only
    private var lastHands = Date.distantPast
    private var lastLight = Date.distantPast
    private var _orientation = CGImagePropertyOrientation.up

    /// Thread-safe; set from the main actor when the device orientation changes.
    func setDeviceOrientation(_ o: UIDeviceOrientation) {
        let mapped: CGImagePropertyOrientation
        switch o {
        case .landscapeLeft: mapped = .up        // sensor-native landscape
        case .landscapeRight: mapped = .down
        case .portraitUpsideDown: mapped = .left
        default: mapped = .right
        }
        lock.lock(); _orientation = mapped; lock.unlock()
    }

    func attach(to session: AVCaptureSession) {
        guard output == nil else { return }
        let out = AVCaptureVideoDataOutput()
        out.alwaysDiscardsLateVideoFrames = true
        out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        out.setSampleBufferDelegate(self, queue: queue)
        session.beginConfiguration()
        let ok = session.canAddOutput(out)
        if ok { session.addOutput(out) }
        session.commitConfiguration()
        if ok { output = out; attachedSession = session }
    }

    func detach() {
        if let out = output, let session = attachedSession {
            out.setSampleBufferDelegate(nil, queue: nil)
            session.beginConfiguration()
            session.removeOutput(out)
            session.commitConfiguration()
        }
        output = nil
        attachedSession = nil
        DispatchQueue.main.async { [weak self] in
            self?.personInFrame = false; self?.handsVisible = false; self?.lightingOk = false; self?.hasFrames = false
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastRun) >= Self.minInterval,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastRun = now
        lock.lock(); let orientation = _orientation; lock.unlock()

        let luma = Self.meanLuma(buffer)
        let people = VNDetectHumanRectanglesRequest()
        let hands = VNDetectHumanHandPoseRequest()
        hands.maximumHandCount = 2
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: orientation, options: [:])
        _ = try? handler.perform([people, hands])
        let personHit = (people.results ?? []).contains { $0.confidence > 0.5 }
        var points: [CGPoint] = []
        for hand in hands.results ?? [] {
            for (_, p) in (try? hand.recognizedPoints(.all)) ?? [:] where p.confidence > 0.3 { points.append(p.location) }
        }
        if personHit { lastPerson = now }
        if PlacementPolicy.handsInLowerHalf(points) { lastHands = now }
        if let luma, PlacementPolicy.lightingOk(meanLuma: luma) { lastLight = now } else if luma != nil { lastLight = .distantPast }
        let person = now.timeIntervalSince(lastPerson) < Self.grace
        let handsOk = now.timeIntervalSince(lastHands) < Self.grace
        let light = now.timeIntervalSince(lastLight) < Self.grace
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !self.hasFrames { self.hasFrames = true }
            if self.personInFrame != person { self.personInFrame = person }
            if self.handsVisible != handsOk { self.handsVisible = handsOk }
            if self.lightingOk != light { self.lightingOk = light }
        }
    }

    /// Mean of the Y plane, sampled on a coarse grid. 0 (black) ... 1 (white).
    static func meanLuma(_ buffer: CVPixelBuffer) -> Double? {
        guard CVPixelBufferGetPlaneCount(buffer) > 0 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
        let w = CVPixelBufferGetWidthOfPlane(buffer, 0), h = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var sum = 0, n = 0
        for y in Swift.stride(from: 0, to: h, by: 16) {
            for x in Swift.stride(from: 0, to: w, by: 16) { sum += Int(p[y * stride + x]); n += 1 }
        }
        return n == 0 ? nil : Double(sum) / Double(n) / 255
    }
}

/// Live preview that keeps its video orientation in step with the interface orientation.
struct PlacementPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let connection = previewLayer.connection, let io = window?.windowScene?.interfaceOrientation else { return }
            if #available(iOS 17.0, *) {
                let angle: CGFloat
                switch io {
                case .landscapeRight: angle = 0
                case .landscapeLeft: angle = 180
                case .portraitUpsideDown: angle = 270
                default: angle = 90
                }
                if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
            } else if connection.isVideoOrientationSupported, let o = AVCaptureVideoOrientation(rawValue: io.rawValue) {
                connection.videoOrientation = o
            }
        }
    }
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ uiView: PreviewView, context: Context) { uiView.setNeedsLayout() }
}
