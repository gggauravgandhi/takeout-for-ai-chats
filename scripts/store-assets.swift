// Draws the Chrome Web Store promo images with AppKit (system font, no dependencies).
// Run: swift scripts/store-assets.swift   Writes store/promo-small-440x280.png and store/marquee-1400x560.png.
// Shapes mirror icons/icon.svg on its 128 unit grid.
import AppKit

let navy = NSColor(srgbRed: 0x1E / 255, green: 0x3A / 255, blue: 0x5F / 255, alpha: 1)
let navyDeep = NSColor(srgbRed: 0x12 / 255, green: 0x25 / 255, blue: 0x40 / 255, alpha: 1)
let soft = NSColor(srgbRed: 0xC7 / 255, green: 0xD7 / 255, blue: 0xEA / 255, alpha: 1)
let green = NSColor(srgbRed: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255, alpha: 1)

/// Draws into a top-left-origin canvas of exact pixel size (no Retina doubling), saves an opaque PNG.
func render(_ width: Int, _ height: Int, to path: String, draw: (CGRect) -> Void) {
  // noneSkipLast: no alpha channel, so the PNG is plain 24-bit as the store asks.
  let cg = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  cg.translateBy(x: 0, y: CGFloat(height))
  cg.scaleBy(x: 1, y: -1)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
  draw(CGRect(x: 0, y: 0, width: width, height: height))
  NSGraphicsContext.restoreGraphicsState()
  let rep = NSBitmapImageRep(cgImage: cg.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func background(_ bounds: CGRect) {
  NSGradient(starting: navy, ending: navyDeep)!.draw(in: bounds, angle: -90)
}

/// The app mark: a white rounded tile with the navy arrow-into-tray, `size` points wide at (x, y).
func mark(x: CGFloat, y: CGFloat, size: CGFloat) {
  let u = size / 128
  NSColor.white.setFill()
  NSBezierPath(roundedRect: CGRect(x: x + 5 * u, y: y + 5 * u, width: 118 * u, height: 118 * u),
    xRadius: 28 * u, yRadius: 28 * u).fill()
  navy.setFill()
  for r in [(56, 23, 16, 38), (31, 72, 10, 30), (87, 72, 10, 30), (31, 92, 66, 10)] {
    NSBezierPath(rect: CGRect(x: x + CGFloat(r.0) * u, y: y + CGFloat(r.1) * u,
      width: CGFloat(r.2) * u, height: CGFloat(r.3) * u)).fill()
  }
  let arrow = NSBezierPath()
  arrow.move(to: CGPoint(x: x + 38 * u, y: y + 59 * u))
  arrow.line(to: CGPoint(x: x + 90 * u, y: y + 59 * u))
  arrow.line(to: CGPoint(x: x + 64 * u, y: y + 87 * u))
  arrow.close()
  arrow.fill()
}

/// Draws text with its top-left corner at (x, y); returns the height used.
@discardableResult
func text(_ string: String, x: CGFloat, y: CGFloat, size: CGFloat, weight: NSFont.Weight,
  color: NSColor, width: CGFloat = 2000) -> CGFloat {
  let style = NSMutableParagraphStyle()
  style.lineHeightMultiple = 1.08
  let attributed = NSAttributedString(string: string, attributes: [
    .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: style,
  ])
  let box = attributed.boundingRect(with: CGSize(width: width, height: 2000),
    options: [.usesLineFragmentOrigin, .usesFontLeading])
  attributed.draw(with: CGRect(x: x, y: y, width: width, height: box.height),
    options: [.usesLineFragmentOrigin, .usesFontLeading])
  return box.height
}

func check(x: CGFloat, y: CGFloat, size: CGFloat) {
  let path = NSBezierPath()
  path.lineWidth = size * 0.16
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  path.move(to: CGPoint(x: x + size * 0.15, y: y + size * 0.52))
  path.line(to: CGPoint(x: x + size * 0.4, y: y + size * 0.76))
  path.line(to: CGPoint(x: x + size * 0.86, y: y + size * 0.26))
  green.setStroke()
  path.stroke()
}

try? FileManager.default.createDirectory(atPath: "store", withIntermediateDirectories: true)

render(440, 280, to: "store/promo-small-440x280.png") { bounds in
  background(bounds)
  mark(x: 36, y: 92, size: 96)
  text("Takeout for\nAI Chats", x: 156, y: 78, size: 30, weight: .bold, color: .white, width: 260)
  text("Save your ChatGPT chats\nto your computer", x: 156, y: 170, size: 16, weight: .medium, color: soft, width: 260)
}

render(1400, 560, to: "store/marquee-1400x560.png") { bounds in
  background(bounds)
  mark(x: 1000, y: 140, size: 280)
  var y: CGFloat = 136
  y += text("Takeout for AI Chats", x: 112, y: y, size: 64, weight: .bold, color: .white, width: 820) + 12
  y += text("Save every ChatGPT chat, image and setting to your computer.",
    x: 112, y: y, size: 26, weight: .regular, color: soft, width: 780) + 40
  for line in ["Works with Team and Business workspaces", "Readable Markdown plus raw JSON for every chat",
    "Pause and resume anytime. Nothing leaves your computer."] {
    check(x: 112, y: y + 4, size: 28)
    y += text(line, x: 156, y: y, size: 24, weight: .medium, color: .white, width: 760) + 14
  }
}
print("Wrote store/promo-small-440x280.png and store/marquee-1400x560.png")
