import CoreImage
import CoreVideo
import ImageIO
import UIKit

/// Pixel-buffer helpers for the desk camera. Everything stays in memory on the phone.
enum DeskCameraFrames {
    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// 32x32 upright luminance grid. Handles the camera's planar YUV and BGRA buffers and maps
    /// the grid through `orientation` so it lines up with Vision's (upright) coordinates.
    static func lumaGrid(_ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, size: Int = 32) -> LumaGrid? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let planar = CVPixelBufferIsPlanar(buffer)
        let w = planar ? CVPixelBufferGetWidthOfPlane(buffer, 0) : CVPixelBufferGetWidth(buffer)
        let h = planar ? CVPixelBufferGetHeightOfPlane(buffer, 0) : CVPixelBufferGetHeight(buffer)
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) : CVPixelBufferGetBytesPerRow(buffer)
        guard let base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, 0) : CVPixelBufferGetBaseAddress(buffer),
              w > 0, h > 0 else { return nil }
        if !planar && CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA { return nil }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var out = [UInt8](repeating: 0, count: size * size)
        for gy in 0..<size {
            for gx in 0..<size {
                let xo = (Double(gx) + 0.5) / Double(size) // upright, origin top-left
                let yo = (Double(gy) + 0.5) / Double(size)
                let (sx, sy): (Double, Double) = orientation == .right ? (yo, 1 - xo) : (xo, yo)
                let px = min(w - 1, max(0, Int(sx * Double(w))))
                let py = min(h - 1, max(0, Int(sy * Double(h))))
                if planar {
                    out[gy * size + gx] = bytes[py * stride + px]
                } else {
                    let o = py * stride + px * 4 // BGRA
                    let y = 0.114 * Double(bytes[o]) + 0.587 * Double(bytes[o + 1]) + 0.299 * Double(bytes[o + 2])
                    out[gy * size + gx] = UInt8(min(255, y))
                }
            }
        }
        return LumaGrid(width: size, height: size, samples: out)
    }

    /// One still, at most 640 px wide, JPEG quality ~0.6, shrunk further if it would exceed ~150 KB.
    static func jpeg(_ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, maxWidth: CGFloat = 640) -> Data? {
        var image = CIImage(cvPixelBuffer: buffer).oriented(orientation)
        let scale = min(1, maxWidth / image.extent.width)
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        guard let cg = ciContext.createCGImage(image, from: image.extent) else { return nil }
        let ui = UIImage(cgImage: cg)
        var best: Data?
        for quality in [0.6, 0.5, 0.4, 0.3] as [CGFloat] {
            guard let data = ui.jpegData(compressionQuality: quality) else { continue }
            best = data
            if data.count <= 150_000 { break }
        }
        return best
    }
}

#if DEBUG
/// Synthetic frames for simulator UI tests (`-UITestFixtureFrames <name>`). They are drawn in code,
/// so the repo contains no photos. Vision does not detect people or hands in drawings, so the
/// person/hand flags are covered by the pure-logic unit tests; text, bright rectangles and
/// darkness do work on drawn frames.
enum DeskCameraFixtures {
    static let names = ["empty_desk", "paper_text", "bright_paper", "dark", "one_person", "two_people", "extra_hands"]
    /// Counts injected in place of Vision's people/hand detections for the drawn person frames.
    static var injectedCounts: (people: Int, hands: Int)? {
        switch requested {
        case "one_person": return (1, 2)
        case "two_people": return (2, 2)
        case "extra_hands": return (1, 3)
        default: return nil
        }
    }
    static var requested: String? {
        guard let name = UserDefaults.standard.string(forKey: "UITestFixtureFrames"), names.contains(name) else { return nil }
        return name
    }

    static func buffer(named name: String) -> CVPixelBuffer? {
        let size = CGSize(width: 640, height: 480)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let c = ctx.cgContext
            func fill(_ color: UIColor, _ rect: CGRect) { c.setFillColor(color.cgColor); c.fill(rect) }
            if name == "dark" { fill(UIColor(white: 0.01, alpha: 1), CGRect(origin: .zero, size: size)); return }
            fill(UIColor(white: 0.3, alpha: 1), CGRect(origin: .zero, size: size))
            // Some structure above the desk so the frame is not "featureless".
            for i in 0..<8 { fill(UIColor(white: 0.18 + 0.05 * CGFloat(i % 3), alpha: 1), CGRect(x: 40 + i * 70, y: 40, width: 50, height: 120)) }
            // Simple silhouettes for the person frames (decorative; see injectedCounts).
            let people = name == "two_people" ? 2 : (name == "one_person" || name == "extra_hands" ? 1 : 0)
            for i in 0..<people {
                let cx = people == 2 ? 200 + CGFloat(i) * 240 : 320
                fill(UIColor(white: 0.75, alpha: 1), CGRect(x: cx - 30, y: 90, width: 60, height: 60))
                fill(UIColor(white: 0.55, alpha: 1), CGRect(x: cx - 55, y: 155, width: 110, height: 150))
            }
            guard name == "paper_text" || name == "bright_paper" else { return }
            let paper = CGRect(x: 100, y: 270, width: 440, height: 190) // lower (desk) area
            fill(.white, paper)
            guard name == "paper_text" else { return }
            let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 30, weight: .bold), .foregroundColor: UIColor.black]
            for (i, line) in ["EXAM ANSWERS NOTES", "FORMULA SHEET HERE", "CHAPTER SUMMARY TEXT"].enumerated() {
                (line as NSString).draw(at: CGPoint(x: 120, y: 285 + CGFloat(i) * 52), withAttributes: attrs)
            }
        }
        guard let cg = image.cgImage else { return nil }
        var buffer: CVPixelBuffer?
        let attrs = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        CVPixelBufferCreate(nil, 640, 480, kCVPixelFormatType_32BGRA, attrs, &buffer)
        guard let buffer else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 640, height: 480, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 640, height: 480))
        return buffer
    }
}
#endif
