# Static assets

Served by `src/index.ts` and referenced from the page metadata in `src/site.ts`.

| File | Purpose |
| --- | --- |
| `logo.png` | Original artwork. Every icon below is derived from it. |
| `favicon.ico` | 32px + 16px, PNG-embedded. Some crawlers only look here. |
| `favicon.png` | 512px. What the x402 indexer records as the merchant logo. |
| `favicon.svg` | The 180px raster wrapped in SVG, keeping an already-indexed URL alive. |
| `apple-touch-icon.png` | 180px, for iOS home-screen bookmarks. |
| `og.svg` / `og.png` | Social and preview card, 1200x630. |

## Regenerating the card

Edit `og.svg`, then rasterise it — XML comments cannot contain a double hyphen,
which is why the command lives here rather than inside the file:

```bash
cd public && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --screenshot=og.png \
  --window-size=1200,630 --force-device-scale-factor=1 "file://$PWD/og.svg"
```

`qlmanage` renders onto a square canvas and crops, so it cannot produce 1200x630.

## Regenerating the icons

From `logo.png`, trim the white margin to a centred square, then resize. The
artwork is dark-on-white, so the icons keep their white background rather than
being made transparent, which would erase the mark on a dark browser tab.
