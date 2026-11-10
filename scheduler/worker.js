/**
 * S.M.P. News scheduler (Cloudflare Worker, cron triggers). GitHub's own `schedule:` drops or delays many runs,
 * so this starts the Edition workflow every hour instead, and the Nightly report workflow once a day.
 *
 * Secrets (wrangler secret put): GH_TOKEN, a fine-grained token limited to Actions read/write on the smp-news
 * repository; REPORT_TOKEN, which the report workflow must present to have its report emailed; REPORT_TO, the
 * owner's address (a verified Email Routing destination), kept out of this public repository.
 */
import { EmailMessage } from "cloudflare:email";

const WORKFLOWS = "https://api.github.com/repos/GeoFlashModelling/smp-news/actions/workflows";

/**
 * Overnight on the east coast (midnight to 6 am Sydney time, 9 pm to 3 am Perth in summer) little changes and few
 * people read, so one edition runs, at 03:47 Sydney time, saving AI requests and paid spend.
 */
const NIGHT_HOURS = new Set([0, 1, 2, 3, 4, 5]);
const NIGHT_RUN = 3;
/** 13:30 UTC: 9:30 pm in Perth, where the owner is. Must match wrangler.toml. */
const REPORT_CRON = "30 13 * * *";
const REPORT_FROM = "reports@thesmpnews.com";
/** The owner's Gmail files mail sent to this address under its "SMP News" label. */
const REPORT_SHOWN_TO = "admin@thesmpnews.com";
const MAX_REPORT_BYTES = 100_000;

function sydneyHour(date) {
  return Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" }).format(date));
}

async function dispatch(env, workflow) {
  const res = await fetch(`${WORKFLOWS}/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "smp-news-scheduler",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!res.ok) throw new Error(`${workflow} dispatch failed: ${res.status} ${await res.text()}`);
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A plain-text email as raw MIME, UTF-8 throughout (the report uses en dashes and the A$ sign). */
function mime(to, subject, text) {
  const body = base64(text.replace(/\r?\n/g, "\r\n")).replace(/.{76}/g, "$&\r\n");
  return [
    `From: S.M.P. News <${REPORT_FROM}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@thesmpnews.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

function sameToken(given, expected) {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(event, env) {
    if (event.cron === REPORT_CRON) return dispatch(env, "report.yml");
    const hour = sydneyHour(new Date(event.scheduledTime));
    if (NIGHT_HOURS.has(hour) && hour !== NIGHT_RUN) return;
    return dispatch(env, "edition.yml");
  },

  /** POST /report from the Nightly report workflow: emails its subject and text to the owner. Nothing else is served. */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/report") return new Response("Not found", { status: 404 });
    if (!sameToken(request.headers.get("authorization") ?? "", `Bearer ${env.REPORT_TOKEN}`)) return new Response("Forbidden", { status: 403 });
    const raw = await request.text();
    if (raw.length > MAX_REPORT_BYTES) return new Response("Too large", { status: 413 });
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    if (typeof report.subject !== "string" || typeof report.text !== "string") return new Response("Need subject and text", { status: 400 });
    const subject = report.subject.replace(/[\r\n]+/g, " ").slice(0, 200);
    await env.EMAIL.send(new EmailMessage(REPORT_FROM, env.REPORT_TO, mime(REPORT_SHOWN_TO, subject, report.text)));
    return new Response("Sent", { status: 200 });
  },
};
