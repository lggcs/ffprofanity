/**
 * Generate 🙊 emoji icons for the extension.
 *
 * Icons are pre-generated PNGs using the NotoColorEmoji font.
 * To regenerate, run the Python script:
 *
 *   python3 -c "
 *   from PIL import Image, ImageDraw, ImageFont
 *   import os
 *   SIZES = [16, 32, 48, 128]
 *   ICON_DIR = os.path.dirname(os.path.abspath(__file__))
 *   EMOJI = '🙊'
 *   BG_COLOR = '#4a148c'
 *   font = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 96)
 *   for size in SIZES:
 *       img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
 *       draw = ImageDraw.Draw(img)
 *       radius = max(2, size // 8)
 *       draw.rounded_rectangle([(0, 0), (size-1, size-1)], radius=radius, fill=BG_COLOR)
 *       font_resized = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', int(size * 0.75))
 *       bbox = draw.textbbox((0, 0), EMOJI, font=font_resized)
 *       tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
 *       x = (size - tw) / 2 - bbox[0]
 *       y = (size - th) / 2 - bbox[1]
 *       draw.text((x, y), EMOJI, font=font_resized, embedded_color=True)
 *       img.save(os.path.join(ICON_DIR, f'icon-{size}.png'), 'PNG')
 *   "
 */

const ICON_SIZES = [16, 32, 48, 128];

export { ICON_SIZES };