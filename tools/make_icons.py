"""
make_icons.py — generates the extension icons with no third-party deps.

Renders a rounded-square gradient badge with a white waveform glyph at 4x
supersampling and writes 16/32/48/128 px PNG files into ../assets.

Usage:
    python tools/make_icons.py
"""

import os
import struct
import zlib

SS = 4  # supersampling factor

STOPS = [
    (0.00, (0x63, 0x66, 0xF1)),  # indigo
    (0.50, (0xA8, 0x55, 0xF7)),  # violet
    (0.78, (0xEC, 0x48, 0x99)),  # pink
    (1.00, (0xF5, 0x9E, 0x0B)),  # amber
]

# Relative heights of the waveform bars (fraction of the icon size).
BARS = [0.30, 0.52, 0.78, 0.52, 0.30]


def lerp(a, b, t):
    return a + (b - a) * t


def gradient(t):
    t = min(1.0, max(0.0, t))
    for i in range(len(STOPS) - 1):
        p0, c0 = STOPS[i]
        p1, c1 = STOPS[i + 1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            return tuple(int(round(lerp(c0[j], c1[j], k))) for j in range(3))
    return STOPS[-1][1]


def rounded_rect_mask(x, y, size, radius):
    """1.0 inside the rounded square, 0.0 outside (hard edges)."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    if dx == 0 and dy == 0:
        return 1.0
    return 1.0 if (dx * dx + dy * dy) <= radius * radius else 0.0


def capsule_mask(x, y, x0, y0, x1, y1, r):
    """Distance-to-segment capsule test."""
    vx = x1 - x0
    vy = y1 - y0
    wx = x - x0
    wy = y - y0
    seg = vx * vx + vy * vy
    t = 0.0 if seg == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / seg))
    px = x0 + t * vx
    py = y0 + t * vy
    dx = x - px
    dy = y - py
    return 1.0 if (dx * dx + dy * dy) <= r * r else 0.0


def render(size):
    """Returns a list of RGBA rows for the given icon size."""
    n = size * SS
    radius = n * 0.22
    bar_w = n * 0.085
    gap = n * 0.055
    total_w = len(BARS) * bar_w + (len(BARS) - 1) * gap
    start_x = (n - total_w) / 2.0
    mid_y = n / 2.0
    cap_r = bar_w / 2.0

    # supersampled buffer
    buf = [[(0, 0, 0, 0)] * n for _ in range(n)]

    for yy in range(n):
        for xx in range(n):
            fx = xx + 0.5
            fy = yy + 0.5

            a = rounded_rect_mask(fx, fy, n, radius)
            if a <= 0.0:
                continue

            r, g, b = gradient((fx + fy) / (2.0 * n))

            # waveform glyph
            for i, h in enumerate(BARS):
                bx = start_x + i * (bar_w + gap) + cap_r
                half = (h * n) / 2.0
                if capsule_mask(fx, fy, bx, mid_y - half, bx, mid_y + half, cap_r) > 0:
                    r, g, b = 255, 255, 255
                    break

            buf[yy][xx] = (r, g, b, int(round(a * 255)))

    # downsample with premultiplied alpha
    rows = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            ar = ag = ab = aa = 0
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = buf[oy * SS + sy][ox * SS + sx]
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a
            cnt = SS * SS
            if aa == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (
                        min(255, int(round(ar / aa))),
                        min(255, int(round(ag / aa))),
                        min(255, int(round(ab / aa))),
                        min(255, int(round(aa / cnt))),
                    )
                )
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        out += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return out

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    assets = os.path.join(here, os.pardir, "assets")
    os.makedirs(assets, exist_ok=True)

    for size in (16, 32, 48, 128):
        rows = render(size)
        out = os.path.join(assets, f"icon{size}.png")
        write_png(out, size, rows)
        print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
