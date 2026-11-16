"""生成 DSH 手机通道的启动图标（多密度 PNG）。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))


def rounded(size, radius):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def draw_icon(size):
    img = rounded(size, int(size * 0.22))
    d = ImageDraw.Draw(img)
    # 背景：深色圆角方块 + 蓝绿渐变斜切
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=(11, 13, 16, 255))
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(43 + (94 - 43) * t)
        g = int(108 + (226 - 108) * t)
        b = int(255 + (160 - 255) * t)
        gd.line([(0, y), (size, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    # 中间：手机轮廓（圆角矩形描边）+ 一条聊天气泡
    s = size
    lw = max(2, int(s * 0.055))
    phone = [int(s * 0.31), int(s * 0.19), int(s * 0.69), int(s * 0.81)]
    d.rounded_rectangle(phone, radius=int(s * 0.11), outline=(11, 13, 16, 255), width=lw)
    # 听筒
    d.rounded_rectangle(
        [int(s * 0.44), int(s * 0.235), int(s * 0.56), int(s * 0.235) + max(2, int(s * 0.02))],
        radius=int(s * 0.01), fill=(11, 13, 16, 255))
    # 气泡
    bub = [int(s * 0.40), int(s * 0.40), int(s * 0.60), int(s * 0.505)]
    d.rounded_rectangle(bub, radius=int(s * 0.05), fill=(11, 13, 16, 255))
    d.polygon(
        [(int(s * 0.44), int(s * 0.50)), (int(s * 0.44), int(s * 0.565)), (int(s * 0.505), int(s * 0.505))],
        fill=(11, 13, 16, 255))
    # 三个点
    for i, fx in enumerate((0.452, 0.50, 0.548)):
        r = max(1, int(s * 0.016))
        cx, cy = int(s * fx), int(s * 0.4525)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(94, 226, 160, 255))
    return img


SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

for density, px in SIZES.items():
    folder = os.path.join(OUT, "res", "mipmap-" + density)
    os.makedirs(folder, exist_ok=True)
    icon = draw_icon(px)
    icon.save(os.path.join(folder, "ic_launcher.png"))
    print("wrote", os.path.join(folder, "ic_launcher.png"), px)

# 额外生成一张 512 的，用于文档/商店展示
draw_icon(512).save(os.path.join(OUT, "icon-512.png"))
print("wrote icon-512.png")
