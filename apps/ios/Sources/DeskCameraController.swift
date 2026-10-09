import AVFoundation
import Combine
import SwiftUI
import Vision

/// Optional "desk camera": the rear camera is analysed ON THIS PHONE with Apple's Vision framework.
/// Frames are never stored, displayed anywhere but the local preview, or transmitted. Only the
/// flags in `DeskCameraStatus` leave this object.
///
/// Vision requests used: VNDetectHumanRectanglesRequest (people count) and
/// VNDetectHumanHandPoseRequest (hands near keyboard region). There is no built-in Vision request
/// for "second phone" (VNRecognizeAnimalsRequest only finds cats and dogs), so that check is skipped.
final class DeskCameraController: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    @Published private(set) var running = false
    @Published private(set) var latest: DeskCameraStatus?
    @Published private(set) var message = "Desk camera is off."
    let session = AVCaptureSession()
    /// Called on the main queue, at most every `DeskCameraPolicy.analysisInterval`.
    var onStatus: ((DeskCameraStatus) -> Void)?

    private let queue = DispatchQueue(label: "desk-camera.analysis")
    private var configured = false
    private var lastAnalysis = Date.distantPast // touched only on `queue`

    func start() {
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
        queue.async { [session] in if session.isRunning { session.stopRunning() } }
        running = false
        latest = nil
        message = "Desk camera is off."
    }

    private func deny() { message = "Camera access is off. Allow it in Settings to use the desk camera." }

    private func run() {
        guard configure() else { message = "Rear camera is unavailable (the Simulator has no camera)."; return }
        running = true
        message = "Desk camera is on. Images stay on this phone."
        queue.async { [session] in if !session.isRunning { session.startRunning() } }
    }

    private func configure() -> Bool {
        if configured { return true }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else { return false }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .medium
        guard session.canAddInput(input) else { return false }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        // Low frame rate: we analyse one frame every ~2 s anyway.
        if (try? device.lockForConfiguration()) != nil {
            device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 5)
            device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 5)
            device.unlockForConfiguration()
        }
        configured = true
        return true
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastAnalysis) >= DeskCameraPolicy.analysisInterval,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastAnalysis = now
        let people = VNDetectHumanRectanglesRequest()
        people.upperBodyOnly = false
        let hands = VNDetectHumanHandPoseRequest()
        hands.maximumHandCount = 2
        // Portrait phone, rear camera: sensor frames are rotated 90 degrees.
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .right, options: [:])
        guard (try? handler.perform([people, hands])) != nil else { return }
        let boxes = (people.results ?? []).filter { $0.confidence > 0.5 }.map(\.boundingBox)
        var points: [CGPoint] = []
        for hand in hands.results ?? [] {
            for (_, p) in (try? hand.recognizedPoints(.all)) ?? [:] where p.confidence > 0.3 { points.append(p.location) }
        }
        let status = DeskCameraPolicy.status(personBoxes: boxes, handPoints: points)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.running else { return }
            self.latest = status
            self.onStatus?(status)
        }
    }
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
