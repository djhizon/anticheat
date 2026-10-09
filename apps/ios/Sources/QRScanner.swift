import AVFoundation
import SwiftUI
import UIKit

/// Lightweight QR-only camera: VGA preset, metadata output limited to `.qr`, no frames stored or sent.
/// The camera is used for nothing else in this app.
final class QRScanner: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate {
    enum Availability: Equatable { case starting, running, unavailable, denied }

    @Published private(set) var availability: Availability = .starting
    let session = AVCaptureSession()
    /// Called on the main queue with each decoded QR string (deduplicated while the same code stays in view).
    var onCode: ((String) -> Void)?
    private let queue = DispatchQueue(label: "com.djhizon.examcompanion.qr")
    private var configured = false
    private var lastCode: String?
    private var lastCodeAt = Date.distantPast

    func start() {
        // The Simulator has no camera: report it before asking for permission.
        guard AVCaptureDevice.default(for: .video) != nil else { availability = .unavailable; return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: run()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.run() : (self.availability = .denied) }
            }
        default: availability = .denied
        }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    private func run() {
        queue.async {
            if !self.configured { self.configured = self.configure() }
            guard self.configured else {
                DispatchQueue.main.async { self.availability = .unavailable }
                return
            }
            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { self.availability = .running }
        }
    }

    private func configure() -> Bool {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: .main)
        return true
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let value = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        let now = Date()
        // The same code is reported many times a second; pass it on again only after a pause.
        if value == lastCode && now.timeIntervalSince(lastCodeAt) < 3 { return }
        lastCode = value; lastCodeAt = now
        onCode?(value)
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        // Safe: layerClass above guarantees the backing layer type.
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
