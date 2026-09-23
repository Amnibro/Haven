from PIL import Image, ImageDraw, ImageFont
import os
out = os.environ.get("HAVEN_DATA_DIR") or os.path.join(os.environ.get("APPDATA", ""), "Haven-AmniScient")
up = os.path.join(out, "uploads")
os.makedirs(up, exist_ok=True)
BOLD = ["C:\\Windows\\Fonts\\segoeuib.ttf", "/usr/share/fonts/noto/NotoSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"]
REGULAR = ["C:\\Windows\\Fonts\\segoeui.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf"]


def font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


ink, gold, paper = (8, 9, 11), (200, 155, 78), (237, 239, 242)
icon = Image.new("RGB", (256, 256), ink)
d = ImageDraw.Draw(icon)
d.rounded_rectangle((18, 18, 238, 238), 28, outline=gold, width=6)
d.text((128, 122), "A", fill=gold, font=font(BOLD, 128), anchor="mm")
icon.save(os.path.join(up, "amni-icon.png"), "PNG")
banner = Image.new("RGB", (1600, 400), ink)
b = ImageDraw.Draw(banner)
for i in range(1600):
    t = i / 1599
    g = int(200 * (0.25 + 0.35 * (1 - abs(t - 0.35))))
    b.line([(i, 0), (i, 400)], fill=(8 + g // 20, 9 + g // 28, 11))
b.rectangle((0, 0, 1599, 399), outline=gold)
big = font(BOLD, 72)
small = font(REGULAR, 28)
b.text((80, 150), "AMNI-SCIENT", fill=gold, font=big, anchor="lm")
b.text((80, 230), "Community Haven  ·  testers, bugs, voice", fill=paper, font=small, anchor="lm")
banner.save(os.path.join(up, "amni-banner.png"), "PNG")
print(os.path.join(up, "amni-icon.png"))
print(os.path.join(up, "amni-banner.png"))
