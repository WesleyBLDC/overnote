"""Re-encodes opaque 8-bit RGBA PNGs as RGB with per-row adaptive filtering and zlib level 9.

  python3 -I store-png-opt.py <png>...

Pure Python (no Pillow, no pngquant). Lossless: the pixels stay identical, only the alpha
channel (always 255 here) is dropped. Also prints the corner pixels to spot edge seams.
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    i, idat = 8, b""
    while i < len(data):
        length = struct.unpack(">I", data[i : i + 4])[0]
        kind = data[i + 4 : i + 8]
        body = data[i + 8 : i + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and color in (2, 6) and interlace == 0, (depth, color, interlace)
        elif kind == b"IDAT":
            idat += body
        i += 12 + length
    bpp = 4 if color == 6 else 3
    stride = width * bpp
    raw = zlib.decompress(idat)
    rows, prev, pos = [], bytes(stride), 0
    for _ in range(height):
        f = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = rows[-1]
    return width, height, bpp, rows


def to_rgb(row, bpp):
    if bpp == 3:
        return row
    out = bytearray(len(row) // 4 * 3)
    out[0::3] = row[0::4]
    out[1::3] = row[1::4]
    out[2::3] = row[2::4]
    return bytes(out)


def filtered(row, prev, bpp=3):
    n = len(row)
    left = bytes(bpp) + row[:-bpp]
    upleft = bytes(bpp) + prev[:-bpp]
    sub = bytes((row[x] - left[x]) & 255 for x in range(n))
    up = bytes((row[x] - prev[x]) & 255 for x in range(n))
    avg = bytes((row[x] - ((left[x] + prev[x]) >> 1)) & 255 for x in range(n))
    paeth = bytearray(n)
    for x in range(n):
        a, b, c = left[x], prev[x], upleft[x]
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        paeth[x] = (row[x] - (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    candidates = [(0, row), (1, sub), (2, up), (3, avg), (4, bytes(paeth))]

    def cost(data):
        return sum(v if v < 128 else 256 - v for v in data)

    return min(candidates, key=lambda item: cost(item[1]))


def write_png(path, width, height, rows):
    out, prev = bytearray(), bytes(width * 3)
    for row in rows:
        kind, data = filtered(row, prev)
        out.append(kind)
        out += data
        prev = row

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


for path in sys.argv[1:]:
    width, height, bpp, rows = read_png(path)
    if bpp == 4:
        assert all(r[3::4] == b"\xff" * width for r in rows), f"{path} has transparency"
    rgb = [to_rgb(r, bpp) for r in rows]
    corners = [rgb[0][0:3], rgb[1][3:6], rgb[0][-3:], rgb[-1][0:3]]
    write_png(path, width, height, rgb)
    print(path, width, height, "corners", [tuple(c) for c in corners])
