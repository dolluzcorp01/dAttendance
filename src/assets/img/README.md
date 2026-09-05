# Logo assets

`DOLLUZ_CORP*.png` and `logo_eagle.png` are the source artwork. The `app_*`
files are derived from them and are what the app actually imports — the
originals are 1932×1557 / ~137 KB, which is wasteful for a 30px header mark.

| File | Used by | Made from |
|---|---|---|
| `app_eagle.png` | login lockup, app header | `logo_eagle.png`, 132px tall (3× for a 44px render) |
| `app_lockup_reversed.png` | login banner | `DOLLUZ_CORP_reversed.png`, 560px wide |
| `app_eagle_watermark.png` | login banner watermark | `logo_eagle.png`, 760px, flattened to a white silhouette |

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
