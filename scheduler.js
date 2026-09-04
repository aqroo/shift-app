/**
 * シフト自動生成アルゴリズム。
 *
 * 「候補を大量生成 → スコアリング → 上位を局所探索で改善」という
 * 古典的な最適化手法(ヒルクライミング)。AIは使っていない。
 *
 * DOMに依存しない純粋な関数群。app.js から呼び出す。
 */

// ---- 基本ユーティリティ -----------------------------------------------

function daysInMonth(year, month) {
  // month は 1-12
  return new Date(year, month, 0).getDate();
}

function weekdayOf(year, month, day) {
  // 0=月, 1=火, ... 6=日 (calendar.weekday互換に揃える)
  const jsWd = new Date(year, month - 1, day).getDay(); // 0=日,1=月,...6=土
  return (jsWd + 6) % 7;
}

function buildDays(cond) {
  const n = daysInMonth(cond.year, cond.month);
  const days = [];
  for (let d = 1; d <= n; d++) {
    const wd = weekdayOf(cond.year, cond.month, d);
    const forcedWork = cond.absoluteWorkDates && cond.absoluteWorkDates.has(d);
    const forcedOff =
      !forcedWork &&
      (cond.absoluteOffDates.has(d) || cond.fixedOffWeekdays.has(wd));
    days.push({ day: d, weekday: wd, forcedOff, forcedWork: !!forcedWork });
  }
  return days;
}

// ---- 事前の実現可能性チェック ------------------------------------------

function checkFeasibility(cond) {
  if (cond.minWorkDays > cond.maxWorkDays) {
    return { feasible: false, reason: "希望出勤日数の下限が上限を超えています。" };
  }
  const days = buildDays(cond);
  const forcedOffCount = days.filter((d) => d.forcedOff).length;
  const forcedWorkCount = days.filter((d) => d.forcedWork).length;
  const available = days.length - forcedOffCount;

  if (available < cond.minWorkDays) {
    return {
      feasible: false,
      reason: `固定休・絶対休みの日が多く、出勤可能な日が${available}日しかありません。最低出勤日数(${cond.minWorkDays}日)を満たせません。固定休を減らすか、最低出勤日数を下げてください。`,
    };
  }

  if (forcedWorkCount > cond.maxWorkDays) {
    return {
      feasible: false,
      reason: `すでに出勤した日として選んだ日数(${forcedWorkCount}日)が、上限日数(${cond.maxWorkDays}日)を超えています。上限日数を増やしてください。`,
    };
  }

  const forcedWorkRun = maxForcedWorkRun(days);
  if (forcedWorkRun > cond.maxConsecutiveWorkDays) {
    return {
      feasible: false,
      reason: `すでに出勤した日として選んだ日が${forcedWorkRun}日連続しており、最大連勤日数(${cond.maxConsecutiveWorkDays}日)を超えています。最大連勤日数を増やしてください。`,
    };
  }

  // 連勤上限が原因で最低出勤日数に届かないケースの簡易チェック
  // (休みを挟まず作れる出勤日の理論上の最大値を概算)
  const maxPossibleByConsecutive = estimateMaxByConsecutive(days, cond.maxConsecutiveWorkDays);
  if (maxPossibleByConsecutive < cond.minWorkDays) {
    return {
      feasible: false,
      reason: `最大連勤日数(${cond.maxConsecutiveWorkDays}日)の制約が厳しく、最低出勤日数(${cond.minWorkDays}日)を満たせません。最大連勤日数を増やすか、最低出勤日数を下げてください。`,
    };
  }

  return { feasible: true };
}

