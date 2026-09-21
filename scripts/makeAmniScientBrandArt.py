from PIL import Image, ImageDraw, ImageFont
import os
out = os.environ.get("HAVEN_DATA_DIR") or os.path.join(os.environ.get("APPDATA", ""), "Haven-AmniScient")
up = os.path.join(out, "uploads")
os.makedirs(up, exist_ok=True)
ink, gold, paper = (8, 9, 11), (200, 155, 78), (237, 239, 242)
icon = Image.new("RGB", (256, 256), ink)
d = ImageDraw.Draw(icon)
d.rounded_rectangle((18, 18, 238, 238), 28, outline=gold, width=6)
try:
    font = ImageFont.truetype("C:\\Windows\\Fonts\\segoeuib.ttf", 128)
except OSError:
    font = ImageFont.load_default()
d.text((128, 122), "A", fill=gold, font=font, anchor="mm")
icon.save(os.path.join(up, "amni-icon.png"), "PNG")
banner = Image.new("RGB", (1600, 400), ink)
b = ImageDraw.Draw(banner)
for i in range(1600):
    t = i / 1599
    g = int(200 * (0.25 + 0.35 * (1 - abs(t - 0.35))))
    b.line([(i, 0), (i, 400)], fill=(8 + g // 20, 9 + g // 28, 11))
b.rectangle((0, 0, 1599, 399), outline=gold)
try:
    big = ImageFont.truetype("C:\\Windows\\Fonts\\segoeuib.ttf", 72)
    small = ImageFont.truetype("C:\\Windows\\Fonts\\segoeui.ttf", 28)
except OSError:
    big = small = ImageFont.load_default()
b.text((80, 150), "AMNI-SCIENT", fill=gold, font=big, anchor="lm")
b.text((80, 230), "Community Haven  ·  testers, bugs, voice", fill=paper, font=small, anchor="lm")
banner.save(os.path.join(up, "amni-banner.png"), "PNG")
print(os.path.join(up, "amni-icon.png"))
print(os.path.join(up, "amni-banner.png"))
