# S.M.P. News

A free, Australian-focused news site. Each story groups how left-, centre- and right-leaning free sources report the same event, then shows what independent sources agree on, where they differ, a coverage bar, and a link to every source article.

A product of S.M.P.

## Status

Early development (Phase 0: foundations and feasibility). Nothing is published yet.

## How it works

A scheduled GitHub Actions workflow runs the pipeline (fetch feeds, group stories, summarise, rank) and publishes a static site to GitHub Pages. There is no server.

## Running locally

Requires Node.js 24 LTS.

```
npm install
npm run edition
```

## Maintenance

See [MAINTENANCE.md](MAINTENANCE.md).
