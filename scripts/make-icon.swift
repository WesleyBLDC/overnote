#!/usr/bin/env swift
// Draws the Better Notes extension icon (512 x 512 PNG) with AppKit only, so it is reproducible:
//   swift scripts/make-icon.swift assets/extension-icon.png
// Design: a teal to indigo rounded square holding a floating white note card with a folded corner,
// three text lines, and a warm accent caret.

import AppKit

let size: CGFloat = 512
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/extension-icon.png"

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha
  )
}

guard
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0),
  let context = NSGraphicsContext(bitmapImageRep: bitmap)
else {
  fatalError("Could not create a drawing context")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
let cg = context.cgContext

// Background: rounded square with a diagonal gradient, inset so the shadow-free tile breathes.
let inset: CGFloat = 24
let tile = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let tilePath = NSBezierPath(roundedRect: tile, xRadius: 108, yRadius: 108)
NSGradient(colors: [color(0x0F766E), color(0x3730A3)])!.draw(in: tilePath, angle: -50)

// Soft highlight across the top of the tile.
NSGraphicsContext.saveGraphicsState()
tilePath.addClip()
NSGradient(colors: [color(0xFFFFFF, 0.18), color(0xFFFFFF, 0)])!.draw(
  in: NSRect(x: tile.minX, y: tile.midY, width: tile.width, height: tile.height / 2), angle: -90)
NSGraphicsContext.restoreGraphicsState()

// Note card, tilted slightly so it reads as floating.
cg.saveGState()
cg.translateBy(x: size / 2, y: size / 2)
cg.rotate(by: -0.07)
cg.translateBy(x: -size / 2, y: -size / 2)

let card = NSRect(x: 132, y: 112, width: 248, height: 296)
let fold: CGFloat = 64

let shadow = NSShadow()
shadow.shadowColor = color(0x000000, 0.28)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)

let cardPath = NSBezierPath()
cardPath.move(to: NSPoint(x: card.minX + 22, y: card.minY))
cardPath.line(to: NSPoint(x: card.maxX - 22, y: card.minY))
cardPath.appendArc(
  withCenter: NSPoint(x: card.maxX - 22, y: card.minY + 22), radius: 22, startAngle: 270, endAngle: 360)
cardPath.line(to: NSPoint(x: card.maxX, y: card.maxY - fold))
cardPath.line(to: NSPoint(x: card.maxX - fold, y: card.maxY))
cardPath.line(to: NSPoint(x: card.minX + 22, y: card.maxY))
cardPath.appendArc(
  withCenter: NSPoint(x: card.minX + 22, y: card.maxY - 22), radius: 22, startAngle: 90, endAngle: 180)
cardPath.line(to: NSPoint(x: card.minX, y: card.minY + 22))
cardPath.appendArc(
  withCenter: NSPoint(x: card.minX + 22, y: card.minY + 22), radius: 22, startAngle: 180, endAngle: 270)
cardPath.close()

NSGraphicsContext.saveGraphicsState()
shadow.set()
color(0xFFFFFF).setFill()
cardPath.fill()
NSGraphicsContext.restoreGraphicsState()

// Folded corner.
let foldPath = NSBezierPath()
foldPath.move(to: NSPoint(x: card.maxX - fold, y: card.maxY))
foldPath.line(to: NSPoint(x: card.maxX - fold, y: card.maxY - fold + 12))
foldPath.appendArc(
  withCenter: NSPoint(x: card.maxX - fold + 12, y: card.maxY - fold + 12), radius: 12, startAngle: 180,
  endAngle: 270)
foldPath.line(to: NSPoint(x: card.maxX, y: card.maxY - fold))
foldPath.close()
color(0xCBD5E1).setFill()
foldPath.fill()

// Text lines: a bold title line and two body lines.
func line(_ y: CGFloat, _ width: CGFloat, _ height: CGFloat, _ fill: NSColor) {
  fill.setFill()
  NSBezierPath(
    roundedRect: NSRect(x: card.minX + 36, y: y, width: width, height: height), xRadius: height / 2,
    yRadius: height / 2
  ).fill()
}
line(card.maxY - 92, 120, 24, color(0x1E293B))
line(card.maxY - 148, 176, 16, color(0x94A3B8))
line(card.maxY - 188, 150, 16, color(0x94A3B8))
line(card.maxY - 228, 96, 16, color(0x94A3B8))

// Accent caret after the last line.
color(0xF59E0B).setFill()
NSBezierPath(
  roundedRect: NSRect(x: card.minX + 36 + 96 + 14, y: card.maxY - 238, width: 10, height: 36), xRadius: 5,
  yRadius: 5
).fill()

cg.restoreGState()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fatalError("Could not encode the PNG")
}
do {
  try png.write(to: URL(fileURLWithPath: output))
  print("Wrote \(output)")
} catch {
  fatalError("Could not write \(output): \(error)")
}
