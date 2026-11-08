/**
 * S.M.P. News scheduler (Cloudflare Worker, cron trigger). GitHub's own `schedule:` drops or delays many runs,
 * so this starts the Edition workflow every hour instead. Its only secret, GH_TOKEN, is a fine-grained token
 * limited to Actions read/write on the smp-news repository.
 */
const DISPATCH = "https://api.github.com/repos/GeoFlashModelling/smp-news/actions/workflows/edition.yml/dispatches";

export default {
  async scheduled(_event, env) {
    const res = await fetch(DISPATCH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "smp-news-scheduler",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!res.ok) throw new Error(`Edition dispatch failed: ${res.status} ${await res.text()}`);
  },
};
