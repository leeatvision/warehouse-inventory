# warehouse-tracker

A tablet-first web app for a small warehouse: a catalogue of Consumables and Equipment, Take outs and Returns
charged to Job codes, Equipment check-out, Corrections, pick lists, purchase orders, stock counts, low-stock and
date alerts, and reports. It works offline and sends entries when the connection comes back. Each Take out is
delivered as a PDF billing document per Cart and Job code to a Google Drive folder.

- Plain HTML, CSS and JavaScript, no framework and no runtime dependencies (one vendored MIT QR code library).
- Data and logic in Supabase (Postgres functions); see `supabase/migrations/`.
- The public code is neutral. Company branding is pulled in at build time; without it you get placeholders.

Start with [`docs/setup.md`](docs/setup.md), the feature list in [`docs/spec/v1-features.md`](docs/spec/v1-features.md),
and the glossary in [`CONTEXT.md`](CONTEXT.md).

```bash
npm run dev    # build and serve on http://localhost:8080
```
