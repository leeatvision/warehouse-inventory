# Setting up the warehouse app

## How it fits together

- **The app** is a static web page (`src/`), built by `scripts/build.mjs` into `dist/` and published to GitHub Pages
  by `.github/workflows/deploy.yml`. It works offline: entries are kept on the device and sent when the internet is back.
- **Branding** (name, colours, logo, icons, server address) is not in this repo. The build reads `brand/` if it exists,
  otherwise the neutral placeholders in `brand-default/`. The deploy workflow fetches `brand/` from a private repo.
- **Data** lives in Supabase, in new tables and functions whose names start with `wh_` (`supabase/migrations/`).
  The browser can only call the `wh_` functions, and each call needs the **device key**.
- **Billing documents** are made by a Google Apps Script (`apps-script/`) that checks every 5 minutes and saves
  one PDF per Cart and Job code into a Drive folder.

## Supabase

Apply `supabase/migrations/001`–`003` in order. They create only new `wh_` objects; the existing QuickBooks Time
tables (`qbt_users`, `qbt_jobcode_tree`) are only read. Migration 003 creates two secrets in Vault:

- `wh_device_key`: typed into each device once.
- `wh_delivery_token`: pasted into the Apps Script.

To read either value: Supabase dashboard → Project Settings → Vault → Secrets → the secret → show value.
To change one, edit it there, then update the devices or the script.

Company values (Branch, time zone, Managers, people to leave out) are set with a small SQL file kept with the
private brand files.

## GitHub

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `BRAND_TOKEN` | Fine-grained token: only the brand repo, Contents read-only |
| Variable | `BRAND_REPO` | `owner/brand-repo` |
| Variable | `BRAND_PATH` | the app's folder in that repo |

Settings → Pages → Source: **GitHub Actions**. The workflow refuses to build without the brand folder
(`REQUIRE_BRAND=1`), so a missing setting fails the run instead of publishing placeholders.

## Billing delivery (Google Apps Script)

Signed in to the Google account that can edit the billing folder:

1. Open the billing folder in Drive. Copy the part of the address after `/folders/`. That is the folder id.
2. Go to [script.google.com](https://script.google.com) → **New project**. Name it, for example, "Warehouse billing delivery".
3. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.
4. Back in **Editor**: replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo, and the contents
   of `appsscript.json` with `apps-script/appsscript.json`. Save.
5. **Project Settings** → **Script properties** → add four:
   - `SUPABASE_URL`: the project address, `https://<project>.supabase.co`
   - `SUPABASE_KEY`: the publishable key
   - `DELIVERY_TOKEN`: the `wh_delivery_token` value from Vault
   - `FOLDER_ID`: from step 1
6. **Editor** → choose the `setup` function at the top → **Run**. Google asks for permission:
   - "See, edit, create and delete all of your Google Drive files" (needed to write into a folder you picked)
   - "Connect to an external service" (to reach Supabase)
   - "Allow this application to run when you are not present" (the 5-minute timer)

   Google may say the app isn't verified, because it is your own private script. Choose **Advanced** → **Go to … (unsafe)** → **Allow**.
7. `setup` creates the 5-minute timer and runs one delivery. **Executions** (left bar) shows each run.

What the script does each run:

- Asks Supabase for every document that is new or changed.
- Saves `<lowest Job code name>_<Cart>_<T1 or C#>_<YYMMDD>_D<document number>.pdf` in the folder.
- Moves the previous version of that document (same `D` number) to Trash. Trash keeps it for 30 days.
- Tells Supabase it is delivered. If anything fails, nothing is marked delivered and the next run tries again.
  Google emails the account owner if runs keep failing, and the app's Alerts screen shows Managers when documents
  are waiting more than 20 minutes.

## A new device

1. Use a browser that is **never signed in to any Google account**, so nothing that happens to an account
   (signing out, a lockout, an admin wiping it) can touch the app's data. On a shared Android tablet that
   is already signed in to someone's Chrome, install **Chrome Beta** from the Play Store and use only that for the
   app. It is a separate app with its own storage. Skip its sign-in screen and never sign it in.
2. Open the site in that browser and choose **Install app** / **Add to Home screen**. Type the device key once.
3. The first time ever, a Manager picks their name and sets a PIN. After that, Managers set everyone's PINs under
   **People and PINs**.
4. On the shared tablet: turn on screen pinning with "PIN to unpin", keep it charging, and set a long screen timeout.
   Clearing that browser's data deletes entries that have not been sent yet. The sign-in screen warns while
   any are waiting, and a Manager can save them to a file (Device and delivery → Unsent entries) and load them
   back after the device key is entered again.

## Trying it locally

```bash
npm run dev            # builds with brand/ or brand-default/ and serves http://localhost:8080
node tests/smoke.mjs   # walks through every screen against a stand-in server and saves screenshots
node tests/pdf-sample.mjs  # draws sample billing PDFs with the Apps Script layout
```
