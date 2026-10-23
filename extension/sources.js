// ノートの中の画面(/notebook/…)で、左の「ソース」一覧の重複をまとめて消す。
// 同じ題名の資料が2件以上あれば、上の1件を残して残りを「︙ → ソースを削除」で消す。
(() => {
  "use strict";

  // 貼り付けた文章や Deep Research のレポートは、中身が違っても同じ題名になる。
  // 重複と決めつけず、最初はチェックを外しておく(2026-10-04 実測: 「Deep Research レポート:…」3件は
  // CLI の重複判定では別物扱いだった)
  const GENERIC =
    /^(テキスト|貼り付けたテキスト|コピーしたテキスト|貼り付けられたテキスト|テキストを貼り付けました|音声メモ|Pasted text|Copied text)$|^(Deep Research|レポート)/i;
  let busy = false;
  let stop = false;

  const onNotebook = () => /^\/notebook\//.test(location.pathname);
  const srcRows = () => [...document.querySelectorAll("div.single-source-container")];
  function srcTitle(r) {
    const b = r.querySelector("button.source-stretched-button");
    const t = (b && b.getAttribute("aria-label")) || (r.querySelector(".source-title") || {}).textContent || "";
    return t.trim();
  }
  const countOf = (title) => srcRows().filter((r) => srcTitle(r) === title).length;
  function groups() {
    const m = new Map();
    for (const r of srcRows()) {
      const t = srcTitle(r);
      if (!t) continue;
      m.set(t, (m.get(t) || 0) + 1);
    }
    return [...m].filter(([, n]) => n > 1).map(([title, n]) => ({ title, n }));
  }

  const btn = iconBtn("🧹", "重複を消す", "同じ題名の資料をまとめて消す(確認画面が出ます)", "nbd-danger");
  const info = el("span", { className: "nbd-count", title: "同じ題名で重なっている資料の数" });
  const bar = el("div", { id: "nbd-srcbar" }, [langNote(), info, btn, manualBtn()]);
  btn.addEventListener("click", openDup);
  document.body.append(bar);

  function update() {
    if (!onNotebook() || !srcRows().length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    const g = groups();
    const extra = g.reduce((a, x) => a + x.n - 1, 0);
    const text = `📚 重複 ${extra} 件`;
    if (info.textContent !== text) info.textContent = text;
    btn.disabled = busy || !extra;
  }

  function openDup() {
    if (busy) return;
    const g = groups();
    if (!g.length) return;
    const list = el("ol", { className: "nbd-list" });
    const checks = new Map();
    for (const x of g) {
      const generic = GENERIC.test(x.title);
      const cb = el("input", { type: "checkbox", checked: !generic });
      checks.set(x.title, cb);
      const li = el("li", { dataset: { title: x.title } }, [
        el("label", { className: "nbd-li-title" }, [cb, ` ${x.title}`]),
        el("div", { className: "nbd-li-sum", textContent: `${x.n} 件 → 1 件にする(上の1件を残し、${x.n - 1} 件を消す)` }),
      ]);
      if (generic) {
        li.classList.add("nbd-unmarked");
        li.append(
          el("div", {
            className: "nbd-li-why",
            textContent: "⚠ 貼り付けた文章や Deep Research のレポートは、中身が違っても同じ題名になります。中身を確かめてから、消す時だけチェックを入れてください",
          })
        );
      }
      list.append(li);
    }
    const m = openModal(
      "同じ題名の資料をまとめて消します",
      [
        el("p", { className: "nbd-warn", textContent: "消した資料は元に戻せません。チェックの付いた題名だけを消します。" }),
        list,
      ],
      "チェックした重複を消す"
    );
    m.cancel.addEventListener("click", () => {
      if (busy) {
        stop = true;
        m.cancel.textContent = "今の1件が終わったら止めます…";
        m.cancel.disabled = true;
      }
    });
    m.go.addEventListener("click", () => run(m, list, checks));
  }

  async function deleteOneCopy(title) {
    const before = countOf(title);
    if (before < 2) return false;
    const rs = srcRows().filter((r) => srcTitle(r) === title);
    const target = rs[rs.length - 1]; // 下にある方を消す
    target.scrollIntoView({ block: "center" });
    await sleep(250);
    if (!target.isConnected || srcTitle(target) !== title) throw new Error("一覧が動いたので押しませんでした");
    const more =
      target.querySelector('button[aria-label="もっと見る"]') ||
      [...target.querySelectorAll("button")].find((b) => b.textContent.includes("more_vert"));
    if (!more) throw new Error("︙ ボタンが見つかりません");
    more.click();
    const item = await waitFor(() =>
      [...document.querySelectorAll(".cdk-overlay-container .mat-mdc-menu-item")].find(
        (b) => b.className.includes("delete-source") || b.textContent.includes("ソースを削除")
      )
    );
    if (!item) throw new Error("メニューに「ソースを削除」が出ませんでした");
    if (!target.isConnected || srcTitle(target) !== title) {
      closeMenus();
      throw new Error("メニューを開いた間に一覧が動いたので押しませんでした");
    }
    item.click();
    // 確認の小窓が出る場合は「削除」を押す(出ない作りでも動くようにしてある)
    const dlg = await waitFor(() => document.querySelector("mat-dialog-container"), 2500);
    if (dlg) {
      const ok = await waitFor(() =>
        [...dlg.querySelectorAll("button")].find((b) => /^(削除|削除する|Delete)$/.test(b.textContent.trim()) && !b.disabled)
      );
      if (!ok) throw new Error("確認の小窓に「削除」ボタンがありません");
      ok.click();
    }
    const gone = await waitFor(() => countOf(title) < before, 15000, 300);
    await waitFor(() => !document.querySelector("mat-dialog-container"), 5000);
    if (!gone) throw new Error("押しましたが、資料の数が減りませんでした");
    return true;
  }

  async function run(m, list, checks) {
    busy = true;
    stop = false;
    m.cancel.dataset.running = "1";
    m.go.disabled = true;
    m.cancel.textContent = "途中で止める";
    m.prog.hidden = false;
    let okN = 0;
    let ngN = 0;
    const titles = [...checks].filter(([, cb]) => cb.checked).map(([t]) => t);
    for (const title of titles) {
      if (stop) break;
      const li = [...list.children].find((x) => x.dataset.title === title);
      if (li) {
        li.className = "nbd-doing";
        li.scrollIntoView({ block: "nearest" });
      }
      try {
        while (!stop && countOf(title) > 1) {
          m.prog.textContent = `「${title.slice(0, 30)}」の重複を消しています… (これまでに ${okN} 件)`;
          if (await deleteOneCopy(title)) okN++;
          await sleep(600);
        }
        if (li) li.className = "nbd-done";
      } catch (e) {
        closeMenus();
        ngN++;
        if (li) {
          li.className = "nbd-fail";
          li.append(el("div", { className: "nbd-li-why", textContent: "失敗: " + e.message }));
        }
        await sleep(800);
      }
    }
    busy = false;
    delete m.cancel.dataset.running;
    m.cancel.disabled = false;
    m.cancel.textContent = "閉じる";
    m.go.remove();
    const left = groups().reduce((a, x) => a + x.n - 1, 0);
    m.prog.textContent =
      `終わりました。消した重複 ${okN} 件` + (ngN ? ` / 失敗 ${ngN} 題(赤い行)` : "") + `。いま残っている重複は ${left} 件です。`;
    update();
  }

  // Throttled to every 300 ms (see content.js)
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });
  update();
})();
