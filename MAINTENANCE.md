# S.M.P. News: Maintenance Guide

How to keep the site running and fix common problems without an AI agent. Every build step adds to this guide.

## How the site works (at a glance)

There is no server and nothing runs on the owner's PC. Every hour:

1. **Cloudflare** (Worker `smp-news-scheduler`, cron `47 * * * *`) asks GitHub to start the **Edition** workflow. Overnight (midnight to 6 am Sydney) it runs once, at 03:47 (00:47 Perth in summer). GitHub's own timer also starts it five times a day at :17 as a backup, and any push of code or config starts it too.
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

GitHub's own scheduled runs are often delayed or skipped, so a small Cloudflare Worker (`scheduler/`, free plan) starts the Nightly report at 9:30 pm Perth time (see Email below) and the Edition workflow at :47 past every hour, except overnight: between midnight and 6 am Sydney time it runs once, at 03:47 (`NIGHT_HOURS` and `NIGHT_RUN` in `scheduler/worker.js`). Besides the report's `REPORT_TOKEN` and `REPORT_TO`, it holds `GH_TOKEN`: the fine-grained token `smp-news-scheduler` (Actions read/write on `smp-news` only), **expires 6 Nov 2027**. GitHub's own timer still runs five times a day at :17 (Australian daytime) as a backup.

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
- **Snapshot (step 0.7)** (`.github/workflows/snapshot.yml`) captures every feed's items hourly into the private `smp-news-state` repo (`snapshots/step-0.7/`) until `SNAPSHOT_UNTIL`, then does nothing. `runs.csv` there records how late each scheduled run started (only 4 of ~24 scheduled runs happened, 12–50 minutes late, which is why the Cloudflare timer exists). The window ended 8 Nov 2026 and the workflow was disabled on 11 Nov. Run one locally with `npm run snapshot` (writes to `.cache/snapshots/`).

## Recipes

### Take a story or link down

Edit `config/blocklist.json` on GitHub (the mobile app works): add the article link to `urls`, or a distinctive part of its headline to `phrases` (case-insensitive). Commit to `main`; the Edition workflow rebuilds the site within a few minutes. Remove the entry later if it was a mistake.

### Fix a wrong picture

Pictures (`src/images/`, all free-licensed, never from news sites) are chosen for every shown story. Photos of a news event itself are nearly always copyright, so the rule for every topic is **most specific first: who or where the story is about, then a key object it discusses, then a broad picture of its topic**:

**No repeats, without weaker pictures (owner, 11 Nov 2026):** front-page stories choose first, in reading order, then everything else by importance; each takes its best photo that no earlier story already uses. Avoiding a repeat must not mean a weaker picture, so before moving down a level a story tries, in order:
- the next results of the same search (each search keeps its best 5, `KEEP` in `src/images/search.ts`);
- other photos of the same subject or place as the taken photo (a Commons search for "Parliament House Canberra", `alternative` in `src/images/assign.ts`);
- other library photos of the same place (`STAND_INS` in `src/images/ideas.ts`: five of Parliament House, Canberra).

Only when every option is taken does it share one. The edition log's `shared N` counts these; the nightly report shows it. Add a `STAND_INS` group when a photo keeps repeating.

