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

## Recipes

*Added as each part of the pipeline is built:* pausing and resuming the site, re-running a failed edition, switching AI provider, adding or disabling a source, taking down a story, rotating keys, rolling back, reading a failed Actions log.
