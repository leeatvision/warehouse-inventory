# brand-default

Neutral placeholders used when there is no `brand/` folder. A brand folder has the same files:

- `brand.json`: `name`, `shortName`, `company`, `description`, `themeColor`, `backgroundColor`,
  `storagePrefix` (device storage name; never change it once devices use the app), `logo` (a file in the
  folder shown in the top bar, or `null`), `supabaseUrl`, `supabaseKey` (publishable key)
- `files` (optional, in brand.json): extra files to copy next to the page, such as a font that brand.css loads
- `brand.css`: `--brand-50`, `--brand-100`, `--brand-500`, `--brand-600`, `--brand-700`, `--on-brand`, light and dark, and optionally `--brand-font`
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, and optionally `favicon.png` for the browser tab (otherwise `icon-192.png` is used)

`scripts/make-default-icons.mjs` redraws the placeholder icons.
