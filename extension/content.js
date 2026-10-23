// ノートまとめて整理 for Gemini Notebook
// 一覧の各行にチェック欄と概要を足し、選んだノートを「︙ → 削除 → 確認の削除」の順で1冊ずつ消す。
(() => {
  "use strict";

  // 概要は summaries.json を毎回読み直す(概要を更新した後は F5 だけで反映される)。
  // 読めない時は拡張に同梱の summaries.js(window.NB_SUMMARIES)を使う。
  // 配布版は中身が空なので、概要の行そのものを出さない(build_zip.py が空にする)
  let SUMMARIES = window.NB_SUMMARIES || {};
  const hasSummaries = () => Object.keys(SUMMARIES).length > 0;
  fetch(chrome.runtime.getURL("summaries.json"), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      SUMMARIES = data;
      document.querySelectorAll(".nbd-sum").forEach((e) => e.remove());
      decorate();
    })
    .catch(() => {});
  const selected = new Set();
  const plan = new Map(); // 題名の書き換え予定 id -> { from, to }
  // 予定は保存しておき、ページや拡張を読み込み直しても残す
  function savePlan() {
    try {
      chrome.storage.local.set({ nbdPlan: [...plan] });
    } catch (e) {
      /* 保存できなくても今回の操作は続けられる */
    }
  }
  try {
    chrome.storage.local.get("nbdPlan").then((d) => {
      for (const [id, p] of d.nbdPlan || []) if (!plan.has(id)) plan.set(id, p);
      if (plan.size) decorate();
    });
  } catch (e) {
    /* 読めない時は空の予定で始める */
  }
  let running = false;
  let stopRequested = false;

  // sleep / el / waitFor / closeMenus / openModal は common.js

  // ---- 行の読み取り ----
  // 「行」は2種類ある: 一覧表示の表の行(tr)と、カード表示(グリッド)のカード(mat-card)。
  // カードは自分のノート(︙メニューがあるもの)だけを対象にし、おすすめのノートは触らない。
  function rows() {
    const trs = [...document.querySelectorAll("table.project-table tr.mat-mdc-row")];
    // おすすめ(他の人のノート)は featured-project-card。同じ部品で︙もあるので、クラスで外す(2026-10-04 実測)
    const cards = [...document.querySelectorAll("mat-card.project-button-card:not(.featured-project-card)")].filter((c) =>
      c.querySelector('button[aria-label="プロジェクトの操作メニュー"]')
    );
    return trs.concat(cards);
  }
  const isCard = (row) => row.tagName === "MAT-CARD";
  function rowId(row) {
    const a = row.querySelector('a.project-table-title, a[href^="/notebook/"]');
    const m = a && (a.getAttribute("href") || "").match(/\/notebook\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }
  function rowTitle(row) {
    if (isCard(row)) {
      const t = row.querySelector(".project-button-title");
      return t ? t.textContent.trim() : "";
    }
    const a = row.querySelector("a.project-table-title");
    if (!a) return "";
    const clone = a.cloneNode(true);
    clone.querySelectorAll(".project-table-emoji, .nbd-sum").forEach((e) => e.remove());
    return clone.textContent.trim();
  }
  // チェック欄・概要・予定を書き足す場所。表は題名の欄、カードはカードの中
  function rowCell(row) {
    return isCard(row) ? row : row.querySelector("td.title-column");
  }
  function findRow(id) {
    return rows().find((r) => rowId(r) === id) || null;
  }
  function titleOf(id) {
    const r = findRow(id);
    return r ? rowTitle(r) : (SUMMARIES[id] && SUMMARIES[id].title) || id;
  }
  // Date printed on the row (cards show "2026/10/06 · 12 個のソース"). 0 when none is found
  function rowDate(row) {
    const m = (row.textContent || "").match(/(\d{4})\s*[\/年.-]\s*(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
  }

  // ---- 並び替え(一覧のカードと、題名・カテゴリの画面で共通) ----
  const SORTS = [
    ["", "↕️ いつもの順"],
    ["new", "📅 日付が新しい順"],
    ["old", "📅 日付が古い順"],
    ["name", "🔤 名前順(A→Z・あ→ん)"],
    ["name-r", "🔤 名前順(逆)"],
  ];
  const byName = (a, b) => a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
  // get(x) -> { title, date }. Array.prototype.sort is stable, so ties keep the page's order
  function sortItems(arr, mode, get) {
    const a = arr.slice();
    if (mode === "new") a.sort((x, y) => get(y).date - get(x).date);
    else if (mode === "old") a.sort((x, y) => get(x).date - get(y).date);
    else if (mode === "name") a.sort((x, y) => byName(get(x).title, get(y).title));
    else if (mode === "name-r") a.sort((x, y) => byName(get(y).title, get(x).title));
    return a;
  }
  const rowKey = (r) => ({ title: rowTitle(r), date: rowDate(r) });

  // ---- 各行への書き足し ----
  function decorate() {
    const all = rows();
    if (!all.length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    for (const row of all) {
      const id = rowId(row);
      if (!id) continue;
      const cell = rowCell(row);
      if (!cell) continue;
      cell.classList.add(isCard(row) ? "nbd-card" : "nbd-cell");

      let cb = cell.querySelector("input.nbd-cb");
      if (!cb) {
        const label = document.createElement("label");
        label.className = "nbd-cb-wrap";
        label.title = "このノートを選ぶ";
        cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "nbd-cb";
        label.appendChild(cb);
        label.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          const rid = rowId(row);
          if (cb.checked) selected.add(rid);
          else selected.delete(rid);
          refresh();
        });
        if (isCard(row)) {
          // カードは全体がリンクなので、左上に重ねて置き、押してもノートが開かないようにする
          label.classList.add("nbd-cb-card");
          cell.append(label);
        } else {
          cell.insertBefore(label, cell.firstChild);
        }
      }
      cb.checked = selected.has(id);
      row.classList.toggle("nbd-selected", cb.checked);

      if (hasSummaries() && !cell.querySelector(".nbd-sum")) {
        const s = SUMMARIES[id];
        const div = document.createElement("div");
        div.className = "nbd-sum";
        if (s && s.ja) {
          div.textContent = s.ja;
          if (s.sources && s.sources.length) {
            div.title = "出典の例:\n・" + s.sources.slice(0, 8).join("\n・");
          }
        } else {
          div.textContent = "(概要はまだありません)";
          div.classList.add("nbd-sum-empty");
        }
        cell.appendChild(div);
      }

      // 題名の書き換え予定があれば、題名の下に黄色で出す
      let pl = cell.querySelector(".nbd-plan");
      const p = plan.get(id);
      if (p) {
        if (!pl) {
          pl = el("div", { className: "nbd-plan" });
          cell.appendChild(pl);
        }
        if (pl.textContent !== "→ " + p.to) pl.textContent = "→ " + p.to;
      } else if (pl) {
        pl.remove();
      }
    }
    applyGridOrder();
  }

  function refresh() {
    // 一覧は削除のたびに一瞬組み直されるので、ここで「見えない=消えた」として選択を外してはいけない
    // Write only on change: an unconditional write is itself a DOM mutation that re-fires the observer every frame
    const countText = `✅ ${selected.size} 冊`;
    if (countEl.textContent !== countText) countEl.textContent = countText;
    clearBtn.disabled = selected.size === 0;
    delBtn.disabled = running || selected.size === 0;
    editBtn.disabled = running;
    for (const row of rows()) {
      const cb = row.querySelector("input.nbd-cb");
      if (cb) cb.checked = selected.has(rowId(row));
      row.classList.toggle("nbd-selected", selected.has(rowId(row)));
    }
  }

  // ---- 下の操作バー ----
  // アイコンだけの小さなボタン。何のボタンかは、指を乗せると出る説明(title)で分かる
  const countEl = el("span", { className: "nbd-count", title: "チェックを入れたノートの数" });
  const clearBtn = iconBtn("↩️", "外す", "チェックを全部外す");
  const reloadBtn = iconBtn("🔄", "更新", "一覧を読み込み直す");
  const editBtn = iconBtn("✏️", "題名・カテゴリ", "題名とカテゴリを一覧で直す");
  const delBtn = iconBtn("🗑️", "削除", "チェックしたノートを削除(確認画面が出ます)", "nbd-danger");
  const CARD_SEL = "mat-card.project-button-card:not(.featured-project-card)";
  const ITEM_SEL = CARD_SEL + ", table.project-table tr.mat-mdc-row";
  const sortSel = el("select", {
    className: "nbd-sel nbd-sort",
    title: "カードの並び順(この拡張の中だけの並びで、Gemini Notebook の中身は変えません)",
  });
  const bar = el("div", { id: "nbd-bar" }, [langNote(), countEl, clearBtn, reloadBtn, sortSel, editBtn, delBtn, manualBtn()]);
  editBtn.addEventListener("click", () => openEditor());
  reloadBtn.addEventListener("click", () => {
    if (!running) location.reload();
  });
  clearBtn.addEventListener("click", () => {
    selected.clear();
    refresh();
  });
  delBtn.addEventListener("click", openConfirm);
  document.body.appendChild(bar);

  // ---- カードの並び替えと、長押しドラッグでの入れ替え ----
  // Cards are reordered with the CSS `order` property only. The page's own DOM is never moved,
  // so Gemini Notebook keeps working normally and switching back to "いつもの順" restores it.
  let gridSort = "";
  let customOrder = []; // notebook ids in the order the user dragged them into
  sortSel.replaceChildren(
    ...SORTS.map(([v, t]) => el("option", { value: v, textContent: t })),
    el("option", { value: "custom", textContent: "✋ 自分の並び(長押しで動かす)" })
  );
  try {
    chrome.storage.local.get(["nbdGridSort", "nbdOrder"]).then((d) => {
      gridSort = d.nbdGridSort || "";
      customOrder = d.nbdOrder || [];
      sortSel.value = gridSort;
      applyGridOrder();
    });
  } catch (e) {
    /* 保存場所が使えない時は、いつもの順で始める */
  }
  function saveGrid() {
    try {
      chrome.storage.local.set({ nbdGridSort: gridSort, nbdOrder: customOrder });
    } catch (e) {
      /* 保存できなくても今の画面の並びは変わる */
    }
  }
  sortSel.addEventListener("change", () => {
    gridSort = sortSel.value;
    saveGrid();
    applyGridOrder();
  });

  const isOff = () => document.documentElement.classList.contains("nbd-off");
  const dispOf = (n) => getComputedStyle(n).display;
  // The grid item that holds the card. Gemini Notebook wraps cards in a `display: contents` div,
  // whose children are laid out by the grid above it, so the item is the child of that div
  // (2026-10-07 実測: mat-card < project-button < div.project-grid-container(contents) < project-grid(grid))
  const boxCache = new WeakMap();
  function cardBox(card) {
    const hit = boxCache.get(card);
    if (hit && hit.isConnected && hit.contains(card)) return hit;
    let box = null;
    for (let n = card; n && n !== document.body; n = n.parentElement) {
      if (dispOf(n) === "contents") continue;
      let p = n.parentElement;
      while (p && p !== document.body && dispOf(p) === "contents") p = p.parentElement;
      if (p && /grid|flex/.test(dispOf(p)) && p.querySelectorAll(CARD_SEL).length > 1) {
        box = n;
        break;
      }
    }
    boxCache.set(card, box);
    return box;
  }
  // Ids in the order they are on screen right now (top to bottom, left to right, no duplicates)
  function shownOrder() {
    const pos = (r) => r.getBoundingClientRect();
    const all = rows()
      .map((r) => ({ id: rowId(r), b: pos(r) }))
      .filter((x) => x.id && (x.b.width || x.b.height));
    all.sort((a, b) => a.b.top + window.scrollY - (b.b.top + window.scrollY) || a.b.left - b.b.left);
    const ids = [];
    for (const x of all) if (!ids.includes(x.id)) ids.push(x.id);
    return ids;
  }
  function sortedRows(list) {
    if (gridSort === "custom") {
      const pos = new Map(customOrder.map((id, i) => [id, i + 1]));
      // Notebooks made after the last drag have no saved place yet: keep them first, in the page's order
      return list.slice().sort((a, b) => (pos.get(rowId(a)) || 0) - (pos.get(rowId(b)) || 0));
    }
    return sortItems(list, gridSort, rowKey);
  }
  // Table rows cannot use CSS `order`, so they are moved inside their own tbody.
  // The page's original order is remembered so "いつもの順" can put it back.
  const tableOrig = new WeakMap(); // tbody -> rows in the page's order
  function applyTableOrder(trs) {
    const groups = new Map();
    for (const tr of trs) {
      const tb = tr.parentElement;
      if (!groups.has(tb)) groups.set(tb, []);
      groups.get(tb).push(tr);
    }
    for (const [tb, list] of groups) {
      let want;
      if (!gridSort || isOff()) {
        const orig = tableOrig.get(tb);
        if (!orig) continue; // never moved: already in the page's order
        want = orig.filter((r) => r.parentElement === tb);
        for (const r of list) if (!want.includes(r)) want.unshift(r);
        tableOrig.delete(tb);
      } else {
        if (!tableOrig.has(tb)) tableOrig.set(tb, list.slice());
        want = sortedRows(list);
      }
      // Move only when the order differs: a move is a DOM change, and an idle page must stay idle
      const now = [...tb.children].filter((c) => want.includes(c));
      if (now.every((r, i) => r === want[i])) continue;
      for (const r of want) tb.appendChild(r);
    }
  }
  function applyGridOrder() {
    const all = rows();
    const cards = all.filter(isCard);
    const trs = all.filter((r) => !isCard(r));
    sortSel.style.display = all.length ? "" : "none";
    applyTableOrder(trs);
    if (!gridSort || isOff()) {
      for (const b of document.querySelectorAll("[data-nbd-ord]")) {
        b.style.order = "";
        delete b.dataset.nbdOrd;
      }
      return;
    }
    // Start at 1 so other items in the same grid (order 0) stay in front
    sortedRows(cards).forEach((c, i) => {
      const box = cardBox(c);
      if (!box) return;
      const v = String(i + 1);
      if (box.style.order !== v) box.style.order = v;
      if (!box.dataset.nbdOrd) box.dataset.nbdOrd = "1";
    });
  }

  // Long-press (0.4 s) a card or a table row, then drop it on another one to put it in that place
  let drag = null;
  let swallowClick = false;
  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    drag.card.classList.remove("nbd-lifted");
    if (drag.target) drag.target.classList.remove("nbd-drop-to");
    document.documentElement.classList.remove("nbd-dragging");
    drag = null;
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || running || isOff()) return;
      const card = e.target.closest && e.target.closest(ITEM_SEL);
      if (!card || !rowId(card) || e.target.closest(".nbd-cb-wrap, button, input, select")) return;
      endDrag();
      const d = { card, x: e.clientX, y: e.clientY, on: false, target: null };
      d.timer = setTimeout(() => {
        d.on = true;
        card.classList.add("nbd-lifted");
        document.documentElement.classList.add("nbd-dragging");
      }, 400);
      drag = d;
    },
    true
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!drag) return;
      if (!drag.on) {
        // Moved before the long-press finished: it is an ordinary click or scroll
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) endDrag();
        return;
      }
      e.preventDefault();
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const t = under && under.closest(ITEM_SEL);
      const target = t && t !== drag.card && rowId(t) ? t : null;
      if (target !== drag.target) {
        if (drag.target) drag.target.classList.remove("nbd-drop-to");
        if (target) target.classList.add("nbd-drop-to");
        drag.target = target;
      }
    },
    true
  );
  document.addEventListener(
    "pointerup",
    () => {
      if (!drag) return;
      const { on, card, target } = drag;
      endDrag();
      if (!on) return;
      swallowClick = true; // the release after a long-press must not open the notebook
      setTimeout(() => (swallowClick = false), 400);
      if (!target) return;
      const ids = shownOrder();
      const from = rowId(card);
      const to = rowId(target);
      const fi = ids.indexOf(from);
      const ti = ids.indexOf(to);
      if (fi < 0 || ti < 0) return;
      ids.splice(fi, 1);
      ids.splice(ti, 0, from); // takes the target's place; the target shifts by one
      customOrder = ids;
      gridSort = "custom";
      sortSel.value = "custom";
      saveGrid();
      applyGridOrder();
    },
    true
  );
  document.addEventListener("pointercancel", endDrag, true);
  document.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  // Links and images are natively draggable; that would steal the long-press drag
  document.addEventListener(
    "dragstart",
    (e) => {
      if (drag && e.target.closest && e.target.closest(ITEM_SEL)) e.preventDefault();
    },
    true
  );

  // ---- 確認画面 ----
  function openConfirm() {
    if (running || selected.size === 0) return;
    const ids = [...selected];
    const list = el("ol", { className: "nbd-list" });
    const items = new Map();
    const titles = new Map();
    for (const id of ids) {
      const s = SUMMARIES[id];
      const title = titleOf(id);
      titles.set(id, title);
      const li = el("li", {}, [el("div", { className: "nbd-li-title", textContent: title })]);
      if (s && s.ja) li.append(el("div", { className: "nbd-li-sum", textContent: s.ja }));
      items.set(id, li);
      list.append(li);
    }
    const prog = el("div", { className: "nbd-progress", hidden: true });
    const cancel = el("button", { type: "button", textContent: "やめる" });
    const go = el("button", { type: "button", className: "nbd-danger", textContent: `${ids.length} 冊を削除する` });
    const ov = el("div", { id: "nbd-overlay" }, [
      el("div", { className: "nbd-modal" }, [
        el("h2", { textContent: `この ${ids.length} 冊を削除します` }),
        el("p", { className: "nbd-warn", textContent: "削除すると元に戻せません。題名を確かめてから押してください。" }),
        list,
        prog,
        el("div", { className: "nbd-actions" }, [cancel, go]),
      ]),
    ]);
    document.body.append(ov);

    cancel.addEventListener("click", () => {
      if (running) {
        stopRequested = true;
        cancel.textContent = "今の1冊が終わったら止めます…";
        cancel.disabled = true;
      } else {
        ov.remove();
      }
    });
    go.addEventListener("click", () => runDelete(ids, { ov, items, titles, prog, cancel, go }));
  }

  // ---- 削除の実行 ----
  // 一覧は操作のたびに並び順が変わり、行の入れ物が別のノートに使い回されることがある。
  // そのため押す直前に毎回「この行は狙ったIDと題名か」を確かめ、違えば押さずに止める。
  function sameRow(row, id, title) {
    return row.isConnected && rowId(row) === id && rowTitle(row) === title;
  }

  // 削除の直後は一覧が組み直されるので、行の数が1.5秒変わらなくなるまで待つ
  async function waitListSettled(timeout = 15000) {
    const end = Date.now() + timeout;
    let last = -1;
    let since = Date.now();
    while (Date.now() < end) {
      const n = rows().length;
      if (n !== last) {
        last = n;
        since = Date.now();
      } else if (n > 0 && Date.now() - since >= 1500) {
        return;
      }
      await sleep(200);
    }
  }

  async function deleteOne(id, title) {
    await waitListSettled();
    const row = await waitFor(() => findRow(id), 15000, 300);
    if (!row) throw new Error("一覧に見当たりません(⟳ 一覧を更新 の後にやり直してください)");
    if (rowTitle(row) !== title) throw new Error("題名が確認画面と違うので押しませんでした");
    row.scrollIntoView({ block: "center" });
    await sleep(300);
    if (!sameRow(row, id, title)) throw new Error("並び順が変わったので押しませんでした");

    const more =
      row.querySelector('button[aria-label="プロジェクトの操作メニュー"]') ||
      [...row.querySelectorAll(".actions-column button")].find((b) => b.textContent.includes("more_vert"));
    if (!more) throw new Error("︙ ボタンが見つかりません");
    more.click();

    const item = await waitFor(() =>
      [...document.querySelectorAll(".cdk-overlay-container .mat-mdc-menu-item")].find(
        (b) => b.className.includes("delete") || b.textContent.trim().endsWith("削除")
      )
    );
    if (!item) throw new Error("メニューに「削除」が出ませんでした");
    if (!sameRow(row, id, title)) throw new Error("メニューを開いた間に行が入れ替わったので押しませんでした");
    item.click();

    const dlg = await waitFor(() => document.querySelector("mat-dialog-container"));
    if (!dlg) throw new Error("確認画面が出ませんでした");
    const ok = await waitFor(() =>
      [...dlg.querySelectorAll("button")].find((b) => b.textContent.trim() === "削除" && !b.disabled)
    );
    if (!ok) throw new Error("確認画面に「削除」ボタンがありません");
    ok.click();

    // 一覧から本当に消えたかを見てから成功とする
    const gone = await waitFor(() => !findRow(id), 20000, 300);
    await waitFor(() => !document.querySelector("mat-dialog-container"), 5000);
    if (!gone) throw new Error("押しましたが、一覧から消えませんでした");
  }

  async function runDelete(ids, ui) {
    const { ov, items, titles, prog, cancel, go } = ui;
    running = true;
    stopRequested = false;
    refresh();
    go.disabled = true;
    cancel.textContent = "途中で止める";
    prog.hidden = false;

    let okN = 0;
    const failed = [];
    const doneIds = new Set();
    for (let i = 0; i < ids.length; i++) {
      if (stopRequested) break;
      const id = ids[i];
      const li = items.get(id);
      li.className = "nbd-doing";
      li.scrollIntoView({ block: "nearest" });
      prog.textContent = `${i + 1} / ${ids.length} 冊目を削除中…`;
      try {
        await deleteOne(id, titles.get(id));
        li.className = "nbd-done";
        selected.delete(id);
        doneIds.add(id);
        okN++;
      } catch (e) {
        closeMenus();
        li.className = "nbd-fail";
        li.append(el("div", { className: "nbd-li-why", textContent: "失敗: " + e.message }));
        failed.push(id);
        await sleep(800);
      }
      await sleep(700);
    }

    running = false;
    const left = ids.length - okN - failed.length;
    prog.textContent =
      `終わりました。削除 ${okN} 冊` +
      (failed.length ? ` / 失敗 ${failed.length} 冊(赤い行)` : "") +
      (left ? ` / 止めたので未処理 ${left} 冊` : "") +
      `。一覧は今 ${rows().length} 冊です。`;
    cancel.disabled = false;
    cancel.textContent = "閉じる";
    cancel.addEventListener("click", () => ov.remove());
    go.remove();
    const retryIds = ids.filter((id) => !doneIds.has(id));
    if (retryIds.length) {
      const retry = el("button", { type: "button", className: "nbd-danger", textContent: `残った ${retryIds.length} 冊をもう一度` });
      retry.addEventListener("click", () => {
        ov.remove();
        selected.clear();
        retryIds.forEach((id) => selected.add(id));
        refresh();
        openConfirm();
      });
      cancel.after(retry);
    }
    refresh();
  }

  // ---- 題名・カテゴリを直す(1つの画面) ----
  // 題名の形: 「絵文字【カテゴリ】題名の本体」。行ごとにカテゴリ(選ぶ)と本体(書く)を直せる。
  let categories = [];
  // ひらがな・カタカナ・漢字が1文字も無い題名を「英語の題名」とみなす(NotebookLM が最初に付ける題名)
  const JA_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

  function splitTitle(t) {
    const m = t.match(/^\s*((?:\p{Extended_Pictographic}️?\s*)*)【([^】]*)】\s*(.*)$/u);
    return m ? { cat: m[2].trim(), base: m[3].trim() } : { cat: "", base: t.trim() };
  }
  function joinTitle(cat, base) {
    return cat ? `${cat.emoji || ""}【${cat.name}】${base}` : base;
  }
  function parseCats(text) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.match(/^((?:\p{Extended_Pictographic}️?)+)\s*(.+)$/u);
        const name = (m ? m[2] : s).replace(/[【】]/g, "").trim();
        return { emoji: m ? m[1] : "", name };
      })
      .filter((c) => c.name);
  }
  function catsToText(cs) {
    return cs.map((c) => (c.emoji ? c.emoji + " " : "") + c.name).join("\n");
  }
  const catLabel = (c) => `${c.emoji ? c.emoji + " " : ""}【${c.name}】`;
  // 今の題名に付いている「絵文字【カテゴリ】」を拾う
  function guessCats() {
    const seen = new Map();
    for (const r of rows()) {
      const m = rowTitle(r).match(/^\s*((?:\p{Extended_Pictographic}️?)*)\s*【([^】]+)】/u);
      if (m && !seen.has(m[2])) seen.set(m[2], { emoji: m[1] || "", name: m[2] });
    }
    return [...seen.values()];
  }
  // 足りないカテゴリを後ろに足す(今の題名にあるカテゴリを選択肢から落とさない)
  function mergeCats(base, extra) {
    const out = [...base];
    for (const c of extra) if (!out.some((x) => x.name === c.name)) out.push(c);
    return out;
  }
  function saveCats(cs) {
    try {
      chrome.storage.local.set({ nbdCategories: cs });
    } catch (e) {
      /* 保存できなくても今回の操作は続けられる */
    }
  }

  async function openEditor() {
    if (running) return;
    let saved = [];
    try {
      saved = (await chrome.storage.local.get("nbdCategories")).nbdCategories || [];
    } catch (e) {
      /* 保存場所が使えない時は題名から拾った分だけで続ける */
    }
    categories = mergeCats(saved, guessCats());

    const ta = el("textarea", { className: "nbd-cats", rows: 3, value: catsToText(categories) });
    const bulkSel = el("select", { className: "nbd-sel" });
    const bulkBtn = el("button", { type: "button" });
    const filter = el("input", { type: "search", className: "nbd-filter", placeholder: "🔍 題名やカテゴリで絞り込む(例: SNS)" });
    const list = el("ol", { className: "nbd-list" });
    const items = [];
    let m = null;

    const catByName = (n) => categories.find((c) => c.name === n) || null;
    const fillSelect = (sel, name) => {
      sel.replaceChildren(
        el("option", { value: "", textContent: "(カテゴリなし)" }),
        ...categories.map((c) => el("option", { value: c.name, textContent: catLabel(c) }))
      );
      sel.value = categories.some((c) => c.name === name) ? name : "";
    };
    const setBulkText = () => (bulkBtn.textContent = `✅ チェックした ${selected.size} 冊にこのカテゴリを付ける`);
    const updateGo = () => {
      m.go.textContent = `${plan.size} 冊を書き換える`;
      m.go.disabled = plan.size === 0;
      savePlan();
      decorate();
    };
    // 1行ぶんの「カテゴリ+本体」から新しい題名を作り、変わっていれば予定に入れる
    const sync = (x) => {
      const base = x.inp.value.trim();
      const to = base ? joinTitle(catByName(x.sel.value), base) : x.from;
      if (to !== x.from) {
        plan.set(x.id, { from: x.from, to });
        x.li.classList.add("nbd-changed");
        x.preview.textContent = "→ " + to;
      } else {
        plan.delete(x.id);
        x.li.classList.remove("nbd-changed");
        x.preview.textContent = "";
      }
    };

    const seen = new Set(); // 「すべて」の画面では、固定したノートが2か所に出る
    for (const r of rows()) {
      const id = rowId(r);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const from = rowTitle(r);
      const p = plan.get(id);
      const parts = splitTitle(p ? p.to : from);
      const sel = el("select", { className: "nbd-sel" });
      const inp = el("input", { type: "text", className: "nbd-edit", value: parts.base });
      const back = el("button", { type: "button", className: "nbd-x", textContent: "↩️", title: "この行を元に戻す" });
      const preview = el("div", { className: "nbd-preview" });
      // どんなノートかの1行(作ってある日本語の概要をそのまま出す。ここで AI は使わない)
      const sum = (SUMMARIES[id] && SUMMARIES[id].ja) || "";
      // Same selection as the checkboxes on the list, so the bulk-category and delete buttons see it
      const cb = el("input", { type: "checkbox", className: "nbd-cb", checked: selected.has(id), title: "このノートを選ぶ" });
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(id);
        else selected.delete(id);
        refresh();
        paintSel();
      });
      const li = el("li", { dataset: { id } }, [
        el("label", { className: "nbd-li-head" }, [cb, el("span", { className: "nbd-li-sum", textContent: from })]),
        sum ? el("div", { className: "nbd-li-about", textContent: "💬 " + sum }) : null,
        el("div", { className: "nbd-edit-row" }, [sel, inp, back]),
        preview,
      ]);
      // 【】が付いた題名(【SNS】3_LinkedIn など)は自分で付けた題名なので、英語の題名に数えない
      const english = !JA_CHAR.test(from) && !/【[^】]*】/.test(from);
      if (english) li.classList.add("nbd-english");
      const x = { id, from, li, sel, inp, preview, sum, english, cb, date: rowDate(r) };
      fillSelect(sel, parts.cat);
      sel.addEventListener("change", () => {
        sync(x);
        updateGo();
      });
      inp.addEventListener("input", () => {
        sync(x);
        updateGo();
      });
      back.addEventListener("click", () => {
        const o = splitTitle(from);
        fillSelect(sel, o.cat);
        inp.value = o.base;
        sync(x);
        updateGo();
      });
      if (p) sync(x);
      list.append(li);
      items.push(x);
    }

    // カテゴリの一覧を書き足したら、全部の行の選択肢に反映する。
    // 一覧から消した名前でも、いま選ばれている行があれば選択肢に残す(勝手に題名を変えない)
    ta.addEventListener("change", () => {
      const inUse = items.map((x) => catByName(x.sel.value)).filter(Boolean);
      categories = mergeCats(parseCats(ta.value), inUse);
      saveCats(parseCats(ta.value));
      const bulkName = bulkSel.value;
      fillSelect(bulkSel, bulkName);
      for (const x of items) {
        fillSelect(x.sel, x.sel.value);
        if (plan.has(x.id)) sync(x); // 予定のある行は、絵文字を変えた時などに新しい形へ
      }
      updateGo();
    });

    bulkBtn.addEventListener("click", () => {
      for (const x of items) {
        if (!selected.has(x.id)) continue;
        x.sel.value = bulkSel.value;
        sync(x);
      }
      selected.clear();
      refresh();
      paintSel();
      updateGo();
    });

    // 絞り込み: 文字での絞り込みと「英語の題名だけ」を重ねて使える
    let englishOnly = false;
    const engCount = items.filter((x) => x.english).length;
    const engBtn = el("button", { type: "button", className: "nbd-toggle-btn" });
    const paintEng = () => {
      engBtn.textContent = englishOnly ? `🔤 英語の題名だけ表示中(${engCount} 冊)・押すと全部に戻る` : `🔤 英語の題名だけ(${engCount} 冊)`;
      engBtn.classList.toggle("nbd-on", englishOnly);
    };
    const applyFilter = () => {
      const q = filter.value.trim().toLowerCase();
      for (const x of items) {
        const hay = (x.from + " " + x.inp.value + " " + x.sel.value + " " + x.sum).toLowerCase();
        const hit = (!q || hay.includes(q)) && (!englishOnly || x.english);
        x.li.style.display = hit ? "" : "none";
      }
    };
    filter.addEventListener("input", applyFilter);
    engBtn.addEventListener("click", () => {
      englishOnly = !englishOnly;
      paintEng();
      applyFilter();
    });
    paintEng();

    // チェック・並び替え・削除
    const allCb = el("input", { type: "checkbox", className: "nbd-cb" });
    const sortBox = el("select", { className: "nbd-sel" }, SORTS.map(([v, t]) => el("option", { value: v, textContent: t })));
    const delSelBtn = el("button", { type: "button", className: "nbd-danger" });
    const shown = () => items.filter((x) => x.li.style.display !== "none");
    function paintSel() {
      for (const x of items) x.cb.checked = selected.has(x.id);
      const vis = shown();
      const on = vis.filter((x) => selected.has(x.id)).length;
      allCb.checked = vis.length > 0 && on === vis.length;
      allCb.indeterminate = on > 0 && on < vis.length;
      delSelBtn.textContent = `🗑️ チェックした ${selected.size} 冊を削除`;
      delSelBtn.disabled = running || selected.size === 0;
      setBulkText();
    }
    allCb.addEventListener("change", () => {
      // Only the rows visible under the current filter
      for (const x of shown()) {
        if (allCb.checked) selected.add(x.id);
        else selected.delete(x.id);
      }
      refresh();
      paintSel();
    });
    sortBox.addEventListener("change", () => {
      // Sort by the title as it will look (planned new title if any), the same way the list's cards sort
      const sorted = sortItems(items, sortBox.value, (x) => ({ title: (plan.get(x.id) || {}).to || x.from, date: x.date }));
      list.append(...sorted.map((x) => x.li));
    });
    // The delete itself goes through the usual confirmation screen (titles listed, cannot be undone)
    delSelBtn.addEventListener("click", () => {
      if (running || selected.size === 0) return;
      m.ov.remove();
      openConfirm();
    });
    filter.addEventListener("input", paintSel);
    engBtn.addEventListener("click", paintSel);

    fillSelect(bulkSel, categories[0] ? categories[0].name : "");
    setBulkText();
    m = openModal(
      "✏️ 題名・カテゴリを直す",
      [
        el("p", {
          className: "nbd-help",
          textContent:
            "行ごとに、左でカテゴリを選び、右で題名を書き直せます。変えた行は黄色になり「→ 新しい題名」が出ます。最後に右下のボタンでまとめて書き換えます。閉じても直した分は残ります。",
        }),
        el("label", { className: "nbd-field" }, ["🏷️ カテゴリの一覧(1行に1つ「絵文字 名前」。書き足すと選択肢に増えます)", ta]),
        el("div", { className: "nbd-row" }, [bulkSel, bulkBtn]),
        el("div", { className: "nbd-row" }, [filter, engBtn]),
        el("div", { className: "nbd-row" }, [
          el("label", { className: "nbd-all", title: "いま表示している行を全部選ぶ/外す" }, [allCb, "表示中を全部選ぶ"]),
          sortBox,
          delSelBtn,
        ]),
        list,
      ],
      "書き換える"
    );
    m.cancel.textContent = "閉じる(直した分は残ります)";
    updateGo();
    paintSel();
    m.cancel.addEventListener("click", () => {
      if (running) {
        stopRequested = true;
        m.cancel.textContent = "今の1冊が終わったら止めます…";
        m.cancel.disabled = true;
      }
    });
    m.go.addEventListener("click", () => runRename(m, list));
  }

  function cancelDialog() {
    const ds = document.querySelectorAll("mat-dialog-container");
    const d = ds.length ? ds[ds.length - 1] : null;
    const b = d && [...d.querySelectorAll("button")].find((x) => x.textContent.trim() === "キャンセル");
    if (b) b.click();
    else closeMenus();
  }

  async function renameOne(id, from, to) {
    await waitListSettled();
    const row = await waitFor(() => findRow(id), 15000, 300);
    if (!row) throw new Error("一覧に見当たりません");
    const now = rowTitle(row);
    if (now === to) return; // もう書き換わっている
    if (now !== from) throw new Error("題名が予定を作った時と違うので変えませんでした");
    row.scrollIntoView({ block: "center" });
    await sleep(300);
    if (!sameRow(row, id, from)) throw new Error("並び順が変わったので押しませんでした");

    const more =
      row.querySelector('button[aria-label="プロジェクトの操作メニュー"]') ||
      [...row.querySelectorAll(".actions-column button")].find((b) => b.textContent.includes("more_vert"));
    if (!more) throw new Error("︙ ボタンが見つかりません");
    more.click();
    const item = await waitFor(() =>
      [...document.querySelectorAll(".cdk-overlay-container .mat-mdc-menu-item")].find(
        (b) => b.className.includes("edit") || b.textContent.includes("タイトルを編集")
      )
    );
    if (!item) throw new Error("メニューに「タイトルを編集」が出ませんでした");
    if (!sameRow(row, id, from)) throw new Error("メニューを開いた間に行が入れ替わったので押しませんでした");
    item.click();

    const dlg = await waitFor(() => {
      const ds = document.querySelectorAll("mat-dialog-container");
      return ds.length ? ds[ds.length - 1] : null;
    });
    const inp = dlg && (await waitFor(() => dlg.querySelector("input.title-input")));
    if (!inp) throw new Error("題名の入力欄が出ませんでした");
    // 入力欄は空で現れ、少し遅れて今の題名が入る(2026-10-04 実測: 約0.02秒後)。入るまで待ってから照合する
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const filled = await waitFor(() => inp.value.trim() !== "", 5000, 50);
    if (!filled || norm(inp.value) !== norm(from)) {
      cancelDialog();
      await waitFor(() => !document.querySelector("mat-dialog-container"), 5000);
      throw new Error(`開いた窓の題名が違うので変えませんでした(窓の題名: ${inp.value.slice(0, 30) || "空"})`);
    }
    inp.focus();
    inp.value = to;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    const save = [...dlg.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存");
    if (!save || save.disabled) {
      cancelDialog();
      await waitFor(() => !document.querySelector("mat-dialog-container"), 5000);
      throw new Error("「保存」が押せませんでした");
    }
    save.click();
    await waitFor(() => !document.querySelector("mat-dialog-container"), 8000);
    const ok = await waitFor(() => {
      const r = findRow(id);
      return r && rowTitle(r) === to;
    }, 15000, 300);
    if (!ok) throw new Error("保存を押しましたが、題名が変わりませんでした");
  }

  async function runRename(m, list) {
    const ids = [...plan.keys()];
    running = true;
    stopRequested = false;
    m.cancel.dataset.running = "1";
    m.go.disabled = true;
    m.cancel.textContent = "途中で止める";
    m.prog.hidden = false;
    refresh();
    let okN = 0;
    let ngN = 0;
    for (let i = 0; i < ids.length; i++) {
      if (stopRequested) break;
      const id = ids[i];
      const p = plan.get(id);
      const li = list.querySelector(`li[data-id="${id}"]`);
      if (li) {
        li.className = "nbd-doing";
        li.scrollIntoView({ block: "nearest" });
      }
      m.prog.textContent = `${i + 1} / ${ids.length} 冊目を書き換え中…`;
      try {
        await renameOne(id, p.from, p.to);
        plan.delete(id);
        savePlan();
        if (li) li.className = "nbd-done";
        okN++;
      } catch (e) {
        closeMenus();
        cancelDialog();
        if (li) {
          li.className = "nbd-fail";
          li.append(el("div", { className: "nbd-li-why", textContent: "失敗: " + e.message }));
        }
        ngN++;
        await sleep(800);
      }
      await sleep(500);
    }
    running = false;
    delete m.cancel.dataset.running;
    m.cancel.disabled = false;
    m.cancel.textContent = "閉じる";
    m.prog.textContent =
      `終わりました。書き換え ${okN} 冊` +
      (ngN ? ` / 失敗 ${ngN} 冊(赤い行。予定に残っているので、もう一度押せばやり直せます)` : "") +
      (plan.size - ngN > 0 ? ` / 止めたので未処理 ${plan.size - ngN} 冊` : "");
    m.go.textContent = `残り ${plan.size} 冊をもう一度`;
    m.go.disabled = plan.size === 0;
    refresh();
    decorate();
  }

  // ---- 画面の変化を見張って書き足し直す ----
  // Throttled: Gemini Notebook rewrites the DOM constantly while streaming or scrolling long answers,
  // so run at most every 300 ms instead of every frame
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      decorate();
      refresh();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  decorate();
  refresh();
})();
