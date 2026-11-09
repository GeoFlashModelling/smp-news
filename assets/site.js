// Turns <time data-rel> into "5 min ago" / "3 h ago" for recent times; older ones keep their date.
(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll("time[data-rel]")) {
    const mins = Math.round((now - Date.parse(el.getAttribute("datetime"))) / 60000);
    if (Number.isNaN(mins) || mins < 0 || mins >= 24 * 60) continue;
    el.title = el.textContent;
    el.textContent = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  }
})();

// Storage can be blocked (private modes); everything still works, it just isn't remembered.
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

// Weather: show the reader's capital (their last choice, else their time zone, else Perth). Nothing leaves the device.
(() => {
  const today = new Date().toLocaleDateString("en-CA");
  for (const li of document.querySelectorAll(".wx-days li[data-date]")) {
    if (li.dataset.date === today) li.querySelector(".wx-day").textContent = "Today";
    else if (li.dataset.date < today) li.hidden = true;
  }
  const box = document.querySelector("[data-wx]");
  if (!box) return;
  const select = box.querySelector("[data-wx-select]");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const byZone = [...select.options].find((o) => o.dataset.tz.split(" ").includes(zone));
  const show = (id) => {
    const option = [...select.options].find((o) => o.value === id) ?? select.options[0];
    select.value = option.value;
    box.querySelector("[data-wx-name]").textContent = option.textContent.replace(/\s*\(.*\)$/, "");
    for (const list of box.querySelectorAll(".wx-days")) list.hidden = list.dataset.city !== option.value;
  };
  show(store.get("smp-city") ?? byZone?.value);
  select.addEventListener("change", () => {
    store.set("smp-city", select.value);
    show(select.value);
  });
})();

// Daily quiz: pick an answer, see if it's right; answers and score are kept on this device for the day.
(() => {
  const quiz = document.querySelector("[data-quiz]");
  if (!quiz) return;
  const key = `smp-quiz-${quiz.dataset.quiz}`;
  const questions = [...quiz.querySelectorAll(".q")];
  let saved = {};
  try {
    saved = JSON.parse(store.get(key) ?? "{}");
  } catch {}
  const score = document.querySelector("[data-quiz-score]");
  const update = () => {
    const done = Object.keys(saved).length;
    const right = questions.filter((q, n) => saved[n] === Number(q.dataset.correct)).length;
    score.textContent = done === 0 ? "" : done < questions.length ? `Score so far: ${right} of ${done}` : `You scored ${right} out of ${questions.length}. New questions tomorrow!`;
  };
  const answer = (q, n, chosen) => {
    const correct = Number(q.dataset.correct);
    const buttons = [...q.querySelectorAll("button")];
    buttons.forEach((b, i) => {
      b.disabled = true;
      if (i === correct) b.classList.add("right");
      else if (i === chosen) b.classList.add("wrong");
    });
    q.querySelector(".q-result").textContent = chosen === correct ? "Correct!" : `Not quite: the answer is ${buttons[correct].textContent.trim().slice(2)}.`;
  };
  questions.forEach((q, n) => {
    if (n in saved) answer(q, n, saved[n]);
    q.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        saved[n] = Number(b.dataset.i);
        store.set(key, JSON.stringify(saved));
        answer(q, n, saved[n]);
        update();
      }),
    );
  });
  update();
})();
