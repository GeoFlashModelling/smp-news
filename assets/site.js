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
