/**
 * S.M.P. News scheduler (Cloudflare Worker, cron trigger). GitHub's own `schedule:` drops or delays many runs,
 * so this starts the Edition workflow every hour instead. Its only secret, GH_TOKEN, is a fine-grained token
 * limited to Actions read/write on the smp-news repository.
 */
const DISPATCH = "https://api.github.com/repos/GeoFlashModelling/smp-news/actions/workflows/edition.yml/dispatches";

/**
 * Overnight on the east coast (midnight to 6 am Sydney time, 9 pm to 3 am Perth in summer) little changes and few
 * people read, so editions run only at 00:47 and 04:47 Sydney time, saving AI requests and paid spend.
 */
const NIGHT_HOURS = new Set([0, 1, 2, 3, 4, 5]);
const NIGHT_EVERY = 4;

function sydneyHour(date) {
  return Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" }).format(date));
}

export default {
  async scheduled(event, env) {
    const hour = sydneyHour(new Date(event.scheduledTime));
    if (NIGHT_HOURS.has(hour) && hour % NIGHT_EVERY !== 0) return;
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