**Right place (owner, 11 Nov 2026: a US federal building appeared on an Australian story):** `shotElsewhere` in `src/images/assign.ts` refuses a photo of a place when:
- its camera position (from the file's GPS data on Commons) is abroad and the story isn't about abroad (World section, or names another country, the US or the UK);
- it was taken in New Zealand and the story doesn't mention New Zealand, or in Australia for a New Zealand story that doesn't mention Australia;
- its title names a country, US state or major foreign city (`CITY_COUNTRY`; add cities as they turn up) the story never mentions, or an Australian state the story doesn't name while naming others (a Darwin court on an Adelaide trial). Canberra is exempt.

Things and animals (a koala, rugby goalposts) can come from anywhere; the camera-position test only applies to photos of buildings and places (`BUILT`). The log prints a sample of refusals (`Photo refused as elsewhere: …`) and counts them (`refused as elsewhere N`). Photos of other conferences and summits are refused like other events (`EVENT_PHOTO`).

**Photo credits (owner, 10 Nov 2026: credits cluttered the small pictures):** only the story page shows the credit, under its photo. Cards and list pictures that open our story page show it as a tooltip; a picture beside an outlet's headline (which opens the outlet, not our page) links to the photo's file page, which credits it. The licences (CC BY, CC BY-SA) allow crediting "in any reasonable manner", including by linking to where the credit is. Keep one of these for every picture.

**Except stories about someone's death** (owner, 10 Nov 2026): a photo of anybody else could be taken for the person who died, so these show a hand-picked medical photo chosen by the cause the reports give. The one exception is a famous person when we are certain the photo is theirs: the headline names them in full, and Wikipedia has an article with exactly that name and a free lead photo. On top of that, either the age in the reports matches the birth year on Wikipedia, or Wikipedia's description shares a describing word with the reports ("comedian", "actor"). A mismatched age always means the medical photo (`deceasedName`, `confirmedPerson` in `src/images/ideas.ts`). Injury, crash, fall or drowning gets a St John ambulance; cancer, a radiotherapy machine; heart attack or stroke, a vital signs monitor; anything else, a stethoscope. A story counts when its headline, or most of its reports' titles, say someone died, died at an age, passed away, or is mourned, or that a person was killed, found dead or in a fatal incident ("Man dead, another arrested") (`isDeathStory`, `MEDICAL` in `src/images/ideas.ts`). Court cases don't count, so a trial keeps its courthouse photo. "Death toll" disaster stories don't count and keep their usual photo.

1. **Event** (who or where):
   - the Wikipedia lead photo of the story's main person, organisation or product (Gemini suggests the article; names in the headlines are the backup). Court and crime stories skip this: a file photo next to an allegation can wrongly suggest who is accused. Anyone may be shown, living or historical, except the notorious: people Wikipedia describes as a dictator, terrorist, mass murderer, serial killer, war criminal etc., plus a short list in `NOTORIOUS_PEOPLE` whose descriptions don't say so (Stalin, Mao…). After 100 years the pain has worn off and they may be shown too (a bushranger, Jack the Ripper). Owner's rule, 10 Nov 2026 (`notToShow` in `src/images/wikimedia.ts`). A searched photo whose title names a country the story's reports never mention is skipped too ("Parliament of Victoria" finds Victoria, Canada; `shotElsewhere` in `src/images/assign.ts`; Australia never counts);
   - then the specific place it happened: the ground, venue, building, landmark or site Gemini names (only when the reports mention it, so a guessed place is never shown as fact);
   - then a town or suburb named in the reports. In Science and Tech the key object (step 2) comes before the town, because the town is usually just where the researchers or company are (owner, 11 Nov 2026: a galaxy study showed Salt Lake City).
   - **Sport puts the ground first**, since free photos of teams are often decades old. If the reports don't name the ground, the home ground of the first-named Australian AFL or NRL club is used (`src/images/grounds.ts`; club nicknames only count when the story mentions AFL or NRL), and only then Gemini's guess. The caption names the ground, not the match.
2. **Key object**: Gemini suggests 1–3 search phrases for the object or setting the report discusses ("open pit gold mine", "Boeing 737 MAX"); each is searched on Wikimedia Commons, then Openverse.
3. **Broad topic**: a "theme", a common thing that stands for the topic ("wild cat", "Wi-Fi router"), searched the same way; else a hand-picked Commons photo for the topic (police, court, mining, rugby…) from `TOPICS` in `src/images/ideas.ts`.
4. Otherwise the section artwork from `src/site/artwork.ts`.

**A story keeps its photo (owner, 11 Nov 2026: pictures were changing on existing stories):** a story's own good photo (not shared, not blurry, not a topic picture) is remembered (`chosen:<story id>` in `.cache/images.json`) and claimed before any photos are chosen, so a story moving up the page can't take another's. It is dropped only when it fails a check, the story becomes or stops being about a death, or the story becomes the lead and the photo has no large version. Topic pictures and shared photos are looked at again each hour, so they can still improve. To make every story choose once more after changing the order photos are chosen in, bump `PICK_RULES` in `src/images/assign.ts` (searches stay cached); to throw away every cached search and idea too, bump `RULES_VERSION` in `src/images/cache.ts`.

**Allegation stories (owner, 11 Nov 2026: a basketball court on a candidate dropped over remarks to a teenage basketballer):** after the place, they use a hand-picked topic photo (the parliament, a polling place, a gavel) before searched objects, which can come from the allegation itself and look like the scene. Gemini is also told that searches stand for the story as a whole, never a detail of an allegation.

**Every photo is read against its story (owner, 11 Nov 2026: "make sure the image algorithm understands the story's context"):** name lookups and searches only match words, so after photos are chosen a free model (`src/images/vet.ts`, flash-lite) reads each story's section, headlines and report descriptions beside the photo's caption and answers whether it suits the story as a whole. It refuses details mentioned in passing or from an allegation, things that only share a name (an archaeology photo labelled "anthropic" on an Anthropic story), towns that are only where the researchers or company are based, and anything unrelated; the place a story happens and its topic (parliament, courthouse, the sport) are fine. A refused photo is never offered to that story again and the story chooses again (up to 3 rounds); if nothing passes, it shows the section artwork, which is better than a misleading photo. Death stories are not checked (their photos are hand-picked). Verdicts are cached per story and photo for 7 days, so each photo is asked about once: up to 8 free requests of 25 photos a run (`VET_REQUESTS`), most prominent stories first; anything left is shown and asked about next hour. Only titles, descriptions and captions are sent. The log prints `Photo refused as off the point: …` with the model's reason, and the edition line counts `off the point N`. Tested on 11 Nov 2026 against all 266 live photos: 70 refused, nearly all rightly (the Super Pit on a sharemarket story, a burned Ukrainian apartment block on a rents story, a pizza box on a courier harassment story).

**Shape and sharpness (owner, 11 Nov 2026):** landscape photos fill the cards, so a portrait or (for the lead story) small photo of the subject is swapped for a landscape photo of the same thing when Commons has one, or for the next place the reports name; otherwise the portrait stays. Originals narrower than 400 px (`MIN_SHARP_WIDTH` in `src/images/assign.ts`) look blurry and are used only when nothing else is found. Maps are refused, including locator maps whose file names run place names together ("ChinaDaqingLindian.png") and map projections (`NOT_A_PHOTO` in `src/images/wikimedia.ts`). "Mourns" makes a death story only when a person or a loss follows ("Nation mourns Dai Henwood"), not "mourns 'race to the bottom'".

Search filters drop event photos (riots, crashes, rubble, matches…), people, scans and AI images, and Commons photos taken before 2005 (`OLDEST_YEAR` in `src/images/search.ts`, read from the file's "date taken"). The edition log counts photos per level: `event`, `object`, `broad`.

Answers are cached for 7 days (`.cache/images.json`, kept between runs by GitHub's cache), so each hour only new stories are asked about. Each run is capped (12 Gemini requests on each of two free models, 300 Commons and 15 Openverse searches, and no new searches after 6 minutes, `SEARCH_MINUTES`); front-page stories go first and any rest fill in over the next hour or two.

- **Wrong picture on a story:** for a wrong person or place from step 1, add the misleading name to `GENERIC` in `src/images/entities.ts`; for a bad search photo, add the giveaway word to `EVENT_PHOTO`, `PERSON_PHOTO` or `NOT_CURRENT` in `src/images/search.ts`. Then bump `RULES_VERSION` in `src/images/cache.ts` (clears the cached answers). Add the headline to `config/blocklist.json` only if the story itself must go.
- **Change a library photo:** find the file on commons.wikimedia.org, check its licence is CC BY, CC BY-SA, CC0 or public domain, and put its exact file name (without `File:`) in `TOPICS`.
- **Turn the AI part off:** in `smp-news` → Settings → Secrets and variables → Actions → Variables, add `PHOTO_AI` = `off` (step 1 then uses headline names only and step 2 is skipped). Delete the variable to turn it back on. By default it uses `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite` when that one's share is used or it fails (both free, 500 requests a day each); the variable `PHOTO_AI_MODEL` forces a single model instead. Summaries use the same free models, so on busy days the free share is gone by early morning; after that, if `GEMINI_PAID_API_KEY` is set, up to 4 requests a run (15 stories each, about A$0.005 a request) go to the paid model (`SUMMARY_PAID_MODEL`, default `gemini-3.1-flash-lite`). This spend is small and is not counted in the summaries' daily cap.

### A story shows the section icon instead of a photo

The edition log prints `No photo: <id> "<headline>" (idea …; places …)` for every multi-source story that ended with artwork. Usual causes: the photo idea only had incident-type searches ("earthquake damage", "collapsed building"), which are rejected on purpose; or the only place was a country (its Wikipedia image is a flag or map). The story's idea is re-asked once automatically in the next edition. If a topic keeps missing, add a hand-picked photo to `TOPICS` in `src/images/ideas.ts` (check the file name and licence on Commons first).

### How the front page is built

In the reader's order (`frontPage` in `src/lib/stories.ts`, layout in `renderFront` in `src/site/render.ts`):

1. **Facts strip**: "On this day" (changes at midnight Perth time; an Australian anniversary when Wikipedia has a peaceful one, never a grim one) and "Fun fact" (a Wikipedia "Did you know…" fact, a different one each hourly edition). Many of those facts only interest fans of a niche (owner, 11 Nov 2026: "a bit boring"), so once a Perth day one free Gemini request picks the 24 most surprising for a general Australian reader (`RANK_SYSTEM` in `src/lib/facts.ts`, kept in `.cache/facts.json`); without it, a word score favours records, firsts, animals, space and Australia and drops athletes, songs, roads and ships. Both from Wikipedia under CC BY-SA 4.0, credited on the page; `src/lib/facts.ts`. If Wikipedia can't be reached the box is simply left out.
2. **Top stories (what's hot)**: 10 stories (the lead plus a full 3-by-3 grid; `TOP_STORIES`; when there is no closing "And finally" story, one more top story takes its place) covered by 2+ owner groups, ranked by how many major Australian outlets (`agenda: true`) run them and how high they sit on ABC's Top Stories list (feeds flagged `top: true` must be in homepage order, not newest-first). 2 slots go to Local WA, up to 5 to Local WA + Australia + Politics; one science slot; world stories capped at 3, sport 2, entertainment 1, New Zealand 1, and at most 1 celebrity/reality-TV gossip story (`GOSSIP` words).
3. **Also in the headlines**: 3 single-outlet stories in the first 6 of a top-stories feed.
4. **Local WA, Australia, New Zealand, World** blocks. A story goes to New Zealand when at least 30% of its reports name a New Zealand place or leader (`NZ_PLACES` in `stories.ts`) and they name New Zealand more often than Australia; New Zealand outlets' feeds are labelled `new-zealand`. NZ sources (Nov 2026): RNZ, 1News, Stuff, Newsroom, Otago Daily Times, NZ Herald (headline only).
5. **Worth a look**: 6 less prominent stories taken in turn from Science, Feel Good, Tech, Business and Entertainment, one per outlet, no gossip, opinion, court/crime or violent stories. Product round-ups ("6 Best Touchscreen Gloves (2026)") are kept out of here, the top stories and "And finally", but stay in their section's list (`isBuyersGuide` in `src/lib/stories.ts`).
6. The remaining section blocks. Every section list keeps at most 2 gossip stories.

Each section block shows 6 written stories (`SECTION_WRITTEN`), then 3 "More … headlines" links (`SECTION_LINKS`). `edition.ts` asks for summaries of the top stories plus each section's first 6 writable stories. A story with only one AI-usable report (covered by one outlet, or the others are headline-only such as Nine and the Guardian) is written from that report if its description is at least 120 characters, but only to fill a front-page slot. A single-outlet story it is marked "Only <outlet> so far", gets its own story page, and is rewritten as a comparison once a second owner group covers it. Court and crime stories are written in "careful" mode (`legalMode` in `src/ai/legal-risk.ts`): extra prompt rules, and `validate.ts` rejects any sentence that says someone did something criminal without saying who says so (police, court, outlet), or that labels anyone a murderer, killer, etc.; the story page adds a presumption-of-innocence note. Never written (headlines and coverage only, still shown as cards): sexual offences, young people in crime stories, suicide/self-harm, suppression orders. A failed summary is retried after 3 hours, up to 3 times; a failed rewrite keeps the existing summary.

The last top story is "And finally" (`andFinally` in `stories.ts`): the best recent Feel Good story we can write, else a science story, else a plainly uplifting Local WA/Australia/entertainment one; no hard news, crime, gossip or opinion. If a section still has fewer than 6 written stories after the 2-per-outlet limit, it is topped up from the same outlets. Written stories are kept 3 days, so section pages also show earlier write-ups at no extra cost.

### Check how stories are being grouped

```
cd "D:\Cursor Projects\SMP_News\app"
npm run snapshot
npm run cluster-report -- .cache/snapshots/<file>.json.gz 0.32
```

Lists every story covered by two or more owners, with the headlines grouped into it. The second number is the similarity threshold (higher = stricter grouping); the live value is `DEFAULT_CLUSTER_OPTIONS` in `src/lib/cluster.ts`.

**Story IDs stay the same (11 Nov 2026):** a story's ID (and web address, summary and photo) used to come from its earliest report, so it changed when that report left the feeds; about ten written stories an hour were being written again. Now each edition matches its stories to the earlier ones by the reports they share, and a matched story keeps its ID (`src/lib/identity.ts`, state in `.cache/stories.json`, kept 4 days). When stories merge, the one sharing most reports keeps its ID; when one splits, the part with most of the old reports keeps it. On two snapshots 14 hours apart, 104 of 146 multi-outlet stories kept their ID (74 before); the rest were new.

**Different places stay apart (11 Nov 2026):** a headline that names an Australian state or a New Zealand region (by name or main towns) doesn't join a story whose headlines only name other ones, so "Thunderstorms forecast for Otago" and "thunderstorms over Brisbane" are two stories (`REGIONS` in `src/lib/cluster.ts`). Headlines that name no place, or one of the same places, group as before. On two saved snapshots this split none of the existing multi-outlet stories. Ambiguous names (Victoria, Canterbury, Hamilton, Nelson, Newcastle) and Canberra are left out on purpose.

### Weather and daily quiz

- **Weather** (`src/lib/weather.ts`, page `/weather/`, strip at the top of the front page): 7-day forecasts for the 8 capitals from [Open-Meteo](https://open-meteo.com/), one request per edition, free for non-commercial sites (no ads, no subscriptions), data CC BY 4.0 with the credit shown. The Bureau of Meteorology's website forecasts can't be republished or scraped (personal use only, bom.gov.au/other/copyright.shtml), and Open-Meteo no longer serves the Bureau's ACCESS model, so this is Open-Meteo's best blend. If the site ever carries ads or subscriptions, Open-Meteo needs a paid plan. The strip shows the reader's capital from their browser time zone or their choice (kept in their browser only); without scripts, Perth. If Open-Meteo is down, the strip is left out and the page says so.
- **Daily quiz** (`src/lib/quiz.ts`, page `/quiz/`, box beside the Wikipedia facts): 10 multiple-choice questions from the [Open Trivia Database](https://opentdb.com/) (CC BY-SA 4.0), chosen once per Perth day, easiest first, at most 2 per category and 3 hard ones. Niche, American-only and divisive categories and wording are filtered out (`LEFT_OUT`, `US_ONLY`, `UNSUITABLE`). Today's quiz and every question used before are kept in `.cache/quiz.json` (GitHub's Actions cache), so questions don't repeat. Readers' answers stay in their browser.

### AI summaries: switch on or off

Summaries are written during the hourly edition when the repository variable `SUMMARIES` is `on` (smp-news → Settings → Secrets and variables → Actions → Variables). Delete the variable, or set it to anything else, to switch them off; the next edition shows headlines only and the banner and About page change wording to match. Code: `src/ai/summarise.ts`.

- **Which model:** for front-page stories, the free Flash models first (about 20 free requests a day each), then free Flash-Lite (about 500 a day each, shared with photo search words). Every answer goes through the support check (`src/ai/validate.ts`); a failed answer gets one retry with the reasons, then the next model tries. Busy models are skipped for a minute.
  Other stories use Flash-Lite first, then any Flash allowance that is left. Gemma 4 (free, with a larger allowance) was tested on 11 Nov 2026 and is not usable for this: on full summary prompts it timed out after 2 minutes or returned server errors.
- **Paid key (owner, 11 Nov 2026):** only for a **front-page story with no summary yet**, after every free model failed or ran out. Everything else waits for the free allowance, which resets at 4 or 5 pm Perth: new stories elsewhere on the site show headlines only until then, and rewrites of stories that already have a summary (new outlets joined, headline naming) keep the old one. Waiting stories are listed in `pending` in `.cache/summaries.json` with the time they started waiting; the edition log and the update email show how many and the longest wait.
- **Only what is still news is written (owner, 11 Nov 2026):** off the front page, a story is written or rewritten only while a major outlet's homepage carries it now (`front`), or a report came in within the last 6 hours (`CURRENT_HOURS` in `summarise.ts`). After a stretch with no updates or no free allowance, older stories that built up fall away quietly (headlines only) instead of being caught up on; a summary a story already has stays. The queue runs front page first, then by what the major outlets are leading with (`lead`).
- **Stories stay written:** a summary is kept while its story is on the site, and for 3 days after it was last shown. It is only rewritten when the story develops (2 or more new owner groups, at most every 3 hours), when a one-outlet story gains a second, or when a rule bump says so (`LEGAL_RULES`, `FORMAT`, `NAMING`, `CHECKS`).
- **Nothing paid is lost:** the summaries file is saved after every story, written whole or not at all (`src/lib/state-file.ts`), and the workflow saves it (with the photo and story-ID files) even when the edition fails or is stopped. The edition step stops at 24 minutes so the save steps always run. The code stops at **A$3.20 a Perth day** and **A$0.40 per edition**, using an exchange rate of 1.6 to stay on the safe side; Google's A$100 monthly cap is the backstop. Change `DAILY_PAID_LIMIT_AUD` to adjust. `SUMMARY_PAID_MODEL` (variable, optional) picks the paid model; unset or empty means `gemini-3.1-flash-lite`, and only models with a price in `PAID_PRICES` can be used. If the log shows `paid 0` all day while `waiting` climbs, the paid key is not being used: check the secret and this variable.
- **Length:** the owner wants about three paragraphs where the reports allow it. Up to 9 sentences, sized to how much the outlets' descriptions say: about one sentence per 100 characters of material, at least 4 (2 for one report). The number is a ceiling and the model is told never to pad, so a thinly covered story stays short. Changing this does not rewrite existing summaries (only the `FORMAT` bump in `summarise.ts` does that, and it costs paid credit). `summarySentences()` in `src/ai/prompt.ts`. Summaries written before 9 Nov 2026 in the old 2-to-4-sentence format are rewritten once when the story now supports a longer one.
- **Full articles** (`src/lib/article.ts`): when a story includes a source with `full_text_allowed` (and not paywalled) and the paid key has room today, up to 3 of those articles are fetched (robots.txt checked for the exact page, our `SMPNewsBot` user agent, 15-second timeout), the main paragraphs extracted (about 4,000 characters at most) and given to the **paid model only**, in place of the description. The free tier never receives full text. If that fails or the paid limit is reached, the story goes down the usual free ladder with descriptions. The text lives in memory for that one call; it is never cached, stored or published, and the note under the write-up says how many full articles were read. If a source's page layout changes and the extractor gets nothing, the story silently falls back to the description.
- **Rewrites:** a summary is rewritten when 2 or more new independent owners join the story, at most every 3 hours.
- **Court and crime** (`src/ai/legal-risk.ts`): crime stories are written in careful mode (allegations attributed, presumption of innocence). Sexual-offence (including sexual misconduct and harassment), youth, suicide and suppression-order stories get "brief" mode: at most 3 sentences, no relationships, schools, suburbs or suicide methods; suicide stories show Lifeline and Beyond Blue numbers.
- **Names (owner, 11 Nov 2026: vague "a British author" headlines read like clickbait):** headlines name the main person when the reports do. In careful and brief stories a person may be named only when at least two independent outlets name them (in sexual-offence stories, in their own headlines, since victims are never put in headlines). Never named: anyone the reports call a victim or complainant in a sensitive story; anyone at all in a story mentioning a suppression order, someone who "cannot be named", a children's or youth court, young offenders or suicide, or a child together with a family relationship (naming the adult would identify the child). When a child or teenager is involved otherwise (an adult accused of grooming teenagers), the name must be in at least three outlets' own headlines (`src/ai/named.ts`). The support check rejects any other name.
- **Each edition** spends at most 10 minutes on summaries (a single call gives up after 45 seconds and the next model tries); stories that don't fit wait for the next hour. The log line ends with counts, e.g. `summaries for 30/134 (new 23: free 23, paid 0; kept 7; failed checks 2; waiting 52; paid A$0.000 this run, A$0.00 today)`.
- **Failed checks:** each story whose write-up failed gets a log line `Summary failed checks for <id> "<headline>" (<mode>): <model>: <reasons>`. A failed story is retried after 3 hours, at most 3 times; bumping `CHECKS` in `summarise.ts` (after relaxing or fixing a check) gives every failed story a fresh try. Two known causes, fixed 10 Nov 2026: Flash-Lite sometimes thinks until it runs out of room (`MAX_TOKENS`, so the retry uses minimal thinking), and brief (sensitive) stories whose reports hold a single fact; one checked sentence is now enough for those.
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

### Nightly report (emailed at 9:30 pm Perth time)

Every evening the owner gets "S.M.P. News nightly report, <date>: all good" (or "N things to look at"), filed under the Gmail label "SMP News". It covers the last 24 hours:
- edition runs: succeeded, failed, missing, slowest, and the slowest stage;
- the live front page: up, how fresh, repeated photos, section artwork instead of photos, top stories without a summary;
- feeds failing all day, the photo mix, summaries written and failed, and paid AI spend against the A$3.20 cap.

Visitor numbers aren't included: the site has no analytics by design.

**After every hourly update** the owner also gets "S.M.P. News update <time>: OK" (or "FAILED" / "N to look at"), with that run's feeds, summaries, photos and timings, and an "AI costs" section: paid spend today against the cap and when the free allowance first ran short, month to date with a projection, summaries written free vs paid, and free requests per model since Google's daily reset (about 4 pm Perth) with when each model's free share ran out. It is the `Email this update` step at the end of `edition.yml` (`REPORT_KIND=edition`); a failure to send never fails the edition. Each edition records its requests per model (`ai` in `.cache/history.json`, counted in `src/ai/gemini.ts`). Today's paid figure is the larger of those records and the summaries' own running total for the day, because two overlapping runs can lose each other's history record.
- **How it works:** the Worker's second cron (`30 13 * * *` UTC) starts `.github/workflows/report.yml`. That runs `scripts/report.ts`, which reads each edition's numbers (`.cache/history.json`, written by `src/lib/history.ts`), GitHub's run list and the live site, and posts the text to the Worker's `https://smp-news-scheduler.smp1984-622.workers.dev/report` (repository variable `REPORT_URL`, secret `REPORT_TOKEN`). The Worker emails it through Email Routing from `reports@thesmpnews.com`, addressed to `admin@` so the Gmail filter catches it, delivered to the Worker secret `REPORT_TO` (a verified destination address).
- **Send one now:** Actions → Nightly report → Run workflow. Preview without sending: `$env:GITHUB_TOKEN = (gh auth token); $env:REPORT_DRY_RUN = "1"; npx tsx scripts/report.ts`.
- **Change the recipient:** add it as a verified destination in Email Routing, then `"new@address" | npx wrangler secret put REPORT_TO` from `scheduler/`.
- **Change what counts as a problem:** the `attention.push(...)` lines in `scripts/report.ts`.
- **If it stops arriving:** check Actions → Nightly report (a red run's log says why), then the Worker's logs in Cloudflare. If the report token ever leaks, make a new one and set it in both places (`npx wrangler secret put REPORT_TOKEN` and `gh secret set REPORT_TOKEN`).
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
| `lean` | `left`, `centre-left`, `centre`, `centre-right` or `right`, or `null` (see below). The coverage bar folds this to left / centre / right. Feel Good stories show no bar |
| `content_type` | `news`, `analysis`, `opinion` (not counted towards agreement), `feel-good`, `community` (local/suburban/student papers, community radio: unrated, shown as "local / unrated" in the bar) or `official` (government, police, universities: lean must be `null`, never in the bar, labelled "Official statement") |
| `owner_group` | Parent company, e.g. `News Corp`. Outlets with the same owner count once for independence |
| `paywall` | `free`, `partial` or `paywalled` |
| `region_of_rating` | Where the lean rating comes from: `AU`, `US` or `UK` |
| `enabled` | `false` switches the source off without deleting it |
| `full_text_allowed` | Whether the full article may be fetched and used as research for our own summaries (see "Full articles" above). `true` only where the outlet's licence or terms allow it (10 sources as of 10 Nov 2026; 360info and Global Voices added that day under CC BY. Checked and not added: ProPublica, which forbids automatic use; Mongabay, licensed per article only; and Treasury ministers, which is CC BY but has no current feed); everything else uses only the feed's title and description |
| `terms_url`, `full_text_basis` | Required when `full_text_allowed` is `true`: the terms or licence page, and the reason in a few words (e.g. "Creative Commons Attribution 4.0"). Re-check these yearly; outlets change their terms |
| `ai_input_allowed` | Whether the feed's title/description may go to an AI model. Set by `npm run check-terms` |
| `feeds` | One or more `{ url, sections, via }`. `via` is always `direct` (the outlet's own feed). Google News feeds are not allowed: their terms limit them to personal feed readers |

To **disable** a source: set `"enabled": false` and add a `notes` line saying why.
To **fix a broken feed**: find the outlet's new feed address, replace `url`, then run `npm run check-feeds`.
To **add a source**: copy an existing entry, change every field, then run `npm run validate-config`, `npm run check-terms` and `npm run check-feeds`.

`lean` may be `null` for `community` and `official` sources, or for sources that publish only in sport, science-tech, tech, entertainment or feel-good; those sources don't appear in the left / centre / right part of the bar. If a lean isn't from AllSides or Media Bias/Fact Check, say so in `notes` ("Lean is editorial judgement").

Valid sections: `local-wa`, `australia`, `new-zealand`, `world`, `politics`, `business`, `sport`, `science-tech` (shown as "Science & Space"), `tech` (shown as "AI, Tech & Gadgets"), `entertainment`, `feel-good`. CI rejects any push where `sources.json` is invalid.

Headlines that are plainly shopping posts (for example "save $80", "40% off", "lowest price", "promo code", gift guides, Black Friday deals), puzzles (crossword, sudoku, Wordle) and sponsored content (links under `/sponsored/`, `/sponsored-content/`, `/partner-content/` or `/advertorial/`) are dropped automatically; the patterns are in `src/lib/blocklist.ts`.

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
