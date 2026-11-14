// Makes the menu bar template images from the logo master: crops the glyphs, keeps their shape as alpha only,
// and writes 18 px and 36 px PNGs.
// Usage: swift scripts/make-menubar-icon.swift assets/brand/overnote-logo-1024.png assets/brand/menubar
import AppKit
let args = CommandLine.arguments
let src = NSImage(contentsOfFile: args[1])!
var r = CGRect(x:0,y:0,width:1024,height:1024)
let cg = src.cgImage(forProposedRect:&r, context:nil, hints:nil)!
// Glyph crop (top-left origin): x 190..830, y 195..835
let crop = cg.cropping(to: CGRect(x:190, y:195, width:640, height:640))!
let w = 640, h = 640
var px = [UInt8](repeating:0, count:w*h*4)
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data:&px, width:w, height:h, bitsPerComponent:8, bytesPerRow:w*4, space:cs, bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(crop, in: CGRect(x:0,y:0,width:w,height:h))
for i in stride(from:0, to:px.count, by:4) {
  let l = (Double(px[i])+Double(px[i+1])+Double(px[i+2]))/3
  let a = max(0, min(1, (l-40)/(110-40)))
  px[i]=0; px[i+1]=0; px[i+2]=0; px[i+3]=UInt8(a*255)
}
let full = ctx.makeImage()!
for (size, name) in [(18,"OvernoteStatusTemplate.png"),(36,"OvernoteStatusTemplate@2x.png")] {
  let o = CGContext(data:nil, width:size, height:size, bitsPerComponent:8, bytesPerRow:0, space:cs, bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
  o.interpolationQuality = .high
  o.draw(full, in: CGRect(x:0,y:0,width:size,height:size))
  let rep = NSBitmapImageRep(cgImage: o.makeImage()!)
  try! rep.representation(using:.png, properties:[:])!.write(to: URL(fileURLWithPath: args[2]+"/"+name))
}
