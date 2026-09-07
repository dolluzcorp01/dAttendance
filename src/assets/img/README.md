# Logo assets

`DOLLUZ_CORP*.png` and `logo_eagle.png` are the source artwork. The `app_*`
files are derived from them and are what the app actually imports — the
originals are 1932×1557 / ~137 KB, which is wasteful for a 30px header mark.

| File | Used by | Made from |
|---|---|---|
| `app_eagle.png` | login lockup, app header | `logo_eagle.png`, 132px tall (3× for a 44px render) |
| `app_lockup_reversed.png` | login banner | `DOLLUZ_CORP_reversed.png`, 560px wide |
| `app_eagle_watermark.png` | login banner watermark | `logo_eagle.png`, 760px, flattened to a white silhouette |
| `app_excel_logo.png` | the downloaded .xlsx, cell C1:C2 | `DOLLUZ_Full_Logo.png` on a **white panel**, 640×640 |

`app_excel_logo.png` needs the white panel. `DOLLUZ_Full_Logo.png` is a black
wordmark on transparency, and C1:C2 in the workbook is navy — dropped in raw,
the words disappear. The original spreadsheet solves this the same way, with a
white-backed 640×640 PNG anchored over the navy cell.

```python
from PIL import Image
src = Image.open('DOLLUZ_Full_Logo.png').convert('RGBA')
src = src.crop(src.getbbox())
w, h = src.size; side = max(w, h); pad = int(side * 0.09)
c = Image.new('RGB', (side + pad*2, side + pad*2), (255, 255, 255))
c.paste(src, (pad + (side - w)//2, pad + (side - h)//2), src)
c.resize((640, 640), Image.LANCZOS).save('app_excel_logo.png', optimize=True)
```

The watermark renders at ~5% opacity, so it is stored as a two-channel
greyscale+alpha silhouette rather than the gold gradient: visually identical
there, and a third of the size.

Regenerate with Pillow:

```python
from PIL import Image
im = Image.open('logo_eagle.png').convert('RGBA')
im = im.crop(im.getbbox())            # drop the transparent margin first
th = 132; tw = round(im.size[0] * th / im.size[1])
im.resize((tw, th), Image.LANCZOS).save('app_eagle.png', optimize=True)
```

The favicons in `public/` (`favicon.ico`, `logo64/192/512.png`) come from the
same eagle, cropped square.
