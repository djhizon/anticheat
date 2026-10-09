// Renders apps/desktop/assets/icon.svg's shapes to a transparent 1024px PNG using AppKit.
// Usage: swiftc render-icon.swift -o render-icon && ./render-icon out.png
// (qlmanage flattens the SVG onto an opaque white background, so we draw the same shapes directly.)
import AppKit

let size = 1024
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
// Flip to SVG coordinates (origin top-left).
let flip = NSAffineTransform()
flip.translateX(by: 0, yBy: CGFloat(size))
flip.scaleX(by: 1, yBy: -1)
flip.concat()

func rgb(_ hex: UInt32) -> NSColor {
  NSColor(
    deviceRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

let tile = NSBezierPath(
  roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
NSGradient(starting: rgb(0x3b82f6), ending: rgb(0x1d4ed8))!.draw(in: tile, angle: 90)

let shield = NSBezierPath()
shield.move(to: NSPoint(x: 512, y: 218))
shield.line(to: NSPoint(x: 734, y: 300))
shield.line(to: NSPoint(x: 734, y: 500))
shield.curve(
  to: NSPoint(x: 512, y: 806), controlPoint1: NSPoint(x: 734, y: 640),
  controlPoint2: NSPoint(x: 640, y: 742))
shield.curve(
  to: NSPoint(x: 290, y: 500), controlPoint1: NSPoint(x: 384, y: 742),
  controlPoint2: NSPoint(x: 290, y: 640))
shield.line(to: NSPoint(x: 290, y: 300))
shield.close()
NSColor.white.setFill()
shield.fill()

let check = NSBezierPath()
check.move(to: NSPoint(x: 410, y: 506))
check.line(to: NSPoint(x: 486, y: 582))
check.line(to: NSPoint(x: 622, y: 430))
check.lineWidth = 58
check.lineCapStyle = .round
check.lineJoinStyle = .round
rgb(0x1d4ed8).setStroke()
check.stroke()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(
  to: URL(fileURLWithPath: CommandLine.arguments[1]))
