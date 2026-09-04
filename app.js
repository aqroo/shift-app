(function () {
  "use strict";

  const WD_LABELS = ["月", "火", "水", "木", "金", "土", "日"];
  const STORAGE_LAST_COND = "shiftapp:lastConditions";
  const STORAGE_RECORDS = "shiftapp:records";

  // ---- 状態 ---------------------------------------------------------------

  const state = {
    cond: null,           // 生成に使った条件(Setを含む生の形)
    days: null,           // Scheduler.buildDays の結果
    result: null,         // Scheduler.generateSchedules の結果
    altIndex: 0,          // 現在選ばれている候補のインデックス
    schedule: null,       // 現在表示中の(手動編集込みの)スケジュール配列
    formAbsoluteOff: new Set(),
    formAbsoluteWork: new Set(),
    formFixedOff: new Set(),
    formPreferredOff: new Set(),
    sheetIndex: null,
  };

  // ---- ユーティリティ -------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function showView(name) {
    ["form", "generating", "result", "history"].forEach((v) => {
      $(`view-${v}`).hidden = v !== name;
    });
  }

  function formatYen(n) {
    return "¥" + Math.round(n).toLocaleString("ja-JP");
  }

  function monthLabel(year, month) {
    return `${year}年${month}月`;
  }

  function todayInfo() {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }

  // ---- 曜日チップ -----------------------------------------------------------

  function buildWeekdayChips(container, selectedSet, onChange) {
    container.innerHTML = "";
    WD_LABELS.forEach((label, wd) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "weekday-chip";
      btn.textContent = label;
      btn.dataset.wd = String(wd);
      if (selectedSet.has(wd)) btn.classList.add("is-active");
      btn.addEventListener("click", () => {
        if (selectedSet.has(wd)) selectedSet.delete(wd);
        else selectedSet.add(wd);
        onChange();
      });
      container.appendChild(btn);
    });
  }

  function renderWeekdayChips() {
    buildWeekdayChips($("fixedOffWeekdays"), state.formFixedOff, () => {
      // 固定休にした曜日は「できれば休み」からは自動的に外す(重複防止)
      state.formFixedOff.forEach((wd) => state.formPreferredOff.delete(wd));
      renderWeekdayChips();
    });
    buildWeekdayChips($("preferredOffWeekdays"), state.formPreferredOff, renderWeekdayChips);

    // 固定休の曜日は「できれば休み」チップを無効化する
    const prefContainer = $("preferredOffWeekdays");
    Array.from(prefContainer.children).forEach((btn) => {
      const wd = Number(btn.dataset.wd);
      btn.disabled = state.formFixedOff.has(wd);
    });
    const fixedContainer = $("fixedOffWeekdays");
    Array.from(fixedContainer.children).forEach((btn) => {
      const wd = Number(btn.dataset.wd);
      if (state.formFixedOff.has(wd)) btn.classList.add("is-active");
      else btn.classList.remove("is-active");
    });
  }

  // ---- 「絶対に休む日」入力用ミニカレンダー -----------------------------------

  function getFormYearMonth() {
    const v = $("inputMonth").value; // "YYYY-MM"
    if (!v) return null;
    const [y, m] = v.split("-").map(Number);
    return { year: y, month: m };
  }

  function renderPickCalendar(containerId, selectedSet, otherSet) {
    const container = $(containerId);
    container.innerHTML = "";
    const ym = getFormYearMonth();
    if (!ym) return;

    WD_LABELS.forEach((l) => {
      const h = document.createElement("div");
      h.className = "mini-calendar-wd";
      h.textContent = l;
      container.appendChild(h);
    });

    const n = Scheduler.daysInMonth(ym.year, ym.month);
    const firstWd = Scheduler.weekdayOf(ym.year, ym.month, 1);

    for (let i = 0; i < firstWd; i++) {
      const e = document.createElement("div");
      e.className = "cal-cell is-empty";
      container.appendChild(e);
    }

    for (let d = 1; d <= n; d++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-cell";
      if (containerId === "absoluteWorkCalendar") cell.classList.add("cal-cell--work-pick");
      cell.textContent = String(d);
      if (selectedSet.has(d)) cell.classList.add("is-selected");
      cell.addEventListener("click", () => {
        if (selectedSet.has(d)) {
          selectedSet.delete(d);
        } else {
          selectedSet.add(d);
          if (otherSet) otherSet.delete(d); // 「休み」と「出勤済み」は同じ日に両立しない
        }
        renderAbsoluteOffCalendar();
        renderAbsoluteWorkCalendar();
      });
      container.appendChild(cell);
    }
  }

  function renderAbsoluteOffCalendar() {
    renderPickCalendar("absoluteOffCalendar", state.formAbsoluteOff, state.formAbsoluteWork);
  }

  function renderAbsoluteWorkCalendar() {
    renderPickCalendar("absoluteWorkCalendar", state.formAbsoluteWork, state.formAbsoluteOff);
  }

  // ---- フォーム -> 条件オブジェクト --------------------------------------------

  function readConditionsFromForm() {
    const ym = getFormYearMonth();
    const wage = Number($("inputWage").value);
    const hours = Number($("inputHours").value);
    const targetSalaryRaw = $("inputTargetSalary").value;
    const targetSalary = targetSalaryRaw ? Number(targetSalaryRaw) : null;
    const wantRenkyu = $("inputRenkyu").getAttribute("aria-checked") === "true";

    // 日数の上限系は空欄OK(任意)。空欄なら「制限なし」として扱う。
    const daysInMonth = ym ? Scheduler.daysInMonth(ym.year, ym.month) : 31;
    const minRaw = $("inputMinDays").value;
    const maxRaw = $("inputMaxDays").value;
    const maxConsecutiveRaw = $("inputMaxConsecutive").value;

    const minWorkDays = minRaw ? Number(minRaw) : 0;
    const maxWorkDays = maxRaw ? Number(maxRaw) : daysInMonth;
    const maxConsecutiveWorkDays = maxConsecutiveRaw ? Number(maxConsecutiveRaw) : daysInMonth;

    return {
      year: ym ? ym.year : null,
      month: ym ? ym.month : null,
      hourlyWage: wage,
      hoursPerDay: hours,
      targetSalary,
      minWorkDays,
      maxWorkDays,
      maxConsecutiveWorkDays,
      absoluteOffDates: new Set(state.formAbsoluteOff),
      absoluteWorkDates: new Set(state.formAbsoluteWork),
      fixedOffWeekdays: new Set(state.formFixedOff),
      preferredOffWeekdays: new Set(state.formPreferredOff),
      wantRenkyu,
    };
  }

  function validateConditions(cond) {
    if (!cond.year || !cond.month) return "対象年月を選んでください。";
    if (!cond.hourlyWage || cond.hourlyWage <= 0) return "時給を入力してください。";
    if (!cond.hoursPerDay || cond.hoursPerDay <= 0) return "1日の勤務時間を入力してください。";
    if (cond.minWorkDays < 0) return "最低出勤日数は0以上で入力してください。";
    if (cond.maxWorkDays < 0) return "上限日数は0以上で入力してください。";
    if (cond.minWorkDays > cond.maxWorkDays) return "最低出勤日数が上限日数を超えています。";
    if (cond.maxConsecutiveWorkDays < 1) return "最大連勤日数は1以上で入力してください。";
    return null;
  }

  function prefillForm(cond) {
    $("inputMonth").value = `${cond.year}-${String(cond.month).padStart(2, "0")}`;
    $("inputWage").value = cond.hourlyWage;
    $("inputHours").value = cond.hoursPerDay;
    $("inputMinDays").value = cond.minWorkDays;
    $("inputMaxDays").value = cond.maxWorkDays;
    $("inputMaxConsecutive").value = cond.maxConsecutiveWorkDays;
    $("inputTargetSalary").value = cond.targetSalary || "";
    $("inputRenkyu").setAttribute("aria-checked", cond.wantRenkyu ? "true" : "false");

    state.formAbsoluteOff = new Set(cond.absoluteOffDates);
    state.formAbsoluteWork = new Set(cond.absoluteWorkDates || []);
    state.formFixedOff = new Set(cond.fixedOffWeekdays);
    state.formPreferredOff = new Set(cond.preferredOffWeekdays);
    renderWeekdayChips();
    renderAbsoluteOffCalendar();
    renderAbsoluteWorkCalendar();
  }

  // ---- 生成 ------------------------------------------------------------

  function showFormError(message) {
    const err = $("formError");
    err.hidden = false;
    err.textContent = message;
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function runGeneration(cond, seed) {
    showView("generating");
    // スピナーを描画してから重い処理を行う
    setTimeout(() => {
      const result = Scheduler.generateSchedules(cond, { seed });
      if (!result.feasible) {
        showView("form");
        showFormError(result.reason);
        return;
      }
      $("formError").hidden = true;

      state.cond = cond;
      state.days = result.days;
      state.result = result;
      state.altIndex = 0;
      state.schedule = result.best.schedule.slice();

      saveRecord();
      renderResult();
      showView("result");
    }, 30);
  }

  // ---- 結果表示 ---------------------------------------------------------

  function currentStats() {
    const workDays = state.schedule.filter(Boolean).length;
    const offDays = state.schedule.length - workDays;
    const estSalary = workDays * state.cond.hoursPerDay * state.cond.hourlyWage;
    const maxConsecutiveActual = Scheduler.maxConsecutiveRun(state.schedule);
    return { workDays, offDays, estSalary, maxConsecutiveActual };
  }

  function renderResult() {
    const cond = state.cond;
    const stats = currentStats();

    $("resultMonthLabel").textContent = monthLabel(cond.year, cond.month);
    $("resultSalary").textContent = formatYen(stats.estSalary);
    $("resultWorkDays").textContent = `${stats.workDays}日`;
    $("resultOffDays").textContent = `${stats.offDays}日`;
    $("resultMaxConsecutive").textContent = `${stats.maxConsecutiveActual}日`;

    const diffEl = $("resultSalaryDiff");
    if (cond.targetSalary) {
      const diff = stats.estSalary - cond.targetSalary;
      const sign = diff >= 0 ? "+" : "";
      diffEl.textContent = `目標との差 ${sign}${diff.toLocaleString("ja-JP")}円`;
      const threshold = Math.max(2000, cond.targetSalary * 0.03);
      diffEl.className = "summary-salary-diff " + (Math.abs(diff) <= threshold ? "is-close" : "is-far");
    } else {
      diffEl.textContent = "";
      diffEl.className = "summary-salary-diff";
    }

    renderResultCalendar();
    renderAlternatives();
  }

  function renderResultCalendar() {
    const container = $("resultCalendar");
    container.innerHTML = "";
    const cond = state.cond;
    const today = todayInfo();

    WD_LABELS.forEach((l) => {
      const h = document.createElement("div");
      h.className = "mini-calendar-wd";
      h.textContent = l;
      container.appendChild(h);
    });

    const firstWd = state.days[0].weekday;
    for (let i = 0; i < firstWd; i++) {
      const e = document.createElement("div");
      e.className = "cal-cell is-empty";
      container.appendChild(e);
    }

    state.days.forEach((day, i) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-cell " + (state.schedule[i] ? "is-work" : "is-off");
      if (day.forcedOff || day.forcedWork) cell.classList.add("is-forced");
      if (today.y === cond.year && today.m === cond.month && today.d === day.day) {
        cell.classList.add("is-today");
      }
      cell.textContent = String(day.day);
      cell.addEventListener("click", () => openDaySheet(i));
      container.appendChild(cell);
    });
  }

  function renderAlternatives() {
    const container = $("alternatives");
    container.innerHTML = "";
    state.result.alternatives.forEach((alt, i) => {
      const card = document.createElement("div");
      card.className = "alt-card" + (i === state.altIndex ? " is-current" : "");
      const longestOff = alt.offBlocks && alt.offBlocks.length ? alt.offBlocks[0] : null;
      const offInfo = longestOff ? ` ・ 最長連休${longestOff}日` : "";
      card.innerHTML = `
        <div>
          <div class="alt-card-salary">${formatYen(alt.estimatedSalary)}</div>
          <div class="alt-card-info">出勤${alt.workDays}日 ・ 最大連勤${alt.maxConsecutiveActual}日${offInfo}</div>
        </div>
        ${i === state.altIndex ? '<span class="alt-card-badge">選択中</span>' : ""}
      `;
      card.addEventListener("click", () => {
        state.altIndex = i;
        state.schedule = alt.schedule.slice();
        saveRecord();
        renderResult();
      });
      container.appendChild(card);
    });
  }

  // ---- 日付編集シート -----------------------------------------------------

  function openDaySheet(index) {
    state.sheetIndex = index;
    const day = state.days[index];
    const cond = state.cond;
    $("sheetDate").textContent = `${cond.month}月${day.day}日（${WD_LABELS[day.weekday]}）`;

    const toggleBtn = $("sheetToggleBtn");
    const note = $("sheetNote");

    if (day.forcedOff) {
      note.textContent = "この日は「絶対に休みたい日」または「毎週の固定休」として設定されています。";
      toggleBtn.hidden = true;
    } else if (day.forcedWork) {
      note.textContent = "この日は「すでに出勤した日」として固定されています。";
      toggleBtn.hidden = true;
    } else {
      note.textContent = "";
      toggleBtn.hidden = false;
      toggleBtn.textContent = state.schedule[index] ? "休みにする" : "出勤にする";
    }

    $("daySheet").hidden = false;
  }

  function closeDaySheet() {
    $("daySheet").hidden = true;
    state.sheetIndex = null;
  }

  function toggleSheetDay() {
    const i = state.sheetIndex;
    if (i === null) return;
    state.schedule[i] = !state.schedule[i];
    $("sheetToggleBtn").textContent = state.schedule[i] ? "休みにする" : "出勤にする";
    saveRecord();
    renderResult();
  }

  // ---- 保存 / 履歴 --------------------------------------------------------

  function condToStorable(cond) {
    return {
      ...cond,
      absoluteOffDates: Array.from(cond.absoluteOffDates),
      absoluteWorkDates: Array.from(cond.absoluteWorkDates || []),
      fixedOffWeekdays: Array.from(cond.fixedOffWeekdays),
      preferredOffWeekdays: Array.from(cond.preferredOffWeekdays),
    };
  }

  function condFromStorable(obj) {
    return {
      ...obj,
      absoluteOffDates: new Set(obj.absoluteOffDates),
      absoluteWorkDates: new Set(obj.absoluteWorkDates || []),
      fixedOffWeekdays: new Set(obj.fixedOffWeekdays),
      preferredOffWeekdays: new Set(obj.preferredOffWeekdays),
    };
  }

  function loadRecords() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_RECORDS) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveRecord() {
    const key = `${state.cond.year}-${String(state.cond.month).padStart(2, "0")}`;
    const records = loadRecords();
    records[key] = {
      cond: condToStorable(state.cond),
      schedule: state.schedule,
      days: state.days,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_RECORDS, JSON.stringify(records));
    localStorage.setItem(STORAGE_LAST_COND, JSON.stringify(condToStorable(state.cond)));
  }

  function renderHistory() {
    const records = loadRecords();
    const keys = Object.keys(records).sort().reverse();
    const list = $("historyList");
    list.innerHTML = "";
    $("historyEmpty").hidden = keys.length > 0;

    keys.forEach((key) => {
      const rec = records[key];
      const workDays = rec.schedule.filter(Boolean).length;
      const salary = workDays * rec.cond.hoursPerDay * rec.cond.hourlyWage;
      const [y, m] = key.split("-").map(Number);

      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div>
          <div class="history-item-month">${monthLabel(y, m)}</div>
          <div class="history-item-info">出勤${workDays}日 ・ ${formatYen(salary)}</div>
        </div>
        <span aria-hidden="true">›</span>
      `;
      item.addEventListener("click", () => {
        state.cond = condFromStorable(rec.cond);
        state.days = rec.days;
        state.schedule = rec.schedule.slice();
        // 履歴から開いた場合は候補生成をやり直さないので、
        // 「別のパターン」は現在のものだけを表示する
        state.result = {
          alternatives: [{
            schedule: state.schedule,
            estimatedSalary: workDays * state.cond.hoursPerDay * state.cond.hourlyWage,
            workDays,
            maxConsecutiveActual: Scheduler.maxConsecutiveRun(state.schedule),
          }],
        };
        state.altIndex = 0;
        renderResult();
        showView("result");
      });
      list.appendChild(item);
    });
  }

  // ---- 初期化 -----------------------------------------------------------

  function defaultMonthValue() {
    const t = new Date();
    const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  }

  function init() {
    $("inputMonth").value = defaultMonthValue();
    renderWeekdayChips();
    renderAbsoluteOffCalendar();
    renderAbsoluteWorkCalendar();

    $("inputMonth").addEventListener("change", () => {
      state.formAbsoluteOff = new Set();
      state.formAbsoluteWork = new Set();
      renderAbsoluteOffCalendar();
      renderAbsoluteWorkCalendar();
    });

    $("inputRenkyu").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const on = btn.getAttribute("aria-checked") === "true";
      btn.setAttribute("aria-checked", on ? "false" : "true");
    });

    $("conditionForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const cond = readConditionsFromForm();
      const error = validateConditions(cond);
      if (error) {
        showFormError(error);
        return;
      }
      $("formError").hidden = true;
      runGeneration(cond, undefined);
    });

    $("btnEditConditions").addEventListener("click", () => {
      prefillForm(state.cond);
      showView("form");
    });

    $("btnRegenerate").addEventListener("click", () => {
      runGeneration(state.cond, undefined);
    });

    $("btnHistory").addEventListener("click", () => {
      renderHistory();
      showView("history");
    });

    $("sheetCloseBtn").addEventListener("click", closeDaySheet);
    $("sheetToggleBtn").addEventListener("click", toggleSheetDay);
    $("daySheet").addEventListener("click", (e) => {
      if (e.target.id === "daySheet") closeDaySheet();
    });

    // 前回の条件を復元(生成はしない、フォームに反映するだけ)
    try {
      const raw = localStorage.getItem(STORAGE_LAST_COND);
      if (raw) {
        const cond = condFromStorable(JSON.parse(raw));
        prefillForm(cond);
      }
    } catch (e) {
      /* 無視 */
    }

    showView("form");

    // Service Worker登録(オフライン対応)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
