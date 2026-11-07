# S.M.P. News: Maintenance Guide

How to keep the site running and fix common problems without an AI agent. Every build step adds to this guide.

## Where things live

| What | Where | Visibility |
|---|---|---|
| App code (this repo) | `github.com/GeoFlashModelling/smp-news` | Public |
| Pipeline state (stories, clusters) | `github.com/GeoFlashModelling/smp-news-state` | Private |
| Project notes, plans, cost logs | `github.com/GeoFlashModelling/smp-news-workspace` | Private |
| Local working copy | `D:\Cursor Projects\SMP_News\app` (inside the workspace folder) | — |

The workspace folder ignores `app/`; this repo has its own git history. Commit and push app changes from inside `app/`.

## Run an edition locally

```
cd "D:\Cursor Projects\SMP_News\app"
npm install
npm run edition
```

## Secrets and tokens

| Secret (in `smp-news` → Settings → Secrets and variables → Actions) | What it is | Expires |
|---|---|---|
| `STATE_REPO_TOKEN` | Fine-grained token `smp-news-state-writer`: Contents read/write on `smp-news-state` only | **6 Nov 2027** |
| `GEMINI_API_KEY` | Google AI Studio key "SMP News (GitHub Actions)", free tier, no billing attached. Manage at aistudio.google.com → API keys. If it leaks: delete it there, create a new one, update this secret | No expiry |

### Renew `STATE_REPO_TOKEN` (before it expires)

1. GitHub → your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
2. Open `smp-news-state-writer` → **Regenerate token** → pick a new expiry (up to 1 year) → copy the token.
3. In `smp-news` → Settings → Secrets and variables → Actions → `STATE_REPO_TOKEN` → **Update** → paste → save.
4. Run the workflow manually (Actions tab → workflow → **Run workflow**) and check it goes green.

If the token ever leaks, click **Delete** on the token page immediately, then create a new one with the same settings.

## Automatic checks

- **CI** (`.github/workflows/ci.yml`) runs the type check and a test edition on every push. A red cross on a commit means something broke.
- **Dependabot** opens at most one grouped pull request per month for npm packages and one for GitHub Actions. Merge them if CI is green.
- **Secret scanning with push protection** blocks any push that contains a recognisable password or token.
- **Edition** (`.github/workflows/edition.yml`) builds the site from live feeds at :47 past every hour (and on every push that changes code or config) and publishes it to GitHub Pages at `https://thesmpnews.com`. If a build fails (for example fewer than 10 stories covered by two or more owners), nothing is deployed and the previous edition stays up. To rebuild now: Actions → Edition → **Run workflow**.
- **Snapshot (step 0.7)** (`.github/workflows/snapshot.yml`) captures every feed's items hourly into the private `smp-news-state` repo (`snapshots/step-0.7/`) until `SNAPSHOT_UNTIL`, then does nothing. `runs.csv` there records how late each scheduled run started. Once the window has passed, turn it off: Actions → Snapshot (step 0.7) → ⋯ → Disable workflow. Run one locally with `npm run snapshot` (writes to `.cache/snapshots/`).

## Recipes

### Take a story or link down

Edit `config/blocklist.json` on GitHub (the mobile app works): add the article link to `urls`, or a distinctive part of its headline to `phrases` (case-insensitive). Commit to `main`; the Edition workflow rebuilds the site within a few minutes. Remove the entry later if it was a mistake.

### Check how stories are being grouped

```
cd "D:\Cursor Projects\SMP_News\app"
npm run snapshot
npm run cluster-report -- .cache/snapshots/<file>.json.gz 0.32
```

Lists every story covered by two or more owners, with the headlines grouped into it. The second number is the similarity threshold (higher = stricter grouping); the live value is `DEFAULT_CLUSTER_OPTIONS` in `src/lib/cluster.ts`.

### Test AI summaries on a saved snapshot (nothing is published)

