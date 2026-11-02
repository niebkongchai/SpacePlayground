// Talks to the Run Coach backend (/api/...). In demo mode it answers the same Garmin paths
// with generated sample data, so the dashboard can be tried without a Garmin key.
(() => {
  const RC = (window.RC = window.RC || {});

  RC.isDemo = new URLSearchParams(location.search).has("demo");

  RC.iso = (d) => {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  };
  RC.daysAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  RC.ApiError = ApiError;

  async function request(method, url, body) {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new ApiError(r.status, (json && (json.error || json.message)) || `HTTP ${r.status}`);
    return json;
  }

  RC.api = {
    health: () => request("GET", "/api/health"),
    connect: (key, region) => request("POST", "/api/session", { key, region }),
    session: () => (RC.isDemo ? Promise.resolve({ ok: true, demo: true }) : request("GET", "/api/session")),
    disconnect: () => (RC.isDemo ? Promise.resolve() : request("DELETE", "/api/session")),
    get(path, params) {
      const qs = params ? "?" + new URLSearchParams(params).toString() : "";
      if (RC.isDemo) return Promise.resolve(demo(path, params || {}));
      return request("GET", "/api/garmin" + path + qs);
    },
  };

  // ---------------------------------------------------------------- demo data
  let demoStore = null;

  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildDemo() {
    const rand = rng(42);
    const between = (a, b) => a + rand() * (b - a);
    const acts = [], days = [], sleeps = [], hrvs = [];
    const zones = { restingHeartRateUsed: 52, maxHeartRateUsed: 192, zone1Floor: 96, zone2Floor: 134, zone3Floor: 150, zone4Floor: 165, zone5Floor: 177 };
    let id = 9000000000;

    for (let n = 364; n >= 0; n--) {
      const d = RC.daysAgo(n);
      const date = RC.iso(d);
      const dow = d.getDay();
      const fitness = 1 - n / 600; // gets fitter through the year
      let type = null;
      if (dow === 0) type = rand() < 0.3 ? "trail_running" : "running";
      else if (dow === 2 || dow === 4) type = rand() < 0.85 ? "running" : null;
      else if (dow === 6) type = rand() < 0.4 ? "hiking" : rand() < 0.5 ? "walking" : null;
      else if (dow === 3 && rand() < 0.3) type = "treadmill_running";

      let dayLoad = 0;
      if (type) {
        const isLong = dow === 0;
        const isQuality = dow === 4 && rand() < 0.6;
        const run = type.includes("running");
        const dist = run ? (isLong ? between(12, 21) : between(5, 9)) * 1000 * (0.75 + 0.3 * fitness)
          : type === "hiking" ? between(8, 15) * 1000 : between(3, 6) * 1000;
        const baseSpeed = run ? (2.65 + 0.35 * fitness) * (isQuality ? 1.12 : 1) * (type === "trail_running" ? 0.82 : 1)
          : type === "hiking" ? 1.15 : 1.45;
        const speed = baseSpeed * between(0.96, 1.04);
        const dur = dist / speed;
        const hr = run ? Math.round((isQuality ? 162 : isLong ? 150 : 146) + between(-5, 6) - 6 * fitness) : Math.round(between(98, 118));
        const share = run
          ? (isQuality ? [0.02, 0.18, 0.3, 0.38, 0.12] : [0.04, 0.46, 0.38, 0.11, 0.01])
          : [0.55, 0.4, 0.05, 0, 0];
        const load = run ? Math.round(dur / 60 * (isQuality ? 2.4 : 1.6)) : Math.round(dur / 60 * 0.45);
        dayLoad = load;
        const elev = type === "trail_running" ? dist / 1000 * between(35, 60) : type === "hiking" ? dist / 1000 * between(50, 90) : dist / 1000 * between(2, 8);
        const aTE = run ? Math.min(5, (isQuality ? 3.6 : isLong ? 3.4 : 2.7) + between(-0.3, 0.4)) : between(0.8, 1.6);
        const start = new Date(d); start.setHours(dow === 0 ? 6 : 18, Math.floor(between(0, 50)), 0, 0);
        const label = { running: "Run", trail_running: "Trail Run", treadmill_running: "Treadmill", walking: "Walk", hiking: "Hike" }[type];
        acts.push({
          activityId: id++,
          activityName: `${["Chon Buri", "Bang Saen", "Khao Kheow", "Si Racha"][Math.floor(rand() * 4)]} ${isLong && run ? "Long " : isQuality ? "Tempo " : ""}${label}`,
          startTimeLocal: `${date} ${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}:00`,
          activityType: { typeKey: type },
          ownerFullName: "Demo Runner",
          distance: dist, duration: dur, movingDuration: dur * 0.97, elapsedDuration: dur * 1.02,
          averageSpeed: speed, avgGradeAdjustedSpeed: type === "trail_running" ? speed * 1.15 : speed,
          averageHR: hr, maxHR: hr + Math.round(between(10, 22)),
          averageRunningCadenceInStepsPerMinute: run ? between(158, 172) : between(105, 118),
          elevationGain: elev, elevationLoss: elev * between(0.9, 1.05),
          activityTrainingLoad: load, aerobicTrainingEffect: aTE, anaerobicTrainingEffect: isQuality ? between(1.5, 2.8) : between(0, 0.6),
          trainingEffectLabel: !run ? "RECOVERY" : isQuality ? "TEMPO" : isLong ? "BASE" : "AEROBIC_BASE",
          calories: Math.round(dur / 60 * (run ? 11 : 5)), steps: Math.round(dur / 60 * (run ? 165 : 110)),
          hrTimeInZone_1: dur * share[0], hrTimeInZone_2: dur * share[1], hrTimeInZone_3: dur * share[2], hrTimeInZone_4: dur * share[3], hrTimeInZone_5: dur * share[4],
          fastestSplit_1000: run ? 1000 / (speed * 1.06) : undefined,
          fastestSplit_5000: run && dist >= 5000 ? 5000 / (speed * 1.03) : undefined,
          fastestSplit_10000: run && dist >= 10000 ? 10000 / (speed * 1.015) : undefined,
          fastestSplit_21098: run && dist >= 21098 ? 21098 / speed : undefined,
          avgGroundContactTime: run ? between(240, 270) : undefined, avgVerticalOscillation: run ? between(7.5, 9.5) : undefined,
          avgStrideLength: run ? between(95, 115) : undefined, avgPower: run ? Math.round(between(230, 280)) : undefined,
          locationName: "Chon Buri",
          splitSummaries: [{ splitType: "INTERVAL_ACTIVE", noOfSplits: 1, distance: dist, duration: dur, averageSpeed: speed }],
        });
      }

      const sleepH = between(5.6, 8.1);
      const tired = dayLoad > 90 ? 1 : 0;
      sleeps.push({
        calendarDate: date,
        sleepTimeSeconds: Math.round(sleepH * 3600),
        deepSleepSeconds: Math.round(sleepH * 3600 * between(0.15, 0.22)),
        remSleepSeconds: Math.round(sleepH * 3600 * between(0.18, 0.24)),
        lightSleepSeconds: Math.round(sleepH * 3600 * 0.56),
        awakeSleepSeconds: Math.round(between(300, 2400)),
        avgHeartRate: 54 + tired * 3,
        avgSleepStress: between(12, 28),
        sleepScores: { overall: { value: Math.round(Math.min(96, 40 + sleepH * 6.5 + between(-8, 6))) } },
      });
      const rhr = Math.round(55 - 3 * fitness + tired * 2 + between(-1.5, 1.5));
      days.push({
        calendarDate: date,
        heartRate: { restingValue: rhr, minValue: rhr - 3, maxValue: 120 + Math.round(dayLoad / 2) },
        movement: { steps: { value: Math.round(between(6500, 13500) + dayLoad * 40), goal: 8000 } },
        bodyBattery: { maxValue: Math.round(between(55, 95) - tired * 10), minValue: Math.round(between(8, 30)) },
        stress: { avgLevel: Math.round(between(22, 42)) },
        intensityMinutes: { moderate: Math.round(between(5, 25)), vigorous: Math.round(dayLoad / 3), goal: 150 },
      });
      const last = Math.round(58 + 6 * fitness - tired * 6 + between(-6, 6));
      hrvs.push({
        calendarDate: date, lastNightAvg: last, weeklyAvg: Math.round(58 + 6 * fitness),
        status: last < 52 ? "UNBALANCED" : "BALANCED",
        baseline: { lowUpper: 48, balancedLow: 53, balancedUpper: 70 },
      });
    }
    acts.sort((a, b) => b.startTimeLocal.localeCompare(a.startTimeLocal));
    return { acts, days, sleeps, hrvs, zones };
  }

  function inRange(list, from, to, key = "calendarDate") {
    return list.filter((x) => (x[key] || "").slice(0, 10) >= from && (x[key] || "").slice(0, 10) <= to);
  }

  function demo(path, p) {
    demoStore = demoStore || buildDemo();
    const s = demoStore;
    if (path === "/userprofile-service/userprofile/settings") {
      return { displayName: "demo", measurementSystem: "metric", availableTrainingDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], preferredLongTrainingDays: ["sunday"] };
    }
    if (path === "/biometric-service/heartRateZones/v2") return [{ trainingMethod: "HR_RESERVE", sport: "DEFAULT", ...s.zones }];
    if (path === "/activitylist-service/activities/search/activities") {
      const list = inRange(s.acts, p.startDate || "0000", p.endDate || "9999", "startTimeLocal");
      const start = Number(p.start || 0);
      return list.slice(start, start + Number(p.limit || 99));
    }
    if (path === "/usersummary-service/v2/dailysummaries") return { data: inRange(s.days, p.startDate, p.endDate) };
    if (path === "/sleep-service/sleep/dailySleepSummariesByDate") return inRange(s.sleeps, p.startDate, p.endDate);
    let m = /^\/hrv-service\/hrv\/daily\/([\d-]+)\/([\d-]+)$/.exec(path);
    if (m) return { hrvSummaries: inRange(s.hrvs, m[1], m[2]) };
    if (path.startsWith("/fitnessage-service/fitnessage/v2/")) {
      return { chronologicalAge: 36, fitnessAge: 31.4, achievableFitnessAge: 29.8, components: { vigorousMinutesAvg: { value: 48, targetValue: 75, potentialAge: 30.6, priority: 1 }, rhr: { value: 51 }, bmi: { value: 23.1, targetValue: 22.5, potentialAge: 31.1, priority: 2 } } };
    }
    m = /^\/activity-service\/activity\/(\d+)$/.exec(path);
    if (m) {
      const a = s.acts.find((x) => String(x.activityId) === m[1]);
      return a ? { activityId: a.activityId, summaryDTO: { recoveryHeartRate: Math.round(a.averageHR - 28), directWorkoutRpe: 50 }, splitSummaries: a.splitSummaries } : {};
    }
    throw new ApiError(404, "Demo has no data for " + path);
  }
})();
