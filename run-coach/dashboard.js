// Run Coach dashboard: loads Garmin data once, then re-renders every section for the chosen range.
(() => {
  const RC = window.RC;
  const F = RC.fmt;
  const { sum, avg } = RC.util;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const COLORS = {
    blue: "#3987e5",
    grid: "rgba(140, 150, 255, 0.10)",
    text: "#9aa0c7",
    muted: "#6d7299",
    surface: "#11142e",
    neutral: "#8a8fb3",
    zones: ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"],
    sleep: { deep: "#256abf", light: "#9ec5f4", rem: "#5598e7", awake: "#8a8fb3" },
  };
  const STATUS_WORD = { good: "Good", warn: "Watch", bad: "Act", info: "Tip" };

  let ctx = null;
  let rangeDays = 30;
  const charts = {};
  let actFilter = "all", actSearch = "", actShown = 25;

  try { rangeDays = Number(localStorage.getItem("rc-range")) || 30; } catch { /* storage blocked */ }

  // ------------------------------------------------------------------ loading
  const progress = (t) => { $("loading-text").textContent = t; };

  async function pool(tasks, size = 4) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: size }, async () => {
      while (next < tasks.length) {
        const i = next++;
        try { results[i] = { ok: true, value: await tasks[i]() }; } catch (e) { results[i] = { ok: false, error: e }; }
      }
    }));
    return results;
  }

  function chunks(totalDays, size) {
    const out = [];
    for (let end = 0; end < totalDays; end += size) {
      out.push([RC.iso(RC.daysAgo(Math.min(totalDays - 1, end + size - 1))), RC.iso(RC.daysAgo(end))]);
    }
    return out;
  }

  async function fetchActivities() {
    const all = [];
    const startDate = RC.iso(RC.daysAgo(365)), endDate = RC.iso(RC.daysAgo(0));
    for (let start = 0; start < 2000; start += 100) {
      const page = await RC.api.get("/activitylist-service/activities/search/activities", { start, limit: 100, startDate, endDate });
      if (!Array.isArray(page) || !page.length) break;
      all.push(...page);
      progress(`Loading activities… ${all.length}`);
      if (page.length < 100) break;
    }
    return all;
  }

  async function loadAll() {
    const DAYS = 180;
    const sleepChunks = chunks(DAYS, 31), hrvChunks = chunks(DAYS, 31);
    const tasks = [
      () => RC.api.get("/userprofile-service/userprofile/settings"),
      () => RC.api.get("/biometric-service/heartRateZones/v2"),
      fetchActivities,
      () => RC.api.get("/usersummary-service/v2/dailysummaries", { startDate: RC.iso(RC.daysAgo(DAYS - 1)), endDate: RC.iso(RC.daysAgo(0)) }),
      () => RC.api.get(`/fitnessage-service/fitnessage/v2/${RC.iso(RC.daysAgo(0))}`),
      ...sleepChunks.map(([a, b]) => () => RC.api.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: a, endDate: b })),
      ...hrvChunks.map(([a, b]) => () => RC.api.get(`/hrv-service/hrv/daily/${a}/${b}`)),
    ];
    progress("Loading your Garmin data…");
    const r = await pool(tasks);
    const unauthorized = r.find((x) => !x.ok && x.error.status === 401);
    if (unauthorized) throw unauthorized.error;

    const names = ["profile", "heart-rate zones", "activities", "daily summaries", "fitness age"];
    const failed = r.map((x, i) => (!x.ok ? names[i] || (i < 5 + sleepChunks.length ? "sleep" : "HRV") : null)).filter(Boolean);
    if (r[2] && !r[2].ok) throw r[2].error;

    const val = (i) => (r[i] && r[i].ok ? r[i].value : null);
    const sleep = [], hrv = [];
    for (let i = 0; i < sleepChunks.length; i++) { const v = val(5 + i); if (Array.isArray(v)) sleep.push(...v); }
    for (let i = 0; i < hrvChunks.length; i++) { const v = val(5 + sleepChunks.length + i); if (v?.hrvSummaries) hrv.push(...v.hrvSummaries); }

    return {
      raw: {
        profile: val(0), zones: val(1), activities: val(2) || [],
        dailySummaries: val(3)?.data || [], fitnessAge: val(4), sleep, hrv,
      },
      failed: [...new Set(failed)],
    };
  }

  // ------------------------------------------------------------------ chart helpers
  if (window.Chart) {
    Chart.defaults.color = COLORS.text;
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.borderColor = COLORS.grid;
    Chart.defaults.plugins.legend.display = false;
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: COLORS.surface, borderColor: "rgba(140,150,255,0.3)", borderWidth: 1,
      titleColor: "#e8eaff", bodyColor: "#c9cdf0", padding: 10, cornerRadius: 8, boxPadding: 4,
    });
  }

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    const canvas = $(id);
    const box = canvas.parentElement;
    box.querySelector(".empty")?.remove();
    canvas.hidden = false;
    if (!window.Chart) return emptyChart(id, "Charts couldn't load (offline?)");
    charts[id] = new Chart(canvas, {
      ...config,
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        ...config.options,
      },
    });
  }

  function emptyChart(id, text) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const canvas = $(id);
    canvas.hidden = true;
    const box = canvas.parentElement;
    if (!box.querySelector(".empty")) box.insertAdjacentHTML("beforeend", `<div class="empty">${esc(text)}</div>`);
  }

  function legend(id, items) {
    $(id).innerHTML = items.map(([label, color]) => `<span><i style="background:${color}"></i>${esc(label)}</span>`).join("");
  }

  const shortDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const paceTick = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const axis = (extra = {}) => ({ grid: { color: COLORS.grid }, border: { display: false }, ...extra });
  const xAxis = (extra = {}) => ({ grid: { display: false }, border: { color: COLORS.grid }, ticks: { maxRotation: 0, autoSkipPadding: 14 }, ...extra });

  function weekBuckets(days) {
    // Weeks start on the user's first day of week (Garmin profile), else Monday.
    const firstName = (ctx.profile.firstDayOfWeek?.dayName || "monday").toLowerCase();
    const first = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(firstName);
    const start = RC.daysAgo(days - 1);
    while (start.getDay() !== (first < 0 ? 1 : first)) start.setDate(start.getDate() - 1);
    const out = [];
    for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 7)) {
      const from = new Date(d); from.setHours(0, 0, 0, 0);
      const to = new Date(from); to.setDate(to.getDate() + 7);
      out.push({ from, to, label: shortDate(RC.iso(from)) });
    }
    return out;
  }

  function buckets() {
    if (rangeDays <= 14) {
      return RC.datesBack(rangeDays).map((iso) => {
        const from = new Date(iso + "T00:00:00"); const to = new Date(from); to.setDate(to.getDate() + 1);
        return { from, to, label: new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" }) };
      });
    }
    return weekBuckets(rangeDays);
  }

  // ------------------------------------------------------------------ sections
  function renderReadiness() {
    const r = RC.readiness(ctx);
    const color = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", unknown: "var(--faint)" }[r.level];
    const pct = r.score ?? 0;
    const C = 2 * Math.PI * 48;
    const rec = r.recovery.hours > 0
      ? `Estimated recovery left: <strong>${r.recovery.hours} h</strong> (about ${r.recovery.readyAt.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })})`
      : "Recovered from recent training.";
    $("readiness").innerHTML = `
      <div class="ready-top">
        <div class="ring" role="img" aria-label="Readiness ${r.score ?? "unknown"} out of 100">
          <svg viewBox="0 0 112 112"><circle cx="56" cy="56" r="48" fill="none" stroke="rgba(140,150,255,0.14)" stroke-width="9"/>
          <circle cx="56" cy="56" r="48" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(C * pct) / 100} ${C}"/></svg>
          <div class="val"><div><b>${r.score ?? "—"}</b><span>READINESS</span></div></div>
        </div>
        <div>
          <span class="status ${r.level === "unknown" ? "info" : r.level}">${{ good: "Ready", warn: "Moderate", bad: "Low", unknown: "Unknown" }[r.level]}</span>
          <h3 style="margin-top:8px">${esc(r.headline)}</h3>
          <p class="recov">${rec}</p>
        </div>
      </div>
      <ul class="factors">${r.parts.map((p) => `
        <li><span>${esc(p.label)}</span><strong>${esc(p.value)}</strong>
        <span class="meter"><i style="width:${Math.round(p.score)}%;background:${p.score >= 70 ? "var(--good)" : p.score >= 45 ? "var(--warn)" : "var(--bad)"}"></i></span>
        <span class="f-note">${esc(p.note)}</span></li>`).join("")}
      </ul>
      <p class="small" style="color:var(--faint)">Run Coach estimate combining sleep, HRV, resting HR, Body Battery and recent load. Garmin's own Training Readiness and Recovery Time aren't in the Personal API.</p>`;
    return r;
  }

  function renderKpis() {
    const acts = RC.actsWithin(ctx, rangeDays);
    const runs = acts.filter((a) => a.type === "run" || a.type === "trail");
    const walks = acts.filter((a) => a.type === "walk" || a.type === "hike");
    const runDist = sum(runs.map((a) => a.dist));
    const runMoving = sum(runs.map((a) => a.moving));
    const vo2 = RC.vo2Series(ctx);
    const vo2Now = vo2.length ? vo2[vo2.length - 1].value : null;
    const rhr = avg(RC.datesBack(7).map((d) => ctx.days[d]?.rhr));
    const hrvKey = Object.keys(ctx.hrv).sort().pop();
    const hrv = hrvKey ? ctx.hrv[hrvKey] : null;
    const sleepDays = RC.datesBack(Math.min(rangeDays, 180)).map((d) => ctx.sleep[d]).filter(Boolean);
    const steps = avg(RC.datesBack(Math.min(rangeDays, 180)).map((d) => ctx.days[d]?.steps));
    const elev = sum(acts.map((a) => a.elev));
    const unit = F.distUnit(ctx);
    const tiles = [
      ["Running distance", F.distNum(ctx, runDist).toFixed(1), unit, walks.length ? `+ ${F.dist(ctx, sum(walks.map((a) => a.dist)))} walk/hike` : "run + trail"],
      ["Runs", runs.length, "", `${(runs.length / (rangeDays / 7)).toFixed(1)} per week`],
      ["Avg run pace", runMoving ? F.pace(ctx, runDist / runMoving).split(" ")[0] : "—", runMoving ? `/${unit}` : "", "moving time"],
      ["Time active", F.hours(sum(acts.map((a) => a.dur))).replace(" ", ""), "", `${acts.length} activities`],
      ["VO2max", vo2Now ?? "—", vo2Now ? "est." : "", ctx.fitnessAge ? `fitness age ${ctx.fitnessAge.fitnessAge.toFixed(0)}` : "from runs"],
      ["Resting HR", rhr ? Math.round(rhr) : "—", rhr ? "bpm" : "", "7-day average"],
      ["HRV last night", hrv?.last ?? "—", hrv?.last ? "ms" : "", hrv?.status ? hrv.status.toLowerCase() : ""],
      ["Sleep", sleepDays.length ? (avg(sleepDays.map((s) => s.total)) / 3600).toFixed(1) : "—", sleepDays.length ? "h" : "", sleepDays.length ? `avg score ${Math.round(avg(sleepDays.map((s) => s.score)) || 0)}` : ""],
      ["Steps", steps ? Math.round(steps).toLocaleString() : "—", "", "daily average"],
      ["Elevation gain", F.elev(ctx, elev).split(" ")[0], ctx.imperial ? "ft" : "m", "all activities"],
    ];
    $("kpis").innerHTML = tiles.map(([l, v, u, s]) => `
      <div class="card kpi"><div class="k-label">${esc(l)}</div><div class="k-val">${esc(v)}<small>${esc(u)}</small></div><div class="k-sub">${esc(s)}</div></div>`).join("");
  }

  function renderInsights() {
    const list = RC.insights(ctx, rangeDays);
    $("insights").innerHTML = list.length ? list.map((i) => `
      <div class="card insight"><span class="status ${i.level}">${STATUS_WORD[i.level]}</span><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join("")
      : `<div class="card insight"><p>Not enough activity in this period for coaching tips. Try a longer range.</p></div>`;
  }

  function renderPlan(ready) {
    const p = RC.weekPlan(ctx, ready);
    $("plan-sum").textContent = `Target about ${F.dist(ctx, p.targetKm * 1000, 0)} over ${p.nRuns} runs (your 4-week average: ${F.dist(ctx, p.weeklyKm * 1000, 0)}/week). Adjusts every day from your readiness and load.`;
    $("plan").innerHTML = p.days.map((d, i) => `
      <div class="card day ${d.session.kind}${i === 0 ? " today" : ""}">
        <div class="d-name">${i === 0 ? "Today" : d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div>
        <div class="d-title">${esc(d.session.title)}</div>
        <div class="d-detail">${esc(d.session.detail)}</div>
      </div>`).join("");
  }

  function renderDistance() {
    const b = buckets();
    const types = ["run", "trail", "walk", "hike"];
    const acts = RC.actsWithin(ctx, rangeDays + 7);
    const present = types.filter((t) => acts.some((a) => a.type === t));
    $("dist-sub").textContent = rangeDays <= 14 ? `Per day, ${F.distUnit(ctx)}` : `Per week, ${F.distUnit(ctx)}`;
    if (!present.length) { $("dist-legend").innerHTML = ""; return emptyChart("c-dist", "No runs, walks or hikes in this period"); }
    legend("dist-legend", present.map((t) => [RC.TYPES[t].label, RC.TYPES[t].hex]));
    draw("c-dist", {
      type: "bar",
      data: {
        labels: b.map((x) => x.label),
        datasets: present.map((t) => ({
          label: RC.TYPES[t].label,
          backgroundColor: RC.TYPES[t].hex,
          borderColor: COLORS.surface, borderWidth: { top: 2 }, borderSkipped: "bottom", borderRadius: 4,
          maxBarThickness: 34,
          data: b.map((x) => +F.distNum(ctx, sum(acts.filter((a) => a.type === t && a.start >= x.from && a.start < x.to).map((a) => a.dist))).toFixed(1)),
        })),
      },
      options: {
        scales: { x: xAxis({ stacked: true }), y: axis({ stacked: true, beginAtZero: true }) },
        plugins: { tooltip: { callbacks: { label: (c) => c.raw ? ` ${c.dataset.label}: ${c.raw} ${F.distUnit(ctx)}` : null, footer: (items) => `Total ${items.reduce((s, i) => s + i.raw, 0).toFixed(1)} ${F.distUnit(ctx)}` } } },
      },
    });
  }

  function renderZones() {
    const runs = RC.actsWithin(ctx, rangeDays).filter((a) => a.type === "run" || a.type === "trail");
    const z = [0, 1, 2, 3, 4].map((i) => sum(runs.map((a) => a.zones[i])));
    const tot = sum(z);
    const f = ctx.zones.floors;
    $("zone-sub").textContent = tot ? `${F.hours(tot)} of running · ${Math.round((z[0] + z[1]) / tot * 100)}% easy (target ~80%)` : "";
    if (!tot) return emptyChart("c-zones", "No heart-rate zone data for runs in this period");
    const labels = [1, 2, 3, 4, 5].map((i) => {
      const lo = f[i - 1], hi = i < 5 ? f[i] - 1 : ctx.zones.max;
      return lo ? `Z${i}  ${lo}–${hi ?? ""}` : `Zone ${i}`;
    });
    draw("c-zones", {
      type: "bar",
      data: { labels, datasets: [{ data: z.map((v) => Math.round(v / 60)), backgroundColor: COLORS.zones, borderRadius: 4, borderSkipped: "start", maxBarThickness: 26 }] },
      options: {
        indexAxis: "y",
        interaction: { mode: "nearest", intersect: true, axis: "y" },
        scales: { x: axis({ beginAtZero: true, title: { display: true, text: "minutes", color: COLORS.muted } }), y: xAxis({ ticks: { font: { family: "Inter", size: 11 } } }) },
        plugins: { tooltip: { callbacks: { label: (c) => ` ${c.raw} min · ${Math.round(z[c.dataIndex] / tot * 100)}%` } } },
      },
    });
  }

  function renderPace() {
    const runs = RC.actsWithin(ctx, rangeDays).filter((a) => (a.type === "run" || a.type === "trail") && a.movingSpeed && a.dist > 800).reverse();
    if (!runs.length) { $("pace-legend").innerHTML = ""; return emptyChart("c-pace", "No runs in this period"); }
    const types = ["run", "trail"].filter((t) => runs.some((a) => a.type === t));
    legend("pace-legend", types.map((t) => [RC.TYPES[t].label, RC.TYPES[t].hex]));
    draw("c-pace", {
      type: "scatter",
      data: {
        datasets: types.map((t) => ({
          label: RC.TYPES[t].label,
          data: runs.filter((a) => a.type === t).map((a) => ({ x: a.start.getTime(), y: F.paceSec(ctx, a.movingSpeed), a })),
          backgroundColor: RC.TYPES[t].hex, borderColor: COLORS.surface, borderWidth: 2, pointRadius: 5, pointHoverRadius: 7,
        })),
      },
      options: {
        interaction: { mode: "nearest", intersect: true },
        scales: {
          x: xAxis({ type: "linear", ticks: { callback: (v) => shortDate(RC.iso(new Date(v))), maxTicksLimit: 6, maxRotation: 0 } }),
          y: axis({ reverse: true, ticks: { callback: paceTick }, title: { display: true, text: `min/${F.distUnit(ctx)}`, color: COLORS.muted } }),
        },
        plugins: { tooltip: { callbacks: {
          title: (items) => items[0].raw.a.name,
          label: (c) => ` ${shortDate(c.raw.a.date)} · ${F.pace(ctx, c.raw.a.movingSpeed)} · ${F.dist(ctx, c.raw.a.dist)}${c.raw.a.hr ? ` · ${c.raw.a.hr} bpm` : ""}`,
        } } },
      },
    });
  }

  function renderVo2() {
    const cutoff = RC.iso(RC.daysAgo(rangeDays));
    const s = RC.vo2Series(ctx).filter((p) => p.date >= cutoff);
    if (s.length < 2) { $("vo2-legend").innerHTML = ""; return emptyChart("c-vo2", "Needs runs of 15+ minutes with heart rate in this period"); }
    legend("vo2-legend", [["Trend (6-week best efforts)", COLORS.blue], ["Single run", COLORS.neutral]]);
    draw("c-vo2", {
      type: "line",
      data: {
        datasets: [
          { label: "Trend", data: s.map((p) => ({ x: new Date(p.date).getTime(), y: p.value })), borderColor: COLORS.blue, backgroundColor: COLORS.blue, borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: "Single run", data: s.map((p) => ({ x: new Date(p.date).getTime(), y: p.raw })), showLine: false, backgroundColor: COLORS.neutral, borderColor: COLORS.surface, borderWidth: 2, pointRadius: 4 },
        ],
      },
      options: {
        interaction: { mode: "nearest", intersect: false, axis: "x" },
        scales: { x: xAxis({ type: "linear", ticks: { callback: (v) => shortDate(RC.iso(new Date(v))), maxTicksLimit: 6, maxRotation: 0 } }), y: axis({ title: { display: true, text: "ml/kg/min", color: COLORS.muted } }) },
        plugins: { tooltip: { callbacks: { title: (items) => shortDate(RC.iso(new Date(items[0].parsed.x))), label: (c) => ` ${c.dataset.label}: ${c.parsed.y}` } } },
      },
    });
  }

  function renderLoad() {
    const b = rangeDays <= 14 ? weekBuckets(28) : weekBuckets(rangeDays);
    const data = b.map((x) => Math.round(sum(ctx.acts.filter((a) => a.start >= x.from && a.start < x.to).map((a) => a.load))));
    if (!sum(data)) return emptyChart("c-load", "No training load in this period");
    draw("c-load", {
      type: "bar",
      data: { labels: b.map((x) => x.label), datasets: [{ label: "Load", data, backgroundColor: COLORS.blue, borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 34 }] },
      options: { scales: { x: xAxis(), y: axis({ beginAtZero: true }) }, plugins: { tooltip: { callbacks: { title: (i) => `Week of ${i[0].label}`, label: (c) => ` Load ${c.raw}` } } } },
    });
  }

  function dailyLine(id, dates, values, label, unit, extraDatasets = [], yOpts = {}) {
    if (values.filter((v) => v != null).length < 2) return emptyChart(id, `No ${label.toLowerCase()} data in this period`);
    draw(id, {
      type: "line",
      data: {
        labels: dates.map(shortDate),
        datasets: [
          { label, data: values, borderColor: COLORS.blue, backgroundColor: COLORS.blue, borderWidth: 2, pointRadius: dates.length > 40 ? 0 : 3, pointHoverRadius: 5, spanGaps: true, tension: 0.25 },
          ...extraDatasets,
        ],
      },
      options: {
        scales: { x: xAxis({ ticks: { maxTicksLimit: 7, maxRotation: 0 } }), y: axis(yOpts) },
        plugins: { tooltip: { filter: (i) => !i.dataset.band, callbacks: { label: (c) => c.raw != null ? ` ${label}: ${c.raw} ${unit}` : null } } },
      },
    });
  }

  function renderWellness() {
    const dates = RC.datesBack(Math.min(rangeDays, 180));

    dailyLine("c-rhr", dates, dates.map((d) => ctx.days[d]?.rhr ?? null), "Resting HR", "bpm");

    const hv = dates.map((d) => ctx.hrv[d] || null);
    dailyLine("c-hrv", dates, hv.map((h) => h?.last ?? null), "HRV", "ms", [
      { band: true, label: "Baseline high", data: hv.map((h) => h?.high ?? null), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: "rgba(124, 140, 255, 0.14)", spanGaps: true },
      { band: true, label: "Baseline low", data: hv.map((h) => h?.low ?? null), borderWidth: 0, pointRadius: 0, spanGaps: true },
    ]);

    const sl = dates.map((d) => ctx.sleep[d] || null);
    if (sl.filter(Boolean).length < 2) { $("sleep-legend").innerHTML = ""; emptyChart("c-sleep", "No sleep data in this period"); }
    else {
      const stages = [["deep", "Deep"], ["light", "Light"], ["rem", "REM"], ["awake", "Awake"]];
      legend("sleep-legend", stages.map(([k, l]) => [l, COLORS.sleep[k]]));
      draw("c-sleep", {
        type: "bar",
        data: {
          labels: dates.map(shortDate),
          datasets: stages.map(([k, l]) => ({
            label: l, data: sl.map((s) => (s ? +(s[k] / 3600).toFixed(2) : null)),
            backgroundColor: COLORS.sleep[k], borderColor: COLORS.surface, borderWidth: { top: 2 }, borderSkipped: "bottom", borderRadius: 3, maxBarThickness: 22,
          })),
        },
        options: {
          scales: { x: xAxis({ stacked: true, ticks: { maxTicksLimit: 7, maxRotation: 0 } }), y: axis({ stacked: true, beginAtZero: true, title: { display: true, text: "hours", color: COLORS.muted } }) },
          plugins: { tooltip: { callbacks: {
            label: (c) => c.raw != null ? ` ${c.dataset.label}: ${F.hours(c.raw * 3600)}` : null,
            footer: (items) => { const s = sl[items[0].dataIndex]; return s ? `Total ${F.hours(s.total)}${s.score != null ? ` · score ${s.score}` : ""}` : ""; },
          } } },
        },
      });
    }

    const st = dates.map((d) => ctx.days[d]?.steps ?? null);
    const goal = dates.map((d) => ctx.days[d]?.stepGoal ?? null);
    if (st.filter((v) => v != null).length < 2) { $("steps-legend").innerHTML = ""; emptyChart("c-steps", "No step data in this period"); }
    else {
      legend("steps-legend", [["Steps", COLORS.blue], ["Goal", COLORS.neutral]]);
      draw("c-steps", {
        type: "bar",
        data: {
          labels: dates.map(shortDate),
          datasets: [
            { type: "line", label: "Goal", data: goal, borderColor: COLORS.neutral, borderWidth: 2, pointRadius: 0, stepped: "middle", spanGaps: true },
            { label: "Steps", data: st, backgroundColor: COLORS.blue, borderRadius: 3, borderSkipped: "bottom", maxBarThickness: 22 },
          ],
        },
        options: { scales: { x: xAxis({ ticks: { maxTicksLimit: 7, maxRotation: 0 } }), y: axis({ beginAtZero: true }) }, plugins: { tooltip: { callbacks: { label: (c) => c.raw != null ? ` ${c.dataset.label}: ${Math.round(c.raw).toLocaleString()}` : null } } } },
      });
    }

    const bb = dates.map((d) => (ctx.days[d]?.bbMax != null ? [ctx.days[d].bbMin ?? 0, ctx.days[d].bbMax] : null));
    if (bb.filter(Boolean).length < 2) { $("bb-legend").innerHTML = ""; emptyChart("c-bb", "No Body Battery data in this period"); }
    else {
      legend("bb-legend", [["Daily low → high", COLORS.blue]]);
      draw("c-bb", {
        type: "bar",
        data: { labels: dates.map(shortDate), datasets: [{ label: "Body Battery", data: bb, backgroundColor: COLORS.blue, borderRadius: 4, borderSkipped: false, maxBarThickness: 18 }] },
        options: { scales: { x: xAxis({ ticks: { maxTicksLimit: 7, maxRotation: 0 } }), y: axis({ min: 0, max: 100 }) }, plugins: { tooltip: { callbacks: { label: (c) => c.raw ? ` Low ${c.raw[0]} · High ${c.raw[1]}` : null } } } },
      });
    }
  }

  function renderBest() {
    const efforts = RC.bestEfforts(ctx, Math.max(rangeDays, 90));
    $("best-sub").textContent = `Fastest time within any run, last ${Math.max(rangeDays, 90) >= 180 ? "6 months" : "90 days"}.`;
    $("best").innerHTML = `<tr><th>Distance</th><th class="num">Time</th><th class="num">Pace</th><th class="hide-sm">Run</th></tr>` +
      efforts.map((e) => e.best
        ? `<tr><td>${e.label}</td><td class="num">${F.duration(e.best.time)}</td><td class="num">${F.pace(ctx, e.dist / e.best.time)}</td><td class="hide-sm">${esc(e.best.act.name)} <span class="muted small">${shortDate(e.best.act.date)}</span></td></tr>`
        : `<tr><td>${e.label}</td><td class="num muted">—</td><td class="num muted">—</td><td class="hide-sm muted small">no run this long</td></tr>`).join("");
    const pred = RC.predictions(ctx, efforts);
    $("predict").innerHTML = pred.length
      ? `<tr><th>Race</th><th class="num">Predicted</th><th class="num">Pace</th><th class="hide-sm">Based on</th></tr>` + pred.map((p) => {
        const d = { "5 km": 5000, "10 km": 10000, Half: 21098, Marathon: 42195 }[p.label];
        return `<tr><td>${p.label}</td><td class="num">${F.duration(p.time)}</td><td class="num">${F.pace(ctx, d / p.time)}</td><td class="hide-sm muted small">best ${esc(p.from)}</td></tr>`;
      }).join("")
      : `<tr><td class="muted">Run at least 5 km to get predictions.</td></tr>`;
  }

  // ------------------------------------------------------------------ activities
  function renderFilters() {
    const counts = {};
    for (const a of ctx.acts) counts[a.type] = (counts[a.type] || 0) + 1;
    const opts = [["all", "All", null], ...["run", "trail", "walk", "hike", "other"].filter((t) => counts[t]).map((t) => [t, RC.TYPES[t].label, RC.TYPES[t].hex])];
    $("filters").innerHTML = opts.map(([k, l, c]) => `<button class="chip" data-f="${k}" aria-pressed="${actFilter === k}">${c ? `<i class="dot" style="background:${c}"></i>` : ""}${l} <span class="muted">${k === "all" ? ctx.acts.length : counts[k]}</span></button>`).join("") +
      `<input type="search" id="act-search" placeholder="Search name or place" value="${esc(actSearch)}">`;
    $("filters").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { actFilter = b.dataset.f; actShown = 25; renderFilters(); renderActs(); }));
    $("act-search").addEventListener("input", (e) => { actSearch = e.target.value; actShown = 25; renderActs(); });
  }

  function renderActs() {
    const q = actSearch.trim().toLowerCase();
    const list = ctx.acts.filter((a) => (actFilter === "all" || a.type === actFilter) && (!q || `${a.name} ${a.location || ""} ${a.typeKey}`.toLowerCase().includes(q)));
    const rows = list.slice(0, actShown).map((a) => {
      const t = RC.TYPES[a.type];
      return `<tr class="act" data-id="${a.id}" tabindex="0" aria-expanded="false">
        <td>${a.start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: a.start.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}</td>
        <td><div class="a-name"><i class="dot" style="background:${t.hex}"></i><span>${esc(a.name)} <small>${esc(t.label)}</small></span></div></td>
        <td class="num">${a.dist ? F.dist(ctx, a.dist, 2) : "—"}</td>
        <td class="num">${F.duration(a.dur)}</td>
        <td class="num hide-sm">${a.dist && a.type !== "other" ? F.pace(ctx, a.movingSpeed) : "—"}</td>
        <td class="num hide-sm">${a.hr ?? "—"}</td>
        <td class="num hide-sm">${a.elev ? F.elev(ctx, a.elev) : "—"}</td>
        <td class="num hide-sm">${a.load ? Math.round(a.load) : "—"}</td>
      </tr>`;
    }).join("");
    $("acts").innerHTML = `<tr><th>Date</th><th>Activity</th><th class="num">Distance</th><th class="num">Time</th><th class="num hide-sm">Pace</th><th class="num hide-sm">Avg HR</th><th class="num hide-sm">Climb</th><th class="num hide-sm">Load</th></tr>` +
      (rows || `<tr><td colspan="8" class="muted">No activities match.</td></tr>`);
    $("more").hidden = list.length <= actShown;
    $("acts").querySelectorAll("tr.act").forEach((tr) => {
      const toggle = () => toggleDetail(tr);
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  function splitTable(splits) {
    const NAMES = { RWD_RUN: "Running", RWD_WALK: "Walking", RWD_STAND: "Standing", INTERVAL_ACTIVE: "Active", INTERVAL_REST: "Rest", INTERVAL_WARMUP: "Warm-up", INTERVAL_COOLDOWN: "Cool-down", INTERVAL_RECOVERY: "Recovery" };
    const rw = splits.filter((s) => s.splitType && s.splitType.startsWith("RWD_"));
    const use = rw.length ? rw : splits.filter((s) => s.splitType && s.splitType !== "INTERVAL_ACTIVE");
    if (!use.length) return "";
    const tot = sum(use.map((s) => s.duration || 0));
    return `<h3 style="font-size:0.9rem;margin:14px 0 6px">${rw.length ? "Run / walk breakdown" : "Segments"}</h3>
      <table><tr><th>Type</th><th class="num">Count</th><th class="num">Time</th><th class="num">Share</th><th class="num">Distance</th><th class="num">Pace</th></tr>
      ${use.map((s) => `<tr><td>${NAMES[s.splitType] || esc(s.splitType)}</td><td class="num">${s.noOfSplits ?? "—"}</td><td class="num">${F.duration(s.duration)}</td><td class="num">${tot ? Math.round((s.duration / tot) * 100) + "%" : "—"}</td><td class="num">${s.distance ? F.dist(ctx, s.distance, 2) : "—"}</td><td class="num">${s.averageSpeed > 0.3 ? F.pace(ctx, s.averageSpeed) : "—"}</td></tr>`).join("")}
      </table>`;
  }

  async function toggleDetail(tr) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("detail")) { next.remove(); tr.setAttribute("aria-expanded", "false"); return; }
    const a = ctx.acts.find((x) => String(x.id) === tr.dataset.id);
    if (!a) return;
    tr.setAttribute("aria-expanded", "true");
    const ztot = sum(a.zones);
    const zbar = ztot ? `<div class="zbar">${a.zones.map((v, i) => v ? `<i title="Zone ${i + 1}: ${F.duration(v)}" style="width:${(v / ztot) * 100}%;background:${COLORS.zones[i]}"></i>` : "").join("")}</div>
      <div class="zlegend">${a.zones.map((v, i) => `<span><i class="dot" style="background:${COLORS.zones[i]}"></i> Z${i + 1} ${Math.round((v / ztot) * 100)}%</span>`).join("")}</div>` : "";
    const stat = (l, v) => (v != null && v !== "—" ? `<div>${l}<b>${v}</b></div>` : "");
    const row = document.createElement("tr");
    row.className = "detail";
    row.innerHTML = `<td colspan="8"><div class="detail-grid">
      <div><h3 style="font-size:0.95rem;margin-bottom:6px">Coach notes</h3><ul>${RC.activityNotes(ctx, a).map((n) => `<li>${esc(n)}</li>`).join("")}</ul><div class="split-slot">${splitTable(a.splits)}</div></div>
      <div><h3 style="font-size:0.95rem">Heart-rate zones</h3>${zbar || '<p class="muted small">No heart-rate data.</p>'}
        <div class="stats">
          ${stat("Avg / max HR", a.hr ? `${a.hr} / ${a.maxHr ?? "—"}` : null)}
          ${stat("Cadence", a.cad ? `${Math.round(a.cad)} spm` : null)}
          ${stat("Stride", a.stride ? `${(a.stride / 100).toFixed(2)} m` : null)}
          ${stat("Ground contact", a.gct ? `${Math.round(a.gct)} ms` : null)}
          ${stat("Vert. oscillation", a.vo ? `${a.vo.toFixed(1)} cm` : null)}
          ${stat("Power", a.power ? `${Math.round(a.power)} W` : null)}
          ${stat("Calories", a.calories ? Math.round(a.calories) : null)}
          ${stat("Steps", a.steps ? a.steps.toLocaleString() : null)}
          <span class="extra"></span>
        </div></div>
    </div></td>`;
    tr.after(row);

    try {
      const d = await RC.api.get(`/activity-service/activity/${a.id}`);
      const s = d?.summaryDTO || {};
      const extra = [
        stat("Recovery HR",s.recoveryHeartRate ? `${s.recoveryHeartRate} bpm` : null),
        stat("Perceived effort", s.directWorkoutRpe ? `${s.directWorkoutRpe / 10}/10` : null),
        stat("Feel", s.directWorkoutFeel != null ? ["Very weak", "Weak", "Normal", "Strong", "Very strong"][Math.round(s.directWorkoutFeel / 25)] : null),
        stat("Stamina used", s.beginPotentialStamina != null && s.endPotentialStamina != null ? `${Math.round(s.beginPotentialStamina - s.endPotentialStamina)}%` : null),
      ].join("");
      row.querySelector(".extra").outerHTML = extra;
      if (!a.splits.length && d?.splitSummaries?.length) row.querySelector(".split-slot").innerHTML = splitTable(d.splitSummaries);
    } catch { /* detail is optional */ }
  }

  // ------------------------------------------------------------------ render all
  function renderAll() {
    document.querySelectorAll("#range button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.days) === rangeDays)));
    const ready = renderReadiness();
    renderKpis();
    renderInsights();
    renderPlan(ready);
    renderDistance();
    renderZones();
    renderPace();
    renderVo2();
    renderLoad();
    renderWellness();
    renderBest();
    renderFilters();
    renderActs();
  }

  async function start() {
    $("loading").hidden = false;
    $("app").hidden = true;
    $("warnings").innerHTML = "";
    try {
      const session = await RC.api.session();
      const { raw, failed } = await loadAll();
      ctx = RC.normalize(raw);
      const name = ctx.name || session.displayName || "";
      $("who").innerHTML = RC.isDemo ? `<span class="demo-badge">DEMO DATA</span>` : name && !/^[0-9a-f-]{36}$/.test(name) ? `Hi, <strong>${esc(name.split(" ")[0])}</strong>` : "";
      if (failed.length) $("warnings").innerHTML = `<div class="alert info">Garmin didn't return: ${esc(failed.join(", "))}. Those parts are empty.</div>`;
      $("loading").hidden = true;
      $("app").hidden = false;
      renderAll();
    } catch (e) {
      if (e.status === 401) { location.replace("index.html"); return; }
      $("loading").innerHTML = `<div class="alert error" style="max-width:560px;margin:0 auto;text-align:left">Couldn't load your data: ${esc(e.message)}. <a style="color:var(--accent)" href="index.html">Reconnect</a></div>`;
    }
  }

  // ------------------------------------------------------------------ events
  $("range").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !ctx) return;
    rangeDays = Number(b.dataset.days);
    try { localStorage.setItem("rc-range", String(rangeDays)); } catch { /* storage blocked */ }
    renderAll();
  });
  $("more").addEventListener("click", () => { actShown += 25; renderActs(); });
  $("refresh").addEventListener("click", start);
  $("logout").addEventListener("click", async () => {
    try { await RC.api.disconnect(); } catch { /* already gone */ }
    location.href = "index.html";
  });
  if (RC.isDemo) $("logout").textContent = "Exit demo";

  start();
})();
