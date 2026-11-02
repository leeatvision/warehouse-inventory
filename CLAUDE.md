# warehouse-tracker

## Standing rules

- **Do not edit any existing feature of the Supabase database** (the shared company project; its name and ref are in the private brand repo notes). No altering, dropping, or writing to existing tables, columns, functions, policies, triggers, or sync state. Existing tables may only be **read**.
- **Only add new tables** (and what they need: their own policies, indexes, functions).
- **Edge functions only with explicit permission** from the owner, asked each time.
- **New database objects start with `wh_`.** Migrations are in `supabase/migrations/`.
- **Nothing that identifies the company goes in this repo** (names, logos, colours, the Supabase address or key, staff names). It lives in the private brand repo and is pulled in at build time; see `docs/setup.md`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repository (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
