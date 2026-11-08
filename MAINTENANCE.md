# S.M.P. News: Maintenance Guide

How to keep the site running and fix common problems without an AI agent. Every build step adds to this guide.

## How the site works (at a glance)

There is no server and nothing runs on the owner's PC. Every hour:

1. **Cloudflare** (Worker `smp-news-scheduler`, cron `47 * * * *`) asks GitHub to start the **Edition** workflow. GitHub's own timer also starts it every 3 hours at :17 as a backup, and any push of code or config starts it too.
2. **GitHub Actions** (a fresh `ubuntu-24.04` machine, free because the repo is public) runs `npm run edition`:
   - reads every enabled outlet's own RSS feed listed in `config/sources.json` (never Google News; outlets whose terms forbid it are switched off);
   - tidies and de-duplicates the items, drops anything in `config/blocklist.json`;
   - groups reports of the same event into stories (word overlap; no AI), counts independent owners, assigns sections, ranks;
   - picks a free-licensed photo for every shown story (Gemini free tier suggests what to look for; Wikipedia, Wikimedia Commons and Openverse supply the photos; answers cached a week in GitHub's cache);
   - writes plain HTML pages to `dist/`. A build with fewer than 10 multi-source stories fails on purpose.
3. **GitHub Pages** publishes `dist/` at `https://thesmpnews.com`. **Cloudflare DNS** points the domain at GitHub Pages; GitHub provides the HTTPS certificate. If a run fails, nothing is published and the previous hour's site stays up.

The site shows headlines, sources, coverage bars and photos. AI-written summaries are not live yet (they will use the paid Gemini key only as a last resort; see "Google AI billing" below).

### Services used

| Service | Used for | Account | Cost |
|---|---|---|---|
| GitHub (`GeoFlashModelling`) | Code, workflows (Actions), hosting (Pages), secrets, private state and notes repos | Owner, 2FA on | Free (public repo) |
| Cloudflare | Domain registration (`thesmpnews.com`), DNS, the hourly timer Worker, Email Routing (`admin@` and `corrections@` forward to the owner's inbox) | Owner, 2FA on | Domain ~US$10/yr; Worker and Email Routing free |
| Google AI Studio / Google Cloud | Gemini API: free project for photos; separate paid project (billing linked, A$100/month cap) for future summaries | Owner's Google account, 2FA on | Free tier; paid project pay-as-you-go |
| Wikipedia, Wikimedia Commons | Free-licensed photos (hot-linked, credited) | None (anonymous API) | Free |
| Openverse | Free-licensed photos, mostly Flickr (credited) | None (anonymous API) | Free |
| News outlets' RSS feeds | Headlines and short descriptions, linked back | None | Free |

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
| `GEMINI_API_KEY` | Google AI Studio key "SMP News (GitHub Actions)", free tier, no billing attached. Used for photo search words (up to 12 requests an hour on each of two Flash Lite models; the free daily limit is 500 each). Manage at aistudio.google.com → API keys. If it leaks: delete it there, create a new one, update this secret | No expiry |
| `GEMINI_PAID_API_KEY` | Google AI Studio key "SMP News Paid (GitHub Actions)" on the separate project "SMP News Paid", which has billing. Used only when summaries are on, as a last resort for front-page stories whose free attempts all failed or ran out; the code stops at about A$3.20 a day (see "AI summaries" below). Same leak steps as above | No expiry |

### Google AI billing (pay-as-you-go, capped)

Billing is on a **separate** Google project ("SMP News Paid") because turning billing on moves a whole project off the free tier; the free project behind `GEMINI_API_KEY` has no billing and can never charge. No monthly fee; you pay only for paid-key requests, plus GST, charged to the card on the Google billing account. Google's US$300 welcome credit does not cover the Gemini API.

- **Hard cap:** aistudio.google.com → Spend → monthly spend cap **A$100** on "SMP News Paid". When reached, Google pauses the paid key until the next month (Google says up to ~10 minutes of overrun is possible). Change it there.
- **Email alerts:** console.cloud.google.com → Billing → Budgets & alerts → "SMP News Gemini monthly" (A$100/month): emails at 50%, 80% and 100% of actual spend, and when the month is forecast to reach 90%. Alerts only; they don't stop anything. Costs can take up to a day to appear.
- **See spending:** AI Studio → Spend, or Cloud console → Billing → Reports.
- **Stop all paid use at once:** delete the `GEMINI_PAID_API_KEY` secret, or unlink billing from "SMP News Paid" (Billing → Account management). The site keeps working on the free tier.

### Renew `STATE_REPO_TOKEN` (before it expires)

1. GitHub → your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
2. Open `smp-news-state-writer` → **Regenerate token** → pick a new expiry (up to 1 year) → copy the token.
3. In `smp-news` → Settings → Secrets and variables → Actions → `STATE_REPO_TOKEN` → **Update** → paste → save.
4. Run the workflow manually (Actions tab → workflow → **Run workflow**) and check it goes green.

If the token ever leaks, click **Delete** on the token page immediately, then create a new one with the same settings.

### The hourly timer (Cloudflare Worker `smp-news-scheduler`)

GitHub's own scheduled runs are often delayed or skipped, so a small Cloudflare Worker (`scheduler/`, free plan) starts the Edition workflow at :47 past every hour. It holds one secret, `GH_TOKEN`: the fine-grained token `smp-news-scheduler` (Actions read/write on `smp-news` only), **expires 6 Nov 2027**. GitHub's own timer still runs every 3 hours at :17 as a backup.

- **Check it is running:** Cloudflare dashboard → Workers & Pages → `smp-news-scheduler` → Metrics (one invocation an hour), or the Actions tab shows Edition runs marked "Manually run" each hour.
- **Renew the token:** GitHub → Developer settings → Fine-grained tokens → `smp-news-scheduler` → **Regenerate token** (custom expiry, up to a year) → copy. Then, without pasting it anywhere else:
  ```
  cd "D:\Cursor Projects\SMP_News\app\scheduler"
  Get-Clipboard | npx wrangler secret put GH_TOKEN
  Set-Clipboard " "
  ```
  (`npx wrangler login` first if asked.) The secret applies immediately; no redeploy needed.
- **Change the time or code:** edit `scheduler/wrangler.toml` or `scheduler/worker.js`, then `npx wrangler deploy` from `scheduler/`. A new schedule can take up to 15 minutes to start firing.

## Automatic checks

- **CI** (`.github/workflows/ci.yml`) runs the type check and a test edition on every push. A red cross on a commit means something broke.
- **Dependabot** opens at most one grouped pull request per month for npm packages and one for GitHub Actions. Merge them if CI is green.
- **Secret scanning with push protection** blocks any push that contains a recognisable password or token.
- **Edition** (`.github/workflows/edition.yml`) builds the site from live feeds at :47 past every hour, started by the Cloudflare timer above (and on every push that changes code or config) and publishes it to GitHub Pages at `https://thesmpnews.com`. If a build fails (for example fewer than 10 stories covered by two or more owners), nothing is deployed and the previous edition stays up. To rebuild now: Actions → Edition → **Run workflow**.
- **Snapshot (step 0.7)** (`.github/workflows/snapshot.yml`) captures every feed's items hourly into the private `smp-news-state` repo (`snapshots/step-0.7/`) until `SNAPSHOT_UNTIL`, then does nothing. `runs.csv` there records how late each scheduled run started. Once the window has passed, turn it off: Actions → Snapshot (step 0.7) → ⋯ → Disable workflow. Run one locally with `npm run snapshot` (writes to `.cache/snapshots/`).

## Recipes

### Take a story or link down

Edit `config/blocklist.json` on GitHub (the mobile app works): add the article link to `urls`, or a distinctive part of its headline to `phrases` (case-insensitive). Commit to `main`; the Edition workflow rebuilds the site within a few minutes. Remove the entry later if it was a mistake.

### Fix a wrong picture

Pictures (`src/images/`, all free-licensed, never from news sites) are chosen for every shown story, first match wins:

1. **Named subject**: the Wikipedia lead photo of the story's main person, organisation or thing (Gemini suggests the article; names in the headlines are the backup). Skipped for court and crime stories.
2. **Live search**: Gemini suggests 1–3 search phrases (a place, building or object, never people or incidents) and a "theme", a common thing that stands for the story's topic ("wild cat", "Wi-Fi router") as a near-certain backup; each is searched on Wikimedia Commons, then Openverse. Filters drop event photos (riots, crashes, matches…), people, old photos, scans and AI images.
3. **Place**: the Wikipedia photo of a city, suburb or building named in the reports.
4. **Topic library**: hand-picked Commons photos for broad topics (police, court, mining, rugby…) in `TOPICS` in `src/images/ideas.ts`.
5. Otherwise the section artwork from `src/site/artwork.ts`.

Answers are cached for 7 days (`.cache/images.json`, kept between runs by GitHub's cache), so each hour only new stories are asked about. Each run is capped (12 Gemini requests on each of two free models, 300 Commons and 15 Openverse searches); multi-source stories go first and any rest fill in over the next hour or two.

- **Wrong picture on a story:** for a wrong person or place from step 1, add the misleading name to `GENERIC` in `src/images/entities.ts`; for a bad search photo, add the giveaway word to `EVENT_PHOTO`, `PERSON_PHOTO` or `NOT_CURRENT` in `src/images/search.ts`. Then bump `RULES_VERSION` in `src/images/cache.ts` (clears the cached answers). Add the headline to `config/blocklist.json` only if the story itself must go.
- **Change a library photo:** find the file on commons.wikimedia.org, check its licence is CC BY, CC BY-SA, CC0 or public domain, and put its exact file name (without `File:`) in `TOPICS`.
- **Turn the AI part off:** in `smp-news` → Settings → Secrets and variables → Actions → Variables, add `PHOTO_AI` = `off` (step 1 then uses headline names only and step 2 is skipped). Delete the variable to turn it back on. By default it uses `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite` when that one's share is used or it fails (both free, 500 requests a day each); the variable `PHOTO_AI_MODEL` forces a single model instead.

### Check how stories are being grouped

```
cd "D:\Cursor Projects\SMP_News\app"
npm run snapshot
npm run cluster-report -- .cache/snapshots/<file>.json.gz 0.32
```

Lists every story covered by two or more owners, with the headlines grouped into it. The second number is the similarity threshold (higher = stricter grouping); the live value is `DEFAULT_CLUSTER_OPTIONS` in `src/lib/cluster.ts`.

### AI summaries: switch on or off

Summaries are written during the hourly edition when the repository variable `SUMMARIES` is `on` (smp-news → Settings → Secrets and variables → Actions → Variables). Delete the variable, or set it to anything else, to switch them off; the next edition shows headlines only and the banner and About page change wording to match. Code: `src/ai/summarise.ts`.

- **Which model:** for front-page stories, the free Flash models first (about 20 free requests a day each), then free Flash-Lite (about 500 a day each, shared with photo search words). Every answer goes through the support check (`src/ai/validate.ts`); a failed answer gets one retry with the reasons, then the next model tries. Busy models are skipped for a minute.
- **Paid key:** only for front-page stories after every free model failed or ran out. The code stops at **A$3.20 a Perth day** and **A$0.40 per edition**, using an exchange rate of 1.6 to stay on the safe side; Google's A$100 monthly cap is the backstop. Change `DAILY_PAID_LIMIT_AUD` to adjust. `SUMMARY_PAID_MODEL` (variable) picks the paid model; only models with a price in `PAID_PRICES` can be used.
- **Rewrites:** a summary is rewritten when 2 or more new independent owners join the story, at most every 3 hours. Court, crime, sexual-offence and suicide stories are never summarised (`src/ai/legal-risk.ts`).
- **Each edition** spends at most 7 minutes on summaries; stories that don't fit wait for the next hour. The log line ends with counts, e.g. `summaries for 30/134 (new 23: free 23, paid 0; kept 7; failed checks 2; waiting 52; paid A$0.000 this run, A$0.00 today)`.
- **Memory between runs:** `.cache/summaries.json` (summaries, today's paid spend, free models used up today), carried by GitHub's Actions cache. If it is lost, everything is rewritten over the next few hours; the per-edition limit still caps spending.
- **Preview locally without publishing:** `$env:SUMMARIES="on"; $env:EDITION_OUT=".cache/preview"; $env:SUMMARY_STATE=".cache/summaries-local.json"; npm run edition` (uses only the free key unless `GEMINI_PAID_API_KEY` is set on the PC).

### Test AI summaries on a saved snapshot (nothing is published)

Needs Ollama running locally (`ollama pull gemma4:e4b`). For Gemini, use model `gemini:gemini-3.5-flash`; the key is read from the `GEMINI_API_KEY` environment variable (set as a Windows user variable on the owner's PC; on another PC copy the key and run `$env:GEMINI_API_KEY = Get-Clipboard`, which never displays it).

```
cd "D:\Cursor Projects\SMP_News\app"
npm run ai-test -- .cache/snapshots/<file>.json.gz gemma4:e4b 12
```

Writes a readable report to `.cache/ai-test/<model>.md`: each story's AI summary with the outlets it cites, the sentences the support check dropped and why, timing, the prompt-injection result, and the stories skipped as legal-risk. `OLLAMA_CPU=1` measures CPU-only speed (closer to a GitHub runner).

### The domain (thesmpnews.com)

Registered with Cloudflare Registrar (renews **7 Nov each year**; keep auto-renew on). DNS lives in Cloudflare: the apex `A`/`AAAA` records point to GitHub Pages and `www` is a `CNAME` to `geoflashmodelling.github.io`, all **DNS only** (grey cloud). The `TXT` record `_github-pages-challenge-GeoFlashModelling` proves ownership to GitHub; don't delete it. The custom domain is set in `smp-news` → Settings → Pages, which must show **Enforce HTTPS** ticked.

### Email (admin@ and corrections@thesmpnews.com)

Cloudflare Email Routing forwards mail; there is no mailbox. `admin@thesmpnews.com` and `corrections@thesmpnews.com` both forward to the owner's personal inbox (the address is in the private notes, not here). The site's About page and every story link to `corrections@`, which is set once as `CORRECTIONS_EMAIL` in `src/site/html.ts`. The catch-all rule is off, so mail to any other address at the domain bounces.

- **Change where mail goes:** Cloudflare → `thesmpnews.com` → Email → Email Routing → Destination addresses → add the new inbox (it must click Cloudflare's verification email), then edit both routing rules to use it.
- **Add an address:** Routing rules → Create routing rule → type the name, Action "Send to an email", pick the destination.
- **DNS:** Email Routing owns the three `MX` records (`route1/2/3.mx.cloudflare.net`) and the DKIM `TXT` at `cf2024-1._domainkey`. The `TXT` SPF record is `v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all` (the Google part lets Gmail send as the domain). Don't delete them; they don't affect the website.
- **Inbox:** a Gmail filter puts mail to `admin@` or `corrections@` under the label "SMP News", skips the inbox and never sends it to spam.
- **Replying as admin@:** Gmail → Settings → Accounts → "Send mail as" has "S.M.P. News <admin@thesmpnews.com>", sent through `smtp.gmail.com` port 587 (TLS) with a Google app password, and "Reply from the same address the message was sent to" is on. If replies stop sending, the app password was probably revoked: make a new one at myaccount.google.com/apppasswords and paste it via "edit info" next to the address.

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

## Owner's calendar

| When | What | Where |
|---|---|---|
| Weekly (5 min) | Open the site: is "Updated" within the last hour or two? Glance at a few stories and pictures. Check the Actions tab for red crosses | thesmpnews.com, GitHub |
| When an email arrives | GitHub failed-run emails, Google budget alerts, Dependabot pull requests (merge if CI is green) | Email |
| Within 48 hours of a reader email | Reply to anything sent to `corrections@` (the About page promises 48 hours); fix it with the recipes above | Owner's inbox |
| Monthly | Google spend (once summaries use the paid key) | AI Studio → Spend |
| By **6 Nov 2027** | Renew `STATE_REPO_TOKEN` and the scheduler's `GH_TOKEN` (steps above) | GitHub, Cloudflare |
| **7 Nov each year** | Domain renews automatically; keep a valid card on Cloudflare | Cloudflare → Domains |
| Yearly | Re-check `full_text_allowed` sources' terms; run `npm run check-terms` and `npm run check-feeds` | This repo |

**If the site stops updating:** Actions tab → Edition → the latest run's log shows why. Common causes: a feed change (`npm run check-feeds`), an expired token (Cloudflare Worker logs show 401), or GitHub having an outage (wait). Actions → Edition → **Run workflow** rebuilds by hand.

*Still to come as the pipeline is built:* pausing and resuming the site, re-running a failed edition, switching AI provider, taking down a story, rotating keys, rolling back, reading a failed Actions log.