Needs Ollama running locally (`ollama pull gemma4:e4b`). For Gemini, use model `gemini:gemini-3.5-flash`; the key is read from the `GEMINI_API_KEY` environment variable (set as a Windows user variable on the owner's PC; on another PC copy the key and run `$env:GEMINI_API_KEY = Get-Clipboard`, which never displays it).

```
cd "D:\Cursor Projects\SMP_News\app"
npm run ai-test -- .cache/snapshots/<file>.json.gz gemma4:e4b 12
```

Writes a readable report to `.cache/ai-test/<model>.md`: each story's AI summary with the outlets it cites, the sentences the support check dropped and why, timing, the prompt-injection result, and the stories skipped as legal-risk. `OLLAMA_CPU=1` measures CPU-only speed (closer to a GitHub runner).

### The domain (thesmpnews.com)

Registered with Cloudflare Registrar (renews **7 Nov each year**; keep auto-renew on). DNS lives in Cloudflare: the apex `A`/`AAAA` records point to GitHub Pages and `www` is a `CNAME` to `geoflashmodelling.github.io`, all **DNS only** (grey cloud). The `TXT` record `_github-pages-challenge-GeoFlashModelling` proves ownership to GitHub; don't delete it. The custom domain is set in `smp-news` → Settings → Pages, which must show **Enforce HTTPS** ticked.

### Check which news feeds are working

```
cd "D:\Cursor Projects\SMP_News\app"
npm run check-feeds
```

Prints a table: ✅ / ❌ per feed, HTTP status, item count, age of the newest item and the problem if any. A feed whose newest item is over 48 hours old is flagged **stale** (a feed can keep answering long after the outlet stops updating it). Full results are saved to `.cache/feed-check.json`.

On GitHub: Actions tab → **Feed check** → **Run workflow**. It also runs every Monday morning (Perth time). The results appear on the run's summary page.

### Check publishers' terms (robots.txt)

```
npm run check-terms
```

Reads every enabled outlet's `robots.txt` and sorts it into one of three groups:

| Verdict | Meaning | What `sources.json` must say |
|---|---|---|
| ❌ exclude | robots.txt disallows our feed, or the publisher bans automated collection without written permission | `"enabled": false` |
| 🟡 headline only, no AI | Reading the feed is fine, but the publisher bans AI / machine-learning use of its content | `"ai_input_allowed": false` (headline + link only; never sent to an AI model) |
| ✅ AI input OK | No such statement (blocking AI *training* crawlers alone doesn't count) | `"ai_input_allowed": true` |

If `sources.json` disagrees with what a publisher now says, the command lists the sources to change and exits with an error. Results are saved to `config/terms-review.json`. Rerun it before adding a source and whenever the Feed check workflow reports a problem.

### Add, fix or disable a source

All sources live in `config/sources.json`. Each source has:

| Field | Meaning |
|---|---|
| `id` | Short lowercase name, e.g. `perthnow` |
| `lean` | `left`, `centre-left`, `centre`, `centre-right` or `right`, or `null` (see below). The coverage bar folds this to left / centre / right |
| `content_type` | `news`, `analysis`, `opinion` (not counted towards agreement), `feel-good`, `community` (local/suburban/student papers, community radio: unrated, shown as "local / unrated" in the bar) or `official` (government, police, universities: lean must be `null`, never in the bar, labelled "Official statement") |
| `owner_group` | Parent company, e.g. `News Corp`. Outlets with the same owner count once for independence |
| `paywall` | `free`, `partial` or `paywalled` |
| `region_of_rating` | Where the lean rating comes from: `AU`, `US` or `UK` |
| `enabled` | `false` switches the source off without deleting it |
| `full_text_allowed` | Whether the full article may be fetched and used as research for our own long-form stories. `true` only where the outlet's licence or terms allow it (7 sources as of 7 Nov 2026); everything else uses only the feed's title and description |
| `terms_url`, `full_text_basis` | Required when `full_text_allowed` is `true`: the terms or licence page, and the reason in a few words (e.g. "Creative Commons Attribution 4.0"). Re-check these yearly; outlets change their terms |
| `ai_input_allowed` | Whether the feed's title/description may go to an AI model. Set by `npm run check-terms` |
| `feeds` | One or more `{ url, sections, via }`. `via` is always `direct` (the outlet's own feed). Google News feeds are not allowed: their terms limit them to personal feed readers |

To **disable** a source: set `"enabled": false` and add a `notes` line saying why.
To **fix a broken feed**: find the outlet's new feed address, replace `url`, then run `npm run check-feeds`.
To **add a source**: copy an existing entry, change every field, then run `npm run validate-config`, `npm run check-terms` and `npm run check-feeds`.

`lean` may be `null` for `community` and `official` sources, or for sources that publish only in sport, science-tech, entertainment or feel-good; those sources don't appear in the left / centre / right part of the bar. If a lean isn't from AllSides or Media Bias/Fact Check, say so in `notes` ("Lean is editorial judgement").

Valid sections: `local-wa`, `australia`, `world`, `politics`, `business`, `sport`, `science-tech`, `entertainment`, `feel-good`. CI rejects any push where `sources.json` is invalid.

*Still to come as the pipeline is built:* pausing and resuming the site, re-running a failed edition, switching AI provider, taking down a story, rotating keys, rolling back, reading a failed Actions log.