function maxForcedWorkRun(days) {
  // forcedWorkの日が、間に一切「休みになりうる余地」を挟まず
  // (=隣の日もforcedWork)何日連続しているかの最大値。
  // これは「ユーザーの選択だけで、アルゴリズムの選択の余地なく確定してしまう
  // 連勤日数」なので、これがmaxConsecutiveWorkDaysを超えていたら、
  // どう頑張っても連勤上限を守れないということになる。
  // (forcedWorkでない日は、アルゴリズムが「休み」を選べる余地が残っているため、
  //  そこで連勤の鎖は途切れる可能性がある扱いにする)
  let best = 0;
  let cur = 0;
  for (const d of days) {
    if (d.forcedWork) {
      cur++;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

function estimateMaxByConsecutive(days, maxConsecutive) {  // forcedOffで区切られた各区間で、maxConsecutiveおきに1日休みを挟むと
  // 仮定した場合に働ける最大日数の概算。
  let total = 0;
  let runLen = 0;
  const flushRun = () => {
    if (runLen === 0) return;
    const blocks = Math.ceil(runLen / (maxConsecutive + 1));
    const workable = runLen - Math.max(0, blocks - 1) * 0; // 簡略化: 区間内はmaxConsecutiveごとに1休みが必要
    // 区間runLen日のうち、maxConsecutive日働いたら1日休む、を繰り返した場合の最大出勤日数
    const cycles = Math.floor(runLen / (maxConsecutive + 1));
    const remainder = runLen % (maxConsecutive + 1);
    total += cycles * maxConsecutive + Math.min(remainder, maxConsecutive);
    runLen = 0;
  };
  for (const d of days) {
    if (d.forcedOff) {
      flushRun();
    } else {
      runLen++;
    }
  }
  flushRun();
  return total;
}

// ---- 候補生成 -----------------------------------------------------------

function targetWorkDays(cond) {
  if (cond.targetSalary) {
    const est = cond.targetSalary / (cond.hourlyWage * cond.hoursPerDay);
    return Math.min(Math.max(Math.round(est), cond.minWorkDays), cond.maxWorkDays);
  }
  return Math.round((cond.minWorkDays + cond.maxWorkDays) / 2);
}

function generateCandidate(cond, days, targetDays, rng) {
  const n = days.length;
  const schedule = new Array(n).fill(false);
  let consecutive = 0;
  let remainingNeeded = targetDays;

  for (let i = 0; i < n; i++) {
    const day = days[i];
    if (day.forcedOff) {
      consecutive = 0;
      continue;
    }
    if (day.forcedWork) {
      schedule[i] = true;
      consecutive++;
      remainingNeeded--;
      continue;
    }

    const remainingDays = n - i;
    let baseProb = remainingNeeded / Math.max(remainingDays, 1);
    baseProb = Math.min(Math.max(baseProb, 0), 1);

    if (cond.preferredOffWeekdays.has(day.weekday)) {
      baseProb *= 0.45;
    }

    let work;
    if (consecutive >= cond.maxConsecutiveWorkDays) {
      work = false;
    } else {
      work = rng() < baseProb;
    }

    schedule[i] = work;
    if (work) {
      consecutive++;
      remainingNeeded--;
    } else {
      consecutive = 0;
    }
  }

  return repairSchedule(cond, days, schedule, rng);
}

function runLengthAt(schedule, i) {
  let run = 1;
  let j = i - 1;
  while (j >= 0 && schedule[j]) {
    run++;
    j--;
  }
  j = i + 1;
  while (j < schedule.length && schedule[j]) {
    run++;
    j++;
  }
  return run;
}

function repairSchedule(cond, days, schedule, rng) {
  let workDays = schedule.filter(Boolean).length;

  const canWork = (i) => {
    if (days[i].forcedOff || days[i].forcedWork || schedule[i]) return false;
    schedule[i] = true;
    const run = runLengthAt(schedule, i);
    schedule[i] = false;
    return run <= cond.maxConsecutiveWorkDays;
  };

  let tries = 0;
  while (workDays < cond.minWorkDays && tries < 500) {
    const candidates = [];
    for (let i = 0; i < schedule.length; i++) if (canWork(i)) candidates.push(i);
    if (candidates.length === 0) break;
    const i = candidates[Math.floor(rng() * candidates.length)];
    schedule[i] = true;
    workDays++;
    tries++;
  }

  tries = 0;
  while (workDays > cond.maxWorkDays && tries < 500) {
    const candidates = [];
    for (let i = 0; i < schedule.length; i++) {
      if (schedule[i] && !days[i].forcedOff && !days[i].forcedWork) candidates.push(i);
    }
    if (candidates.length === 0) break;
    const preferred = candidates.filter((i) => cond.preferredOffWeekdays.has(days[i].weekday));
    const pool = preferred.length ? preferred : candidates;
    const i = pool[Math.floor(rng() * pool.length)];
    schedule[i] = false;
    workDays--;
    tries++;
  }

  return schedule;
}

// ---- スコアリング ---------------------------------------------------------

function offBlocks(schedule) {
  const blocks = [];
  let cur = 0;
  for (const w of schedule) {
    if (!w) {
      cur++;
    } else {
      if (cur > 0) blocks.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) blocks.push(cur);
  return blocks;
}

function scoreSchedule(cond, days, schedule, targetDays) {
  const workDays = schedule.filter(Boolean).length;
  const estSalary = workDays * cond.hoursPerDay * cond.hourlyWage;

  let s = 0;

  if (cond.targetSalary) {
    const diffRatio = Math.abs(estSalary - cond.targetSalary) / cond.targetSalary;
    s += (1 - Math.min(diffRatio, 1)) * 50;
  }

  const dayDiff = Math.abs(workDays - targetDays);
  s += Math.max(0, 20 - dayDiff * 4);

  const prefDays = days
    .map((d, i) => (cond.preferredOffWeekdays.has(d.weekday) ? i : -1))
    .filter((i) => i >= 0);
  if (prefDays.length) {
    const satisfied = prefDays.filter((i) => !schedule[i]).length;
    s += (satisfied / prefDays.length) * 20;
  }

  const blocks = offBlocks(schedule);
  const longBlocks = blocks.filter((b) => b >= 2);
  if (cond.wantRenkyu) {
    s += Math.min(longBlocks.length * 6, 18);
    if (blocks.length) s += Math.min(Math.max(...blocks) * 1.5, 9);
  }

  return { score: s, estSalary, workDays, blocks };
}

// ---- 局所探索(ヒルクライミング) ---------------------------------------

function maxConsecutiveRun(schedule) {
  let best = 0;
  let cur = 0;
  for (const w of schedule) {
    cur = w ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

function isValid(cond, schedule) {
  return maxConsecutiveRun(schedule) <= cond.maxConsecutiveWorkDays;
}

function localSearch(cond, days, schedule, targetDays, rng, iterations = 400) {
  let best = scoreSchedule(cond, days, schedule, targetDays).score;
  const n = schedule.length;

  for (let iter = 0; iter < iterations; iter++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i === j) continue;
    if (days[i].forcedOff || days[j].forcedOff || days[i].forcedWork || days[j].forcedWork) continue;
    if (schedule[i] === schedule[j]) continue;

    [schedule[i], schedule[j]] = [schedule[j], schedule[i]];

    if (isValid(cond, schedule)) {
      const newScore = scoreSchedule(cond, days, schedule, targetDays).score;
      if (newScore >= best) {
        best = newScore;
        continue;
      }
    }
    // 却下 → 元に戻す
    [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
  }

  return schedule;
}

// 簡易な決定論的PRNG(シード指定可能。指定なければMath.random)
function makeRng(seed) {
  if (seed === undefined) return Math.random;
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function scheduleKey(schedule) {
  return schedule.map((w) => (w ? "1" : "0")).join("");
}

/**
 * メイン関数。条件を渡すと、最良のスケジュールと、
 * 別候補(異なるパターンの上位いくつか)を返す。
 */
function generateSchedules(cond, options = {}) {
  const nCandidates = options.nCandidates ?? 2500;
  const nAlternatives = options.nAlternatives ?? 3;
  const rng = makeRng(options.seed);

  const feasibility = checkFeasibility(cond);
  if (!feasibility.feasible) {
    return { feasible: false, reason: feasibility.reason };
  }

  const days = buildDays(cond);
  const tDays = targetWorkDays(cond);

  const seen = new Map(); // key -> {schedule, score, ...}

  for (let i = 0; i < nCandidates; i++) {
    const sched = generateCandidate(cond, days, tDays, rng);
    const result = scoreSchedule(cond, days, sched, tDays);
    const key = scheduleKey(sched);
    if (!seen.has(key) || seen.get(key).score < result.score) {
      seen.set(key, { schedule: sched.slice(), ...result });
    }
  }

  let candidates = Array.from(seen.values()).sort((a, b) => b.score - a.score);
  candidates = candidates.slice(0, Math.max(nAlternatives * 3, 10));

  // 上位候補それぞれに局所探索をかけて仕上げる
  candidates = candidates.map((c) => {
    const improved = localSearch(cond, days, c.schedule.slice(), tDays, rng);
    const result = scoreSchedule(cond, days, improved, tDays);
    return { schedule: improved, ...result };
  });

  // 重複除去して再ソート
  const dedup = new Map();
  for (const c of candidates) {
    const key = scheduleKey(c.schedule);
    if (!dedup.has(key) || dedup.get(key).score < c.score) dedup.set(key, c);
  }
  candidates = Array.from(dedup.values()).sort((a, b) => b.score - a.score);

  const top = candidates.slice(0, nAlternatives).map((c) => ({
    schedule: c.schedule,
    estimatedSalary: c.estSalary,
    workDays: c.workDays,
    offDays: days.length - c.workDays,
    offBlocks: c.blocks.slice().sort((a, b) => b - a),
    maxConsecutiveActual: maxConsecutiveRun(c.schedule),
    score: c.score,
  }));

  return {
    feasible: true,
    days,
    targetWorkDays: tDays,
    best: top[0],
    alternatives: top,
  };
}

// Node/ブラウザ両対応のエクスポート
const SchedulerAPI = {
  daysInMonth,
  weekdayOf,
  buildDays,
  checkFeasibility,
  targetWorkDays,
  generateSchedules,
  maxConsecutiveRun,
  offBlocks,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SchedulerAPI;
} else {
  window.Scheduler = SchedulerAPI;
}
