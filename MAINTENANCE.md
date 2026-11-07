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

## Recipes

*Added as each part of the pipeline is built:* pausing and resuming the site, re-running a failed edition, switching AI provider, adding or disabling a source, taking down a story, rotating keys, rolling back, reading a failed Actions log.
