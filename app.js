(function () {
  "use strict";

  const WD_LABELS = ["月", "火", "水", "木", "金", "土", "日"];
  const STORAGE_LAST_COND = "shiftapp:lastConditions";
  const STORAGE_RECORDS = "shiftapp:records";
  const STORAGE_THEME = "shiftapp:theme";
  const STORAGE_ACCENT = "shiftapp:accent";
  const STORAGE_PROFILES = "shiftapp:profiles";

  const APP_VERSION = "1.2.0";

  const ACCENTS = [
    { key: "teal", label: "ティール", swatch: "#3E7C74" },
    { key: "indigo", label: "インディゴ", swatch: "#4552C4" },
    { key: "amber", label: "アンバー", swatch: "#96661E" },
    { key: "plum", label: "プラム", swatch: "#7A3F5C" },
    { key: "forest", label: "フォレスト", swatch: "#3F6B42" },
  ];

  // 更新履歴。機能追加・修正のたびに先頭へ追記する。
  const CHANGELOG = [
    {
      version: "1.2.0",
      date: "2026-09-04",
      notes: [
        "「まとめる目安」設定を追加。短い出勤が飛び石で続くのを避け、まとまった連勤にしやすくしました",
        "休み・出勤日を指定するカレンダーを1つに統合し、フォームをすっきりさせました",
        "詳細な設定(固定休・確定済み期間)を折りたたみ表示にしました",
        "履歴画面に何も保存されていない時に操作できなくなる不具合を修正",
        "プロフィール機能を追加(条件をまとめて保存・呼び出し)",
        "テーマ(ライト・ダーク・自動)とアクセントカラーの切り替えを追加",
        "設定タブを新設し、テーマ・プロフィール・バージョン情報をまとめました",
      ],
    },
    {
      version: "1.1.1",
      date: "2026-09-04",
      notes: [
        "「シフト確定済みの最終日」を設定できるようにし、クール制のバイト先にも対応",
      ],
    },
    {
      version: "1.1.0",
      date: "2026-09-04",
      notes: [
        "今日より前の日を、明示的に選ばない限り自動的に休み扱いにするよう修正",
        "「すでに出勤した日」を指定できるカレンダーを追加",
        "最低出勤日数などの絶対条件を任意項目に変更(未入力なら制限なし)",
      ],
    },
    {
      version: "1.0.0",
      date: "2026-09-03",
      notes: ["初回リリース"],
    },
  ];

  // ---- 状態 ---------------------------------------------------------------

  const state = {
    cond: null,
    days: null,
    result: null,
    altIndex: 0,
    schedule: null,
    formAbsoluteOff: new Set(),
    formAbsoluteWork: new Set(),
    formFixedOff: new Set(),
    formPreferredOff: new Set(),
    sheetIndex: null,
    pickMode: "off", // "off" | "work" — 統合カレンダーのタップ時の動作切り替え
    currentView: "form",
    viewBeforeOverlay: "form", // 履歴/設定を開く前に見ていたビュー
    pendingDeleteProfileId: null,
  };

  // ---- ユーティリティ -------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function showView(name) {
    if (name !== "history" && name !== "settings") {
      state.viewBeforeOverlay = name;
    }
    state.currentView = name;
    ["form", "generating", "result", "history", "settings"].forEach((v) => {
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
      state.formFixedOff.forEach((wd) => state.formPreferredOff.delete(wd));
      renderWeekdayChips();
    });
    buildWeekdayChips($("preferredOffWeekdays"), state.formPreferredOff, renderWeekdayChips);

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

  // ---- 休み・出勤日 指定カレンダー(1つに統合) -------------------------------

  function getFormYearMonth() {
    const v = $("inputMonth").value; // "YYYY-MM"
    if (!v) return null;
    const [y, m] = v.split("-").map(Number);
    return { year: y, month: m };
  }

  function setPickMode(mode) {
    state.pickMode = mode;
    const switchEl = $("pickModeSwitch");
    Array.from(switchEl.children).forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.mode === mode);
    });
    $("pickModeHint").textContent = mode === "off"
      ? "カレンダーの日付をタップすると「絶対に休みたい日」として選ばれます。"
      : "カレンダーの日付をタップすると「すでに出勤した日」として選ばれます。";
  }

  function renderPickCalendar() {
    const container = $("pickCalendar");
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
      if (state.formAbsoluteOff.has(d)) cell.classList.add("is-pick-off");
      if (state.formAbsoluteWork.has(d)) cell.classList.add("is-pick-work");
      cell.textContent = String(d);
      cell.addEventListener("click", () => {
        if (state.pickMode === "off") {
          if (state.formAbsoluteOff.has(d)) state.formAbsoluteOff.delete(d);
          else {
            state.formAbsoluteOff.add(d);
            state.formAbsoluteWork.delete(d);
          }
        } else {
          if (state.formAbsoluteWork.has(d)) state.formAbsoluteWork.delete(d);
          else {
            state.formAbsoluteWork.add(d);
            state.formAbsoluteOff.delete(d);
          }
        }
        renderPickCalendar();
      });
      container.appendChild(cell);
    }
  }

  // ---- フォーム -> 条件オブジェクト --------------------------------------------

  function readConditionsFromForm() {
    const ym = getFormYearMonth();
    const wage = Number($("inputWage").value);
    const hours = Number($("inputHours").value);
    const targetSalaryRaw = $("inputTargetSalary").value;
    const targetSalary = targetSalaryRaw ? Number(targetSalaryRaw) : null;
    const wantRenkyu = $("inputRenkyu").getAttribute("aria-checked") === "true";

    const daysInMonth = ym ? Scheduler.daysInMonth(ym.year, ym.month) : 31;
    const minRaw = $("inputMinDays").value;
    const maxRaw = $("inputMaxDays").value;
    const maxConsecutiveRaw = $("inputMaxConsecutive").value;
    const minWorkBlockRaw = $("inputMinWorkBlock").value;

    const minWorkDays = minRaw ? Number(minRaw) : 0;
    const maxWorkDays = maxRaw ? Number(maxRaw) : daysInMonth;
    const maxConsecutiveWorkDays = maxConsecutiveRaw ? Number(maxConsecutiveRaw) : daysInMonth;
    const minWorkBlock = minWorkBlockRaw ? Number(minWorkBlockRaw) : null;

    const confirmedThroughRaw = $("inputConfirmedThroughDay").value;
    const confirmedThroughDate = (confirmedThroughRaw && ym)
      ? { year: ym.year, month: ym.month, day: Number(confirmedThroughRaw) }
      : null;

    return {
      year: ym ? ym.year : null,
      month: ym ? ym.month : null,
      hourlyWage: wage,
      hoursPerDay: hours,
      targetSalary,
      minWorkDays,
      maxWorkDays,
      maxConsecutiveWorkDays,
      minWorkBlock,
      confirmedThroughDate,
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
    if (cond.minWorkBlock && cond.minWorkBlock > cond.maxConsecutiveWorkDays) {
      return "「まとめる目安」の日数が最大連勤日数を超えています。";
    }
    return null;
  }

  function prefillForm(cond) {
    $("inputMonth").value = `${cond.year}-${String(cond.month).padStart(2, "0")}`;
    $("inputWage").value = cond.hourlyWage;
    $("inputHours").value = cond.hoursPerDay;
    $("inputMinDays").value = cond.minWorkDays || "";
    $("inputMaxDays").value = cond.maxWorkDays || "";
    $("inputMaxConsecutive").value = cond.maxConsecutiveWorkDays || "";
    $("inputMinWorkBlock").value = cond.minWorkBlock || "";
    $("inputTargetSalary").value = cond.targetSalary || "";
    $("inputConfirmedThroughDay").value = cond.confirmedThroughDate ? cond.confirmedThroughDate.day : "";
    $("inputRenkyu").setAttribute("aria-checked", cond.wantRenkyu ? "true" : "false");

    state.formAbsoluteOff = new Set(cond.absoluteOffDates);
    state.formAbsoluteWork = new Set(cond.absoluteWorkDates || []);
    state.formFixedOff = new Set(cond.fixedOffWeekdays);
    state.formPreferredOff = new Set(cond.preferredOffWeekdays);
    renderWeekdayChips();
    renderPickCalendar();
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

    if (day.forcedWork) {
      note.textContent = "この日は「すでに出勤した日」として固定されています。";
      toggleBtn.hidden = true;
    } else if (day.forcedOff) {
      note.textContent = day.autoOffLocked
        ? "この日は確定済みの期間内で、「すでに出勤した日」に選ばれていないため、休みとして扱っています。実際に出勤する予定がある場合は、条件を編集して「すでに出勤した日」から選び直してください。"
        : "この日は「絶対に休みたい日」または「毎週の固定休」として設定されています。";
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

  // ---- テーマ / アクセントカラー ---------------------------------------------

  function applyTheme(mode) {
    let resolved = mode;
    if (mode === "auto") {
      resolved = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
        ? "dark" : "light";
    }
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    localStorage.setItem(STORAGE_THEME, mode);
    renderThemeSwitch();
  }

  function renderThemeSwitch() {
    const mode = document.documentElement.dataset.themeMode || "auto";
    Array.from($("themeSwitch").children).forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.themeMode === mode);
    });
  }

  function applyAccent(key) {
    document.documentElement.dataset.accent = key;
    localStorage.setItem(STORAGE_ACCENT, key);
    renderAccentDots();
  }

  function renderAccentDots() {
    const current = document.documentElement.dataset.accent || "teal";
    const container = $("accentDots");
    container.innerHTML = "";
    ACCENTS.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "accent-dot" + (a.key === current ? " is-active" : "");
      btn.style.background = a.swatch;
      btn.setAttribute("aria-label", a.label);
      btn.title = a.label;
      btn.addEventListener("click", () => applyAccent(a.key));
      container.appendChild(btn);
    });
  }

  // ---- プロフィール -------------------------------------------------------

  function loadProfiles() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_PROFILES) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveProfiles(list) {
    localStorage.setItem(STORAGE_PROFILES, JSON.stringify(list));
  }

  function renderProfileList() {
    const profiles = loadProfiles();
    const list = $("profileList");
    list.innerHTML = "";
    $("profileEmpty").hidden = profiles.length > 0;

    profiles.forEach((p) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div>
          <div class="history-item-month">${p.name}</div>
          <div class="history-item-info">時給${p.cond.hourlyWage}円 ・ 1日${p.cond.hoursPerDay}時間</div>
        </div>
        <div class="history-item-actions">
          <button type="button" class="icon-btn-sm" data-action="delete" aria-label="削除">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.closest('[data-action="delete"]')) {
          e.stopPropagation();
          state.pendingDeleteProfileId = p.id;
          $("confirmTitle").textContent = `「${p.name}」を削除しますか？`;
          $("confirmSheet").hidden = false;
          return;
        }
        prefillForm(condFromStorable(p.cond));
        showView("form");
      });
      list.appendChild(item);
    });
  }

  function saveCurrentAsProfile() {
    const nameInput = $("profileNameInput");
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const cond = readConditionsFromForm();
    const profiles = loadProfiles();
    profiles.unshift({
      id: `${Date.now()}`,
      name,
      cond: condToStorable(cond),
      savedAt: new Date().toISOString(),
    });
    saveProfiles(profiles);
    nameInput.value = "";
    renderProfileList();
  }

  function deleteProfile(id) {
    const profiles = loadProfiles().filter((p) => p.id !== id);
    saveProfiles(profiles);
    renderProfileList();
  }

  // ---- 設定ビュー ---------------------------------------------------------

  function renderSettings() {
    renderThemeSwitch();
    renderAccentDots();
    renderProfileList();

    $("versionCurrent").textContent = APP_VERSION;
    const changelogList = $("changelogList");
    changelogList.innerHTML = CHANGELOG.map((entry) => `
      <div class="changelog-entry">
        <span class="changelog-version">v${entry.version}</span>
        <span class="changelog-date">${entry.date}</span>
        <ul>${entry.notes.map((n) => `<li>${n}</li>`).join("")}</ul>
      </div>
    `).join("");
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
    renderPickCalendar();
    setPickMode("off");

    $("inputMonth").addEventListener("change", () => {
      state.formAbsoluteOff = new Set();
      state.formAbsoluteWork = new Set();
      renderPickCalendar();
    });

    $("pickModeSwitch").addEventListener("click", (e) => {
      const btn = e.target.closest(".segmented-btn");
      if (btn) setPickMode(btn.dataset.mode);
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

    $("btnSettings").addEventListener("click", () => {
      renderSettings();
      showView("settings");
    });

    document.querySelectorAll(".back-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        showView(state.viewBeforeOverlay || "form");
      });
    });

    $("themeSwitch").addEventListener("click", (e) => {
      const btn = e.target.closest(".segmented-btn");
      if (btn) applyTheme(btn.dataset.themeMode);
    });

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (document.documentElement.dataset.themeMode === "auto") {
          applyTheme("auto");
        }
      });
    }

    $("btnSaveProfile").addEventListener("click", saveCurrentAsProfile);
    $("confirmOkBtn").addEventListener("click", () => {
      if (state.pendingDeleteProfileId) deleteProfile(state.pendingDeleteProfileId);
      state.pendingDeleteProfileId = null;
      $("confirmSheet").hidden = true;
    });
    $("confirmCancelBtn").addEventListener("click", () => {
      state.pendingDeleteProfileId = null;
      $("confirmSheet").hidden = true;
    });
    $("confirmSheet").addEventListener("click", (e) => {
      if (e.target.id === "confirmSheet") {
        state.pendingDeleteProfileId = null;
        $("confirmSheet").hidden = true;
      }
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

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
