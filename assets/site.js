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

// Local news: the reader's state (their last choice, else their time zone, else WA). "Use my location" works the
// state out on the device from rough borders; nothing leaves the device.
(() => {
  const line = document.querySelector("[data-local-line]");
  const select = line?.querySelector("[data-local-select]");
  if (!select) return;
  const options = [...select.options];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const byZone = options.find((o) => o.dataset.tz.split(" ").includes(zone));
  const nav = document.querySelector("[data-local-nav]");
  const navHref = nav?.getAttribute("href") ?? "";
  const message = line.querySelector("[data-local-msg]");
  const show = (section) => {
    const option = options.find((o) => o.value === section) ?? options[0];
    select.value = option.value;
    line.querySelector("[data-local-name]").textContent = option.dataset.name;
    for (const block of document.querySelectorAll("[data-local]")) block.hidden = block.dataset.local !== option.value;
    if (nav) {
      nav.setAttribute("href", navHref.replace(/local-wa\/$/, `${option.value}/`));
      nav.textContent = `Local ${option.textContent}`;
    }
  };
  const choose = (section) => {
    store.set("smp-state", section);
    show(section);
  };
  show(store.get("smp-state") ?? byZone?.value);
  line.hidden = false;
  select.addEventListener("change", () => {
    message.textContent = "";
    choose(select.value);
  });

  // The Murray, roughly, from the SA border to Cape Howe: Victoria lies south of it.
  const MURRAY = [[141, -34.0], [142.2, -34.15], [143.55, -35.3], [144.75, -36.1], [146.9, -36.07], [148.2, -36.8], [150, -37.5]];
  const murrayLat = (lon) => {
    for (let i = 1; i < MURRAY.length; i++) {
      const [x0, y0] = MURRAY[i - 1];
      const [x1, y1] = MURRAY[i];
      if (lon <= x1) return y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0);
    }
    return MURRAY[MURRAY.length - 1][1];
  };
  const stateAt = (lat, lon) => {
    if (lat > -9 || lat < -44.5 || lon < 112 || lon > 154.5) return null;
    if (lat < -39.2 && lon > 143.5) return "local-tas";
    if (lon < 129) return "local-wa";
    if (lon < 138) return lat > -26 ? "local-nt" : "local-sa";
    if (lon < 141) return lat > -26 ? "local-qld" : "local-sa";
    if (lat >= -35.92 && lat <= -35.12 && lon >= 148.76 && lon <= 149.21) return "local-act";
    if (lat > (lon < 150 ? -29 : -28.6)) return "local-qld";
    if (lon <= 150 && lat < murrayLat(lon)) return "local-vic";
    return "local-nsw";
  };
  const geo = line.querySelector("[data-local-geo]");
  if (!navigator.geolocation) return;
  geo.hidden = false;
  geo.addEventListener("click", () => {
    message.textContent = "Finding your state…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const section = stateAt(pos.coords.latitude, pos.coords.longitude);
        message.textContent = section ? "" : "You seem to be outside Australia; choose a state instead.";
        if (section) choose(section);
      },
      () => {
        message.textContent = "Location isn't available; choose a state instead.";
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 3600000 },
    );
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
