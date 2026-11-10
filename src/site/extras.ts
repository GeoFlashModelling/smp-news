import type { Quiz } from "../lib/quiz.js";
import { describe, type Day, type Forecast } from "../lib/weather.js";
import { SITE_NAME, esc, page } from "./html.js";

const WEATHER_CREDIT = `Forecasts from <a href="https://open-meteo.com/" rel="noopener">Open-Meteo.com</a> (<a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener license">CC BY 4.0</a>). For warnings, check the <a href="https://www.bom.gov.au/australia/warnings/" rel="noopener">Bureau of Meteorology</a>.`;
const QUIZ_CREDIT = `Questions from the <a href="https://opentdb.com/" rel="noopener">Open Trivia Database</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener license">CC BY-SA 4.0</a>.`;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 10"; site.js turns the reader's own today into "Today". */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function dayItem(day: Day, wide: boolean): string {
  const w = describe(day.code, day.mm);
  const rain = day.rain >= 10 ? `${day.rain}%${wide && day.mm >= 1 ? `, ${day.mm} mm` : ""}` : "";
  return `<li data-date="${day.date}"><span class="wx-day">${dayLabel(day.date)}</span><span class="wx-icon" role="img" aria-label="${w.text}">${w.icon}</span>${wide ? `<span class="wx-text">${w.text}</span>` : ""}<span class="wx-t"><b>${day.max}°</b> ${day.min}°</span><span class="wx-rain">${rain ? `<span class="visually-hidden">Chance of rain </span>${rain}` : ""}</span></li>`;
}

function days(f: Forecast, wide: boolean, hidden: boolean): string {
  return `<ol class="wx-days" data-city="${f.city.id}"${hidden ? " hidden" : ""}>${f.days.map((d) => dayItem(d, wide)).join("")}</ol>`;
}

/**
 * Front-page strip: every capital's week is in the page; site.js shows the reader's city (from their time zone or
 * their last choice). Without scripts, Perth shows.
 */
export function weatherStrip(forecasts: Forecast[] | null, root: string): string {
  if (!forecasts) return "";
  const options = forecasts.map((f) => `<option value="${f.city.id}" data-tz="${esc(f.city.timeZones.join(" "))}">${esc(f.city.name)} (${f.city.state})</option>`).join("");
  return `<section class="wx" aria-labelledby="h-wx" data-wx>
<div class="wx-head"><h2 id="h-wx">Weather <span class="wx-name" data-wx-name>${esc(forecasts[0]!.city.name)}</span></h2><label class="wx-change">Change <select data-wx-select>${options}</select></label><a class="wx-all" href="${root}weather/">All capitals →</a></div>
${forecasts.map((f, n) => days(f, false, n > 0)).join("")}
<p class="wx-credit">${WEATHER_CREDIT}</p>
</section>`;
}

export function renderWeather(forecasts: Forecast[] | null, updated: Date): string {
  const root = "../";
  const cities = forecasts
    ? forecasts.map((f) => `<section class="wx wx-city" id="${f.city.id}" aria-labelledby="h-${f.city.id}"><h2 id="h-${f.city.id}">${esc(f.city.name)} <span class="wx-state">${f.city.state}</span></h2>${days(f, true, false)}</section>`).join("")
    : `<p class="callout">The forecast couldn't be loaded for this edition. It will be back next hour.</p>`;
  const body = `<article class="weather">
<h1>7-day weather</h1>
<p class="note">Highs and lows in °C, with the chance of rain when it is 10% or more. Updated every hour.</p>
${cities}
<p class="wx-credit">${WEATHER_CREDIT}</p>
</article>`;
  return page({ title: `Weather | ${SITE_NAME}`, description: "Seven-day forecasts for every Australian capital city.", root, active: "weather", body, updated });
}

/** A box beside "On this day" and "Fun fact" on the front page. */
export function quizBox(quiz: Quiz | null, root: string): string {
  if (!quiz) return "";
  const topics = [...new Set(quiz.questions.map((q) => q.category))].slice(0, 4).join(", ");
  return `<div class="fact fact-quiz"><p class="fact-label">Daily quiz</p><p class="fact-title">Need a break? Ten Questions. You Can Do It!</p><p class="fact-text">Today: ${esc(topics)} and more. New questions every day.</p><p><a class="quiz-go" href="${root}quiz/">Play today's quiz</a></p></div>`;
}

export function renderQuiz(quiz: Quiz | null, updated: Date): string {
  const root = "../";
  const letters = ["A", "B", "C", "D"];
  const questions = quiz
    ? `<ol class="quiz" data-quiz="${quiz.day}">${quiz.questions
        .map(
          (q, n) => `<li class="q" data-correct="${q.correct}">
<p class="q-meta">${esc(q.category)} · ${q.difficulty}</p>
<p class="q-text" id="q${n}">${esc(q.question)}</p>
<div class="q-answers" role="group" aria-labelledby="q${n}">${q.answers.map((a, i) => `<button type="button" data-i="${i}"><span class="q-letter">${letters[i]}</span> ${esc(a)}</button>`).join("")}</div>
<p class="q-result" aria-live="polite"></p>
<noscript><details><summary>Show answer</summary><p>${letters[q.correct]}: ${esc(q.answers[q.correct]!)}</p></details></noscript>
</li>`,
        )
        .join("")}</ol>
<p class="quiz-score" data-quiz-score aria-live="polite"></p>`
    : `<p class="callout">Today's quiz couldn't be loaded. Try again next hour.</p>`;
  const body = `<article class="quiz-page">
<h1>Daily quiz</h1>
<p class="note">Ten multiple-choice questions, new every day at midnight Perth time. Pick an answer to see if you're right; your score stays on this device only.</p>
${questions}
<p class="wx-credit">${QUIZ_CREDIT}</p>
</article>`;
  return page({ title: `Daily quiz | ${SITE_NAME}`, description: "Ten general-knowledge questions, new every day.", root, active: "quiz", body, updated });
}
