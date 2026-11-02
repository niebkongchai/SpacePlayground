// Turns raw Garmin responses into tidy records, then derives readiness, recovery, a VO2max
// estimate, coaching insights and a 7-day plan. Pure functions: no DOM, no fetching.
(() => {
  const RC = (window.RC = window.RC || {});

  // ------------------------------------------------------------------ types
  const TYPE_OF = {
    running: "run", street_running: "run", track_running: "run", treadmill_running: "run",
    indoor_running: "run", virtual_run: "run", obstacle_run: "run", ultra_run: "run",
    trail_running: "trail",
    walking: "walk", casual_walking: "walk", speed_walking: "walk", indoor_walking: "walk",
    hiking: "hike", mountaineering: "hike", rucking: "hike",
  };
  RC.TYPES = {
    run: { label: "Run", color: "var(--run)", hex: "#3987e5" },
    trail: { label: "Trail run", color: "var(--trail)", hex: "#d95926" },
    walk: { label: "Walk", color: "var(--walk)", hex: "#199e70" },
    hike: { label: "Hike / trek", color: "var(--hike)", hex: "#c98500" },
    other: { label: "Other", color: "var(--other)", hex: "#8a8fb3" },
  };
  const isRunning = (a) => a.type === "run" || a.type === "trail";

  // ------------------------------------------------------------------ helpers
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
  const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? sum(v) / v.length : null; };
  const median = (arr) => {
    const v = arr.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const parseLocal = (s) => {
    // "2026-11-01 17:45:55" or "2026-11-01T17:45:55.0" -> local Date
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  };
  RC.util = { num, sum, avg, median, clamp };

  // ------------------------------------------------------------------ normalize
  RC.normalize = function normalize(raw) {
    const zonesList = Array.isArray(raw.zones) ? raw.zones : [];
    const z = zonesList.find((x) => x.sport === "RUNNING") || zonesList.find((x) => x.sport === "DEFAULT") || zonesList[0] || {};

    const acts = (raw.activities || []).map((a) => {
      const start = parseLocal(a.startTimeLocal);
      const typeKey = a.activityType?.typeKey || "other";
      const dist = num(a.distance) || 0;
      const moving = num(a.movingDuration) || num(a.duration) || 0;
      // Run/walk detection splits the activity into running and walking parts.
      const splits = Array.isArray(a.splitSummaries) ? a.splitSummaries : [];
      const rwRun = splits.find((s) => s.splitType === "RWD_RUN");
      const rwWalk = splits.find((s) => s.splitType === "RWD_WALK");
      const rwTime = (rwRun?.duration || 0) + (rwWalk?.duration || 0);
      return {
        id: a.activityId,
        name: a.activityName || typeKey,
        typeKey,
        type: TYPE_OF[typeKey] || "other",
        start,
        date: start ? RC.iso(start) : (a.startTimeLocal || "").slice(0, 10),
        dist,
        dur: num(a.duration) || 0,
        moving,
        speed: num(a.averageSpeed),
        movingSpeed: dist && moving ? dist / moving : num(a.averageSpeed),
        gap: num(a.avgGradeAdjustedSpeed),
        hr: num(a.averageHR),
        maxHr: num(a.maxHR),
        cad: num(a.averageRunningCadenceInStepsPerMinute),
        elev: num(a.elevationGain) || 0,
        load: num(a.activityTrainingLoad) || 0,
        aTE: num(a.aerobicTrainingEffect) || 0,
        anTE: num(a.anaerobicTrainingEffect) || 0,
        teLabel: a.trainingEffectLabel || null,
        zones: [1, 2, 3, 4, 5].map((i) => num(a["hrTimeInZone_" + i]) || 0),
        best: {
          1000: num(a.fastestSplit_1000), 5000: num(a.fastestSplit_5000), 10000: num(a.fastestSplit_10000),
          21098: num(a.fastestSplit_21098), 42195: num(a.fastestSplit_42195),
        },
        calories: num(a.calories),
        steps: num(a.steps),
        power: num(a.avgPower),
        gct: num(a.avgGroundContactTime),
        vo: num(a.avgVerticalOscillation),
        stride: num(a.avgStrideLength),
        location: a.locationName || null,
        owner: a.ownerFullName || null,
        splits,
        runCad: num(rwRun?.avgStepFrequency),
        runSpeed: num(rwRun?.averageSpeed),
        walkShare: rwTime ? (rwWalk?.duration || 0) / rwTime : 0,
      };
    }).filter((a) => a.start).sort((a, b) => b.start - a.start);

    const days = {};
    for (const d of raw.dailySummaries || []) {
      days[d.calendarDate] = {
        rhr: num(d.heartRate?.restingValue),
        steps: num(d.movement?.steps?.value),
        stepGoal: num(d.movement?.steps?.goal),
        bbMax: num(d.bodyBattery?.maxValue),
        bbMin: num(d.bodyBattery?.minValue),
        stress: num(d.stress?.avgLevel),
        imMod: num(d.intensityMinutes?.moderate),
        imVig: num(d.intensityMinutes?.vigorous),
        imGoal: num(d.intensityMinutes?.goal),
      };
    }

    const sleep = {};
    for (const s of raw.sleep || []) {
      if (!s || !s.calendarDate || !s.sleepTimeSeconds) continue;
      sleep[s.calendarDate] = {
        total: s.sleepTimeSeconds,
        deep: s.deepSleepSeconds || 0,
        light: s.lightSleepSeconds || 0,
        rem: s.remSleepSeconds || 0,
        awake: s.awakeSleepSeconds || 0,
        score: num(s.sleepScores?.overall?.value),
        quality: s.sleepScores?.overall?.qualifierKey || null,
        avgHr: num(s.avgHeartRate),
        stress: num(s.avgSleepStress),
        needMin: num(s.sleepNeed?.actual),
      };
    }

    const hrv = {};
    for (const h of raw.hrv || []) {
      if (!h || !h.calendarDate) continue;
      hrv[h.calendarDate] = {
        last: num(h.lastNightAvg), weekly: num(h.weeklyAvg), status: h.status || null,
        low: num(h.baseline?.balancedLow), high: num(h.baseline?.balancedUpper),
      };
    }

    const fa = Array.isArray(raw.fitnessAge) ? raw.fitnessAge[0] : raw.fitnessAge;
    const name = acts.find((a) => a.owner)?.owner || null;

    return {
      profile: raw.profile || {},
      imperial: (raw.profile?.measurementSystem || "metric") !== "metric",
      zones: {
        rest: num(z.restingHeartRateUsed), max: num(z.maxHeartRateUsed),
        floors: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor].map(num),
        method: z.trainingMethod || null,
      },
      acts, days, sleep, hrv,
      fitnessAge: fa && fa.fitnessAge ? fa : null,
      name,
    };
  };

  // ------------------------------------------------------------------ windows
  function datesBack(n, endDate = new Date()) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) { const d = new Date(endDate); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); out.push(RC.iso(d)); }
    return out;
  }
  RC.datesBack = datesBack;

  function actsWithin(ctx, days, offset = 0) {
    const to = Date.now() - offset * 864e5;
    const from = to - days * 864e5;
    return ctx.acts.filter((a) => a.start.getTime() > from && a.start.getTime() <= to);
  }
  RC.actsWithin = actsWithin;

  // ------------------------------------------------------------------ load & recovery
  RC.loadStatus = function loadStatus(ctx) {
    const acute = sum(actsWithin(ctx, 7).map((a) => a.load));
    const chronic = sum(actsWithin(ctx, 28).map((a) => a.load)) / 4;
    const ratio = chronic > 0 ? acute / chronic : null;
    let zone = "unknown";
    if (ratio != null) zone = ratio < 0.8 ? "low" : ratio <= 1.3 ? "optimal" : ratio <= 1.5 ? "high" : "very-high";
    return { acute: Math.round(acute), chronic: Math.round(chronic), ratio, zone };
  };

  function recoveryHoursFor(a) {
    const te = a.aTE + 0.5 * a.anTE;
    const base = te < 1.5 ? 4 : te < 2.5 ? 12 : te < 3.5 ? 24 : te < 4.2 ? 40 : 56;
    return base * (0.7 + 0.3 * clamp(a.load / 100, 0.3, 2));
  }
  RC.recoveryHoursFor = recoveryHoursFor;

  RC.recovery = function recovery(ctx, penalty = 1) {
    const now = Date.now();
    let worst = 0, extra = 0;
    for (const a of actsWithin(ctx, 4)) {
      const end = a.start.getTime() + (a.dur || 0) * 1000;
      const left = recoveryHoursFor(a) * penalty - (now - end) / 36e5;
      if (left <= 0) continue;
      if (left > worst) { extra += worst * 0.3; worst = left; } else extra += left * 0.3;
    }
    const hours = Math.round(worst + extra);
    return { hours, readyAt: hours > 0 ? new Date(now + hours * 36e5) : null };
  };

  // ------------------------------------------------------------------ readiness
  function latestKey(obj, maxAgeDays = 2) {
    const keys = Object.keys(obj).sort();
    const k = keys[keys.length - 1];
    if (!k) return null;
    return (Date.now() - new Date(k + "T12:00:00").getTime()) / 864e5 <= maxAgeDays ? k : null;
  }

  RC.readiness = function readiness(ctx) {
    const parts = [];
    const today = RC.iso(new Date());

    const sk = latestKey(ctx.sleep);
    const s = sk && ctx.sleep[sk];
    if (s && s.score != null) {
      parts.push({ key: "sleep", label: "Sleep score", value: `${s.score}`, score: s.score, weight: 0.25,
        note: `${fmtHours(s.total)} asleep${s.quality ? " · " + s.quality.toLowerCase() : ""}` });
    }

    const hk = latestKey(ctx.hrv);
    const h = hk && ctx.hrv[hk];
    if (h && h.status) {
      let sc = { BALANCED: 85, UNBALANCED: 55, LOW: 35, POOR: 25 }[h.status] ?? 60;
      if (h.last != null && h.low != null) sc += h.last >= h.low ? 5 : -10;
      parts.push({ key: "hrv", label: "HRV", value: h.last != null ? `${h.last} ms` : h.status.toLowerCase(), score: clamp(sc, 0, 100), weight: 0.25,
        note: `${h.status.toLowerCase()}${h.low != null ? ` · baseline ${h.low}–${h.high} ms` : ""}` });
    }

    const rhrDays = datesBack(8).map((d) => ctx.days[d]?.rhr).filter((v) => v != null);
    const rhrToday = ctx.days[today]?.rhr ?? ctx.days[RC.iso(RC.daysAgo(1))]?.rhr ?? null;
    if (rhrToday != null && rhrDays.length >= 4) {
      const base = avg(rhrDays.slice(0, -1));
      const diff = rhrToday - base;
      const sc = diff <= 0 ? 90 : diff <= 2 ? 75 : diff <= 4 ? 55 : 30;
      parts.push({ key: "rhr", label: "Resting HR", value: `${rhrToday} bpm`, score: sc, weight: 0.15,
        note: `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} vs your 7-day average` });
    }

    const bb = ctx.days[today]?.bbMax ?? null;
    if (bb != null) {
      parts.push({ key: "bb", label: "Body Battery peak", value: `${bb}`, score: bb, weight: 0.15, note: "highest today so far" });
    }

    const load = RC.loadStatus(ctx);
    const penalty = (s && s.score != null && s.score < 60) || (h && h.status && h.status !== "BALANCED") ? 1.2 : 1;
    const rec = RC.recovery(ctx, penalty);
    if (load.ratio != null || rec.hours > 0) {
      const acwrScore = load.ratio == null ? 80 : { low: 90, optimal: 85, high: 55, "very-high": 30 }[load.zone];
      const recScore = clamp(100 - rec.hours * 2, 0, 100);
      parts.push({ key: "load", label: "Training load", value: load.ratio != null ? `${load.ratio.toFixed(2)}×` : "—", score: Math.min(acwrScore, recScore), weight: 0.2,
        note: load.ratio != null ? `last 7 days vs 4-week average (${load.acute} / ${load.chronic})` : "not enough history" });
    }

    const w = sum(parts.map((p) => p.weight));
    const score = w ? Math.round(sum(parts.map((p) => p.score * p.weight)) / w) : null;
    const level = score == null ? "unknown" : score >= 70 ? "good" : score >= 45 ? "warn" : "bad";
    const headline = score == null ? "Not enough recent data"
      : score >= 75 ? "Ready to train hard"
      : score >= 60 ? "Good for a normal session"
      : score >= 45 ? "Keep it easy today"
      : "Rest or recovery walk today";
    return { score, level, headline, parts, recovery: rec, load };
  };

  // ------------------------------------------------------------------ VO2max estimate
  // Garmin's own VO2max isn't in the Personal API. Estimate per run from pace vs heart rate:
  // ACSM running VO2 = 3.5 + 0.2 × speed (m/min), and %VO2 reserve ≈ %HR reserve.
  RC.vo2Estimate = function vo2Estimate(ctx, a) {
    // Walk breaks lower average HR more than pace, which skews the estimate, so skip run/walk sessions.
    if (!isRunning(a) || a.moving < 15 * 60 || !a.hr || a.walkShare > 0.2) return null;
    const rest = ctx.zones.rest || 55, max = ctx.zones.max || 190;
    const hrr = (a.hr - rest) / (max - rest);
    if (hrr < 0.55 || hrr > 0.97) return null;
    const v = (a.gap || a.movingSpeed || a.speed) * 60;
    if (!v) return null;
    const vo2 = 3.5 + 0.2 * v;
    return Math.round((3.5 + (vo2 - 3.5) / hrr) * 10) / 10;
  };

  RC.vo2Series = function vo2Series(ctx) {
    const pts = ctx.acts.map((a) => ({ date: a.date, value: RC.vo2Estimate(ctx, a) })).filter((p) => p.value).reverse();
    // Rolling "best recent efforts": 75th percentile of the last 6 weeks, per run date.
    return pts.map((p, i) => {
      const t = new Date(p.date).getTime();
      const win = pts.slice(0, i + 1).filter((q) => t - new Date(q.date).getTime() <= 42 * 864e5).map((q) => q.value).sort((a, b) => a - b);
      return { date: p.date, raw: p.value, value: Math.round(win[Math.round((win.length - 1) * 0.75)] * 10) / 10 };
    });
  };

  // ------------------------------------------------------------------ formatting
  function fmtHours(sec) {
    const m = Math.round(sec / 60);
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }
  RC.fmt = {
    hours: fmtHours,
    duration(sec) {
      sec = Math.round(sec || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
    },
    dist(ctx, m, digits = 1) {
      return ctx.imperial ? `${(m / 1609.344).toFixed(digits)} mi` : `${(m / 1000).toFixed(digits)} km`;
    },
    distNum(ctx, m) { return ctx.imperial ? m / 1609.344 : m / 1000; },
    distUnit(ctx) { return ctx.imperial ? "mi" : "km"; },
    // seconds per km (or mile) from m/s
    paceSec(ctx, speed) { return speed ? (ctx.imperial ? 1609.344 : 1000) / speed : null; },
    pace(ctx, speed) {
      const s = RC.fmt.paceSec(ctx, speed);
      if (!s || s > 3600) return "—";
      return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")} /${ctx.imperial ? "mi" : "km"}`;
    },
    paceFromSec(ctx, s) {
      if (!s) return "—";
      return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
    },
    elev(ctx, m) { return ctx.imperial ? `${Math.round(m * 3.281)} ft` : `${Math.round(m)} m`; },
    teLabel(l) { return l ? l.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "—"; },
  };

  // ------------------------------------------------------------------ insights
  RC.insights = function insights(ctx, rangeDays) {
    const out = [];
    const F = RC.fmt;
    const acts = actsWithin(ctx, rangeDays);
    const runs = acts.filter(isRunning);
    const z2top = ctx.zones.floors[2];

    // 1. Intensity balance (80/20)
    const zt = [0, 1, 2, 3, 4].map((i) => sum(runs.map((a) => a.zones[i])));
    const ztot = sum(zt);
    if (ztot > 1800) {
      const easy = (zt[0] + zt[1]) / ztot, hard = (zt[3] + zt[4]) / ztot;
      const pct = (v) => Math.round(v * 100) + "%";
      if (easy >= 0.75) out.push({ level: "good", title: "Easy/hard balance is on target", text: `${pct(easy)} of your running time was in zones 1–2. That's close to the 80/20 split most coaches use for building endurance.` });
      else out.push({ level: easy < 0.55 ? "bad" : "warn", title: "Your easy runs are too fast", text: `Only ${pct(easy)} of running time was in zones 1–2, and ${pct(zt[2] / ztot)} was in zone 3. Aim for about 80% easy: keep easy runs below ${z2top ? z2top + " bpm" : "zone 3"}, even if that means slowing down or walking uphill. Save zones 4–5 (${pct(hard)} now) for one session a week.` });
    }

    // 2. Volume and ramp
    const weeks = [0, 1, 2, 3].map((w) => sum(actsWithin(ctx, 7, w * 7).filter(isRunning).map((a) => a.dist)));
    const prevAvg = avg(weeks.slice(1));
    if (prevAvg > 0) {
      const change = weeks[0] / prevAvg - 1;
      if (change > 0.3) out.push({ level: "warn", title: "Mileage jumped this week", text: `${F.dist(ctx, weeks[0])} in the last 7 days, ${Math.round(change * 100)}% more than your previous 3-week average (${F.dist(ctx, prevAvg)}). Raise weekly distance by about 10% at a time to avoid shin, calf and knee problems.` });
      else if (weeks[0] < prevAvg * 0.5 && prevAvg > 5000) out.push({ level: "info", title: "Light week", text: `${F.dist(ctx, weeks[0])} this week vs your usual ${F.dist(ctx, prevAvg)}. Fine as a recovery week; when you return, start around ${F.dist(ctx, prevAvg * 0.8)} rather than jumping back to full volume.` });
      else out.push({ level: "good", title: "Steady weekly volume", text: `${F.dist(ctx, weeks[0])} in the last 7 days, close to your 3-week average of ${F.dist(ctx, prevAvg)}. Steady volume is what builds aerobic fitness.` });
    }

    // 3. Load ratio
    const load = RC.loadStatus(ctx);
    if (load.ratio != null) {
      if (load.zone === "very-high" || load.zone === "high") out.push({ level: load.zone === "very-high" ? "bad" : "warn", title: "Training load is spiking", text: `Your last-7-day load is ${load.ratio.toFixed(2)}× your 4-week average. Above 1.3× injury risk rises; take 1–2 easy or rest days before the next hard session.` });
      else if (load.zone === "low") out.push({ level: "info", title: "Load is below your usual", text: `This week's load is ${load.ratio.toFixed(2)}× your 4-week average. You're fresh, so it's a good time for a quality session or a longer run.` });
    }

    // 4. Consistency
    const perWeek = runs.length / (rangeDays / 7);
    if (rangeDays >= 14 && runs.length) {
      if (perWeek < 2) out.push({ level: "info", title: "Run more often, not longer", text: `About ${perWeek.toFixed(1)} runs a week. Going to 3 shorter runs builds fitness faster than 1–2 long ones and is easier on your legs.` });
      else out.push({ level: "good", title: `${perWeek.toFixed(1)} runs a week`, text: "Consistent frequency, which is the most important habit for improving." });
    }

    // 5. Long run share
    if (runs.length >= 3 && rangeDays >= 14 && perWeek >= 2) {
      const longest = Math.max(...runs.map((a) => a.dist));
      const weekly = sum(runs.map((a) => a.dist)) / (rangeDays / 7);
      if (weekly > 0 && longest / weekly > 0.45) out.push({ level: "warn", title: "Long run is a big share of your week", text: `Your longest run (${F.dist(ctx, longest)}) is ${Math.round(longest / weekly * 100)}% of your weekly average. Keep it under about 35% by adding easy kilometres on other days.` });
    }

    // 6. Cadence and run/walk
    // Uses the running-only part of run/walk sessions when Garmin splits them.
    const cadRuns = runs.filter((a) => (a.runCad || a.cad) && a.type === "run" && a.moving > 600);
    if (cadRuns.length >= 2) {
      const cad = sum(cadRuns.map((a) => (a.runCad || a.cad) * a.moving)) / sum(cadRuns.map((a) => a.moving));
      const walkShare = sum(cadRuns.map((a) => a.walkShare * a.moving)) / sum(cadRuns.map((a) => a.moving));
      const walkNote = walkShare > 0.05 ? ` You also walked about ${Math.round(walkShare * 100)}% of run time, which is fine for building up. Shrink the walk breaks gradually.` : "";
      if (cad < 165) out.push({ level: "info", title: `Running cadence ${Math.round(cad)} spm`, text: `Try quicker, shorter steps, about 5% more (${Math.round(cad * 1.05)} spm). That lowers impact on knees and shins. A metronome or music at that tempo helps.${walkNote}` });
      else out.push({ level: "good", title: `Running cadence ${Math.round(cad)} spm`, text: `Quick, efficient stride rate. Keep it.${walkNote}` });
    }

    // 7. Sleep
    const sleepDays = datesBack(Math.min(rangeDays, 90)).map((d) => ctx.sleep[d]).filter(Boolean);
    if (sleepDays.length >= 3) {
      const h = avg(sleepDays.map((s) => s.total)) / 3600;
      const sc = avg(sleepDays.map((s) => s.score));
      if (h < 7) out.push({ level: h < 6.3 ? "bad" : "warn", title: `Sleeping ${h.toFixed(1)} h a night`, text: `Your training adapts while you sleep. Under 7 hours slows recovery and raises injury risk. Even 30 minutes earlier to bed, especially before long or hard days, will help${sc ? ` (average sleep score ${Math.round(sc)})` : ""}.` });
      else out.push({ level: "good", title: `Sleeping ${h.toFixed(1)} h a night`, text: `Enough sleep to absorb training${sc ? `, average score ${Math.round(sc)}` : ""}.` });
    }

    // 8. HRV
    const hrvWeek = datesBack(7).map((d) => ctx.hrv[d]).filter((h) => h && h.status);
    const offDays = hrvWeek.filter((h) => h.status !== "BALANCED").length;
    if (hrvWeek.length >= 4) {
      if (offDays >= 3) out.push({ level: "warn", title: "HRV out of balance", text: `${offDays} of the last ${hrvWeek.length} nights were outside your HRV baseline. That points to accumulated stress from training, work, illness, alcohol or heat. Swap intensity for easy runs until it settles.` });
      else out.push({ level: "good", title: "HRV is balanced", text: "Your nervous system is coping well with your current training." });
    }

    // 9. Resting HR trend
    const r7 = avg(datesBack(7).map((d) => ctx.days[d]?.rhr));
    const r28 = avg(datesBack(35).slice(0, 28).map((d) => ctx.days[d]?.rhr));
    if (r7 && r28 && r7 - r28 >= 3) out.push({ level: "warn", title: "Resting heart rate is up", text: `${r7.toFixed(0)} bpm this week vs ${r28.toFixed(0)} bpm normally. A rise of 3+ bpm often comes before getting sick or overreaching, so go easy for a few days.` });
    else if (r7 && r28 && r28 - r7 >= 2) out.push({ level: "good", title: "Resting heart rate is falling", text: `${r7.toFixed(0)} bpm vs ${r28.toFixed(0)} bpm before. A sign your aerobic fitness is improving.` });

    // 10. Stress
    const st = avg(datesBack(Math.min(rangeDays, 30)).map((d) => ctx.days[d]?.stress));
    if (st && st >= 45) out.push({ level: "warn", title: `High all-day stress (avg ${Math.round(st)})`, text: "Garmin measures high stress most of the day. Heat, poor sleep, caffeine and work stress all count, and they use up the same recovery as training. On high-stress days, run easy and keep it short." });

    // 11. Fitness age
    const fa = ctx.fitnessAge;
    if (fa) {
      const comp = Object.entries(fa.components || {}).filter(([, c]) => c && c.priority).sort((a, b) => a[1].priority - b[1].priority)[0];
      const what = comp && {
        vigorousMinutesAvg: `average ${comp[1].targetValue} vigorous minutes a week (now ${comp[1].value})`,
        vigorousDaysAvg: `get vigorous activity on ${comp[1].targetValue} days a week (now ${comp[1].value})`,
        bmi: `bring BMI toward ${comp[1].targetValue} (now ${comp[1].value})`,
        rhr: `lower resting heart rate`,
      }[comp[0]];
      out.push({ level: fa.fitnessAge < fa.chronologicalAge ? "good" : "info", title: `Fitness age ${fa.fitnessAge.toFixed(1)} (actual ${fa.chronologicalAge})`, text: `Garmin says you could reach ${fa.achievableFitnessAge?.toFixed(1) ?? "a younger age"}${what ? `. Biggest lever: ${what}` : ""}.` });
    }

    // 12. Trail / hike climbing
    const climb = acts.filter((a) => a.type === "trail" || a.type === "hike");
    if (climb.length) {
      const gain = sum(climb.map((a) => a.elev));
      out.push({ level: "info", title: `${F.elev(ctx, gain)} climbed on trails and hikes`, text: `${climb.length} trail/hike outings in this period. On trail runs, judge effort by heart rate rather than pace, and power-hike climbs steeper than about 15%. That's what trail racers do too.` });
    }

    const rank = { bad: 0, warn: 1, info: 2, good: 3 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  };

  // ------------------------------------------------------------------ activity notes
  RC.activityNotes = function activityNotes(ctx, a) {
    const F = RC.fmt;
    const notes = [];
    const ztot = sum(a.zones);
    if (ztot > 60) {
      const easy = (a.zones[0] + a.zones[1]) / ztot, z3 = a.zones[2] / ztot, hard = (a.zones[3] + a.zones[4]) / ztot;
      if (hard > 0.3) notes.push(`Hard effort: ${Math.round(hard * 100)}% of the time in zones 4–5. Follow it with 1–2 easy days.`);
      else if (z3 > 0.4) notes.push(`Mostly zone 3 (${Math.round(z3 * 100)}%). Moderate-hard, a "grey zone" run. If this was meant to be easy, slow down to stay below ${ctx.zones.floors[2] || "zone 3"} bpm.`);
      else if (easy > 0.7) notes.push(`Easy aerobic run: ${Math.round(easy * 100)}% in zones 1–2. Good base building.`);
    }
    if (isRunning(a)) {
      const same = ctx.acts.filter((x) => x.type === a.type && x.id !== a.id && x.moving > 600).slice(0, 30);
      const med = median(same.map((x) => x.movingSpeed));
      if (med && a.movingSpeed) {
        const diff = F.paceSec(ctx, a.movingSpeed) - F.paceSec(ctx, med);
        if (Math.abs(diff) >= 8) notes.push(`Pace ${F.pace(ctx, a.movingSpeed)}, ${Math.round(Math.abs(diff))} s/${F.distUnit(ctx)} ${diff < 0 ? "faster" : "slower"} than your typical ${RC.TYPES[a.type].label.toLowerCase()}.`);
      }
      if (a.walkShare > 0.05) notes.push(`Run/walk: ${Math.round(a.walkShare * 100)}% of the time walking${a.runSpeed ? `; running parts at ${F.pace(ctx, a.runSpeed)}` : ""}.`);
      const cad = a.runCad || a.cad;
      if (cad && a.type === "run" && cad < 160) notes.push(`Running cadence ${Math.round(cad)} spm. Shorter, quicker steps reduce impact.`);
      const vo2 = RC.vo2Estimate(ctx, a);
      if (vo2) notes.push(`Estimated VO2max from this run: ${vo2} ml/kg/min.`);
    }
    if ((a.type === "trail" || a.type === "hike") && a.dist > 0) notes.push(`${F.elev(ctx, a.elev)} climbed (${F.elev(ctx, a.elev / (a.dist / 1000))}/km).`);
    if (a.teLabel) notes.push(`Garmin training effect: ${F.teLabel(a.teLabel)} (aerobic ${a.aTE.toFixed(1)}, anaerobic ${a.anTE.toFixed(1)}).`);
    const rh = recoveryHoursFor(a);
    notes.push(`Estimated recovery after this: about ${Math.round(rh)} h.`);
    return notes;
  };

  // ------------------------------------------------------------------ best efforts
  RC.bestEfforts = function bestEfforts(ctx, rangeDays) {
    const acts = actsWithin(ctx, rangeDays).filter(isRunning);
    const dists = [[1000, "1 km"], [5000, "5 km"], [10000, "10 km"], [21098, "Half marathon"], [42195, "Marathon"]];
    return dists.map(([d, label]) => {
      let best = null;
      for (const a of acts) { const t = a.best[d]; if (t && (!best || t < best.time)) best = { time: t, act: a }; }
      return { dist: d, label, best };
    });
  };

  // Riegel: T2 = T1 × (D2/D1)^1.06, from the best effort closest to each target distance.
  RC.predictions = function predictions(ctx, efforts) {
    const known = efforts.filter((e) => e.best && e.dist >= 5000);
    if (!known.length) return [];
    return [[5000, "5 km"], [10000, "10 km"], [21098, "Half"], [42195, "Marathon"]].map(([d, label]) => {
      const src = known.slice().sort((a, b) => Math.abs(Math.log(a.dist / d)) - Math.abs(Math.log(b.dist / d)))[0];
      return { label, time: src.best.time * Math.pow(d / src.dist, 1.06), from: src.label };
    });
  };

  // ------------------------------------------------------------------ 7-day plan
  const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  RC.weekPlan = function weekPlan(ctx, ready) {
    const F = RC.fmt;
    const recent = actsWithin(ctx, 28).filter(isRunning);
    const recent12 = actsWithin(ctx, 84).filter(isRunning);
    const weeklyKm = sum(recent.map((a) => a.dist)) / 4 / 1000;
    // Use the 12-week habit too, so one quiet month doesn't shrink the plan to nothing.
    const baseKm = Math.max(weeklyKm, (sum(recent12.map((a) => a.dist)) / 12 / 1000) * 0.8);
    const runsPerWeek = Math.max(recent.length / 4, recent12.length / 12);
    const longest = recent12.length ? Math.max(...recent12.map((a) => a.dist)) / 1000 : 5;

    let factor = 1.08;
    if (ready.load.zone === "high" || ready.load.zone === "very-high") factor = 0.9;
    else if (ready.score != null && ready.score < 50) factor = 0.95;
    const targetKm = Math.max(6, baseKm * factor);
    const nRuns = clamp(Math.round(runsPerWeek) + (runsPerWeek < 3 ? 1 : 0), 2, 5);

    const zones = recent.reduce((acc, a) => acc.map((v, i) => v + a.zones[i]), [0, 0, 0, 0, 0]);
    const easyShare = sum(zones) ? (zones[0] + zones[1]) / sum(zones) : 0.8;
    const wantQuality = ready.score == null || ready.score >= 55;

    const z3 = ctx.zones.floors[2], z4 = ctx.zones.floors[3], z2 = ctx.zones.floors[1];
    // Easy pace from steady runs (few walk breaks) that stayed under zone 3. If none, use typical run pace + 45 s.
    const steady = recent12.filter((a) => a.walkShare <= 0.1 && a.moving > 900);
    const pace = (a) => F.paceSec(ctx, a.runSpeed || a.movingSpeed);
    const easyRuns = steady.filter((a) => a.hr && z3 && a.hr < z3);
    const typical = median(steady.map(pace)) || median(recent12.map(pace));
    const easyPace = median(easyRuns.map(pace)) || (typical ? typical + 45 : null);
    const easyTarget = z3
      ? `HR ${z2 || ""}–${z3 - 1} bpm (zone 2)${easyPace ? `, around ${F.paceFromSec(ctx, easyPace)}/${F.distUnit(ctx)}. Slow down or walk if HR climbs` : ""}`
      : "conversational effort";

    const avail = (ctx.profile.availableTrainingDays || []).map((d) => d.toLowerCase());
    const longPref = (ctx.profile.preferredLongTrainingDays || [])[0]?.toLowerCase() || "sunday";
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const dow = DOW[d.getDay()];
      days.push({ date: d, dow, available: !avail.length || avail.includes(dow), session: null });
    }

    const recDays = ready.recovery.hours > 18 || (ready.score != null && ready.score < 45) ? 1 : 0;
    let longIdx = days.findIndex((d, i) => i >= recDays && d.dow === longPref && d.available);
    if (longIdx < 0) longIdx = days.map((d, i) => i).filter((i) => i >= recDays && days[i].available).pop() ?? 6;
    const others = nRuns - 1;
    // Long run ~30–45% of the week, never beyond 10% over your longest recent run, always longer than easy runs.
    let longKm = clamp(longest * 1.1, targetKm * 0.3, targetKm * 0.45);
    let easyKm = (targetKm - longKm) / Math.max(1, others);
    if (easyKm > longKm * 0.8) { easyKm = targetKm / (others + 1.3); longKm = easyKm * 1.3; }
    const toKm = (km) => Math.max(2, Math.round(km * 2) / 2);
    const u = (km) => F.dist(ctx, km * 1000, 1).replace(/\.0 /, " ");

    const used = new Set();
    if (longIdx >= 0 && longIdx < 7) {
      days[longIdx].session = { kind: "long", title: "Long run", detail: `${u(toKm(longKm))} · ${easyTarget}. Last 10 minutes can be a little quicker if you feel good.` };
      used.add(longIdx);
    }
    for (let i = 0; i < recDays; i++) { days[i].session = { kind: "rest", title: "Recovery", detail: `Body still recovering (about ${ready.recovery.hours} h left). Rest, or an easy 30–45 min walk.` }; used.add(i); }

    // Spread runs out: first away from the long run and each other, then just apart, then anywhere.
    const free = days.map((d, i) => i).filter((i) => !used.has(i) && days[i].available);
    const pick = [];
    const passes = [
      (i) => Math.abs(i - longIdx) >= 2 && !pick.some((p) => Math.abs(p - i) < 2),
      (i) => !pick.some((p) => Math.abs(p - i) < 2),
      () => true,
    ];
    for (const ok of passes) for (const i of free) if (pick.length < others && !pick.includes(i) && ok(i)) pick.push(i);
    pick.sort((a, b) => a - b);

    let qualityIdx = -1;
    if (wantQuality && pick.length >= 2) qualityIdx = pick.find((i) => Math.abs(i - longIdx) >= 2) ?? -1;
    easyKm = toKm(easyKm);
    for (const i of pick) {
      if (i === qualityIdx) {
        days[i].session = easyShare < 0.7
          ? { kind: "quality", title: "Strides", detail: `${u(easyKm)} · ${easyTarget}. Finish with 6 × 20 s relaxed fast strides, walking back between each. Keeps your speed without adding more zone 3.` }
          : { kind: "quality", title: "Tempo", detail: `15 min easy warm-up, 3 × 8 min at ${z4 ? `${z3}–${z4 - 1} bpm (zone 3)` : "comfortably hard"} with 2 min jog, 10 min cool-down.` };
      } else {
        days[i].session = { kind: "easy", title: "Easy run", detail: `${u(easyKm)} · ${easyTarget}.` };
      }
    }
    for (const d of days) if (!d.session) d.session = d.available
      ? { kind: "rest", title: "Rest or walk", detail: "Day off, or a 30–60 min walk. Light mobility for calves and hips." }
      : { kind: "rest", title: "Rest", detail: "Not one of your training days." };

    return { days, targetKm, nRuns, weeklyKm };
  };
})();
