// ==UserScript==
// @name         eMonev Bulk Kehadiran
// @namespace    auto-emonev
// @version      1.1.1
// @description  Bulk submit kehadiran pegawai/staf dan struktural di eMonev: centang yang mau disubmit, kirim sekaligus.
// @match        *://emonev.una.ac.id/gjm/kehadiran_pegawai*
// @match        *://emonev.una.ac.id/gjm/kehadiran_struktural*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  console.info('[aeb] Bulk Kehadiran v1.1.1 dimuat di', location.href);
  if (document.getElementById('aeb-fab')) return;

  // pegawai: daftar dikelola sendiri (localStorage), dikirim sebagai nama+unit
  // struktural: daftar jabatan diambil dari <select name="struktural_id"> di halaman
  const MODE = /kehadiran_struktural/i.test(location.pathname) ? 'struktural' : 'pegawai';
  const MODES = {
    pegawai: {
      title: 'Bulk Kehadiran Pegawai',
      fallbackStatuses: ['hadir', 'terlambat', 'izin', 'tidak_hadir'],
      formMarker: '[name="nama"]',
      selectionKey: 'aeb:lastSelection',
      fields: (p) => ({ nama: p.nama, unit: p.unit }),
    },
    struktural: {
      title: 'Bulk Kehadiran Struktural',
      fallbackStatuses: ['hadir', 'terlambat', 'tidak_hadir'],
      formMarker: '[name="struktural_id"]',
      selectionKey: 'aeb:struktural:lastSelection',
      fields: (p) => ({ struktural_id: p.id }),
    },
  };
  const M = MODES[MODE];
  const DELAY_MS = 700;
  const LOG_LIMIT = 500;
  const KEY = {
    pegawai: 'aeb:pegawai',
    selection: M.selectionKey,
    log: 'aeb:log',
    dryRun: 'aeb:dryRun',
  };

  // opsi status (value + label) diambil dari <select name="status"> di form asli supaya nilainya pasti valid
  const STATUS_LABEL = {};
  const STATUSES = (() => {
    [...document.querySelectorAll(`form ${M.formMarker}`)]
      .map((el) => el.closest('form'))
      .flatMap((f) => [...f.querySelectorAll('select[name="status"] option')])
      .filter((o) => o.value)
      .forEach((o) => (STATUS_LABEL[o.value] = o.textContent.trim() || o.value));
    const opts = Object.keys(STATUS_LABEL);
    return opts.length ? opts : M.fallbackStatuses;
  })();
  const statusLabel = (v) => STATUS_LABEL[v] || v;
  const STRUKTURAL = [...document.querySelectorAll('select[name="struktural_id"] option')]
    .filter((o) => o.value)
    .map((o) => ({ id: o.value, nama: o.textContent.trim(), unit: '' }));

  // ---------- storage ----------
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[aeb] gagal simpan', key, e);
    }
  }

  // ---------- state ----------
  let pegawai = load(KEY.pegawai, []);
  const checked = new Set(load(KEY.selection, []));
  // status/menit/keterangan per baris hanya untuk sesi ini; default hadir
  const rowState = {};
  let log = load(KEY.log, []);
  let dryRun = load(KEY.dryRun, true);
  let running = false;
  let stopRequested = false;
  let lastResults = []; // [{id, ok, msg}]
  let editingId = null;

  // daftar yang ditampilkan di tab Submit
  function items() {
    return MODE === 'struktural' ? STRUKTURAL : pegawai;
  }
  function rs(id) {
    if (!rowState[id]) rowState[id] = { status: STATUSES.includes('hadir') ? 'hadir' : STATUSES[0], menit: 0, keterangan: '' };
    return rowState[id];
  }
  function persistPegawai() {
    save(KEY.pegawai, pegawai);
  }
  function persistSelection() {
    save(KEY.selection, [...checked].filter((id) => items().some((p) => p.id === id)));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- page integration ----------
  function findForm() {
    const marker = document.querySelector(`form ${M.formMarker}`);
    return marker ? marker.closest('form') : document.querySelector('input[name="csrf"]')?.closest('form') || null;
  }
  function readCsrf(doc) {
    const el = doc.querySelector('input[name="csrf"]');
    return el ? el.value : null;
  }
  function submitUrl() {
    const form = findForm();
    const action = form ? form.getAttribute('action') || '' : '';
    const url = new URL(action, location.href);
    url.hash = '';
    return url.toString();
  }

  function extractMessage(doc, html) {
    const parts = [];
    doc.querySelectorAll('.flash, .alert, .swal2-title, .swal2-html-container, .toast-body').forEach((el) => {
      const t = el.textContent.trim().replace(/\s+/g, ' ');
      if (t) parts.push({ text: t, cls: el.className || '' });
    });
    // pesan di script: alert('...'), Swal.fire('...'), toastr.success('...')
    const re = /(?:alert|Swal\.fire|swal|toastr\.\w+)\s*\(\s*(?:\{[^}]*?(?:title|text)\s*:\s*)?(['"`])((?:\\.|(?!\1).){1,300})\1/g;
    let m;
    while ((m = re.exec(html))) parts.push({ text: m[2], cls: 'script' });
    return parts;
  }

  // returns {ok, msg, csrf, loggedOut}
  async function postOne(csrf, tanggal, p, st) {
    const body = new URLSearchParams({
      csrf,
      tanggal,
      ...M.fields(p),
      status: st.status,
      menit_terlambat: st.status === 'terlambat' ? String(Number(st.menit) || 0) : '0',
      keterangan: st.keterangan || '',
    });
    let res;
    try {
      res = await fetch(submitUrl(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (e) {
      return { ok: false, msg: 'Network error: ' + e.message };
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newCsrf = readCsrf(doc);
    const loggedOut =
      /\/auth\/login\.php/i.test(res.url) ||
      (!!doc.querySelector('input[name="password"]') && !doc.querySelector(M.formMarker));
    if (loggedOut) return { ok: false, loggedOut: true, msg: 'Session habis, silakan login ulang' };

    const msgs = extractMessage(doc, html);
    const msgText = msgs.map((x) => x.text).join(' | ').slice(0, 300);
    const isError = msgs.some(
      (x) => /danger|error|warning/i.test(x.cls) || /gagal|error|invalid|tidak valid|csrf|token|sudah ada|duplikat/i.test(x.text)
    );
    const ok = res.ok && !isError;
    return { ok, msg: msgText || `HTTP ${res.status}`, csrf: newCsrf };
  }

  // ---------- styles ----------
  const css = `
  #aeb-fab{position:fixed;right:20px;bottom:20px;z-index:2147483646;background:#1d4ed8;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:600 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
  #aeb-panel{position:fixed;right:20px;bottom:76px;z-index:2147483647;width:min(860px,calc(100vw - 32px));max-height:calc(100vh - 110px);display:none;flex-direction:column;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:13px/1.4 system-ui,sans-serif}
  #aeb-panel.aeb-open{display:flex}
  #aeb-panel *{box-sizing:border-box;font-family:inherit}
  .aeb-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid #e5e7eb}
  .aeb-head h3{margin:0 auto 0 0;font-size:15px}
  .aeb-tab{border:1px solid #d1d5db;background:#f9fafb;border-radius:6px;padding:5px 10px;cursor:pointer;color:#111827}
  .aeb-tab.aeb-active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  .aeb-body{overflow:auto;padding:12px}
  .aeb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
  #aeb-panel input[type=text],#aeb-panel input[type=date],#aeb-panel input[type=number],#aeb-panel select,#aeb-panel textarea{border:1px solid #d1d5db;border-radius:6px;padding:5px 7px;font-size:13px;background:#fff;color:#111827}
  #aeb-panel input:disabled{background:#f3f4f6;color:#9ca3af}
  .aeb-btn{border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;color:#111827}
  .aeb-btn:disabled{opacity:.5;cursor:not-allowed}
  .aeb-primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  .aeb-danger{color:#b91c1c;border-color:#fca5a5}
  .aeb-table{width:100%;border-collapse:collapse}
  .aeb-table th,.aeb-table td{border-bottom:1px solid #e5e7eb;padding:5px 6px;text-align:left;vertical-align:middle}
  .aeb-table th{background:#f9fafb;position:sticky;top:-12px;z-index:1}
  .aeb-table tr.aeb-off td{color:#9ca3af}
  .aeb-ok{color:#15803d;font-weight:600}
  .aeb-fail{color:#b91c1c;font-weight:600}
  .aeb-muted{color:#6b7280}
  .aeb-progress{height:8px;background:#e5e7eb;border-radius:99px;overflow:hidden;flex:1;min-width:120px}
  .aeb-progress>div{height:100%;background:#1d4ed8;width:0;transition:width .2s}
  .aeb-pre{background:#f3f4f6;border-radius:6px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}
  .aeb-warn{background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:6px 8px;margin-bottom:10px}
  `;

  // ---------- UI ----------
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'aeb-fab';
  fab.type = 'button';
  fab.textContent = 'Bulk Kehadiran';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'aeb-panel';
  panel.innerHTML = `
    <div class="aeb-head">
      <h3>${M.title}</h3>
      <button type="button" class="aeb-tab aeb-active" data-tab="submit">Submit</button>
      ${MODE === 'pegawai' ? '<button type="button" class="aeb-tab" data-tab="pegawai">Pegawai</button>' : ''}
      <button type="button" class="aeb-tab" data-tab="log">Log</button>
      <button type="button" class="aeb-btn" data-act="close" title="Tutup">✕</button>
    </div>
    <div class="aeb-body"></div>`;
  document.body.appendChild(panel);
  const bodyEl = panel.querySelector('.aeb-body');

  let tab = 'submit';
  let tanggal = today();
  let progress = { done: 0, total: 0 };
  let dryRunOutput = '';

  fab.addEventListener('click', () => {
    panel.classList.toggle('aeb-open');
    if (panel.classList.contains('aeb-open')) render();
  });
  panel.querySelector('.aeb-head').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t && !running) {
      tab = t.dataset.tab;
      panel.querySelectorAll('.aeb-tab').forEach((b) => b.classList.toggle('aeb-active', b === t));
      render();
    }
    if (e.target.closest('[data-act="close"]')) panel.classList.remove('aeb-open');
  });

  function render() {
    if (tab === 'submit') renderSubmit();
    else if (tab === 'pegawai') renderPegawai();
    else renderLog();
  }

  // ----- tab: submit -----
  function resultFor(id) {
    return lastResults.find((r) => r.id === id);
  }

  function renderSubmit() {
    const csrf = readCsrf(document);
    const list = items();
    const isPegawai = MODE === 'pegawai';
    const allChecked = list.length > 0 && list.every((p) => checked.has(p.id));
    const rows = list
      .map((p, i) => {
        const st = rs(p.id);
        const on = checked.has(p.id);
        const r = resultFor(p.id);
        return `<tr class="${on ? '' : 'aeb-off'}" data-id="${p.id}">
          <td><input type="checkbox" data-f="check" ${on ? 'checked' : ''}></td>
          <td>${i + 1}</td>
          <td>${esc(p.nama)}</td>
          ${isPegawai ? `<td>${esc(p.unit)}</td>` : ''}
          <td><select data-f="status">${STATUSES.map((s) => `<option value="${s}" ${st.status === s ? 'selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select></td>
          <td><input type="number" min="0" style="width:70px" data-f="menit" value="${esc(st.menit)}" ${st.status === 'terlambat' ? '' : 'disabled'}></td>
          <td><input type="text" style="width:100%;min-width:120px" data-f="keterangan" value="${esc(st.keterangan)}"></td>
          <td>${r ? `<span class="${r.ok ? 'aeb-ok' : 'aeb-fail'}" title="${esc(r.msg)}">${r.ok ? '✓' : '✗'}</span> <span class="aeb-muted">${esc(r.msg).slice(0, 60)}</span>` : ''}</td>
        </tr>`;
      })
      .join('');
    const failedCount = lastResults.filter((r) => !r.ok).length;

    bodyEl.innerHTML = `
      ${csrf ? '' : '<div class="aeb-warn">Token CSRF tidak ditemukan di halaman. Pastikan Anda sudah login dan berada di halaman kehadiran.</div>'}
      <div class="aeb-row">
        <label>Tanggal (semua): <input type="date" data-f="tanggal" value="${esc(tanggal)}"></label>
        <span style="margin-left:auto"></span>
        <label>Ubah semua status:
          <select data-f="bulkStatus">${STATUSES.map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join('')}</select>
        </label>
        <button type="button" class="aeb-btn" data-act="applyAll">Terapkan</button>
      </div>
      ${
        list.length === 0
          ? isPegawai
            ? '<p class="aeb-muted">Belum ada pegawai. Tambahkan di tab <b>Pegawai</b>.</p>'
            : '<p class="aeb-muted">Daftar jabatan (pilihan <code>struktural_id</code>) tidak ditemukan di halaman ini.</p>'
          : `<table class="aeb-table">
        <thead><tr>
          <th><input type="checkbox" data-f="checkAll" ${allChecked ? 'checked' : ''} title="Pilih semua"></th>
          <th>#</th>${isPegawai ? '<th>Nama</th><th>Unit</th>' : '<th>Jabatan</th>'}<th>Status</th><th>Menit telat</th><th>Keterangan</th><th>Hasil</th>
        </tr></thead>
        <tbody>${rows}</tbody></table>`
      }
      <div class="aeb-row" style="margin-top:12px">
        <label><input type="checkbox" data-f="dryRun" ${dryRun ? 'checked' : ''}> Dry run (tidak mengirim)</label>
        <span class="aeb-muted">Dicentang: <b>${countChecked()}</b> / ${list.length}</span>
        <div class="aeb-progress"><div style="width:${progress.total ? (progress.done / progress.total) * 100 : 0}%"></div></div>
        <span class="aeb-muted">${progress.total ? `${progress.done}/${progress.total}` : ''}</span>
        ${failedCount && !running ? `<button type="button" class="aeb-btn" data-act="retry">Ulangi yang gagal (${failedCount})</button>` : ''}
        ${running ? '<button type="button" class="aeb-btn aeb-danger" data-act="stop">Stop</button>' : `<button type="button" class="aeb-btn aeb-primary" data-act="send" ${countChecked() ? '' : 'disabled'}>Kirim</button>`}
      </div>
      ${dryRunOutput ? `<div class="aeb-pre">${esc(dryRunOutput)}</div>` : ''}
    `;
    if (running) bodyEl.querySelectorAll('input,select').forEach((el) => (el.disabled = true));
  }

  function countChecked() {
    return items().filter((p) => checked.has(p.id)).length;
  }

  bodyEl.addEventListener('change', (e) => {
    const el = e.target;
    const f = el.dataset.f;
    if (!f) return;
    const tr = el.closest('tr[data-id]');
    const id = tr && tr.dataset.id;
    if (tab === 'submit') {
      if (f === 'tanggal') tanggal = el.value;
      else if (f === 'dryRun') {
        dryRun = el.checked;
        save(KEY.dryRun, dryRun);
        render();
      } else if (f === 'checkAll') {
        items().forEach((p) => (el.checked ? checked.add(p.id) : checked.delete(p.id)));
        persistSelection();
        render();
      } else if (f === 'check') {
        el.checked ? checked.add(id) : checked.delete(id);
        persistSelection();
        render();
      } else if (f === 'status') {
        rs(id).status = el.value;
        render();
      } else if (f === 'menit') rs(id).menit = Math.max(0, Number(el.value) || 0);
      else if (f === 'keterangan') rs(id).keterangan = el.value;
    }
  });
  bodyEl.addEventListener('input', (e) => {
    const el = e.target;
    const tr = el.closest('tr[data-id]');
    if (tab === 'submit' && tr && el.dataset.f === 'keterangan') rs(tr.dataset.id).keterangan = el.value;
    if (tab === 'submit' && tr && el.dataset.f === 'menit') rs(tr.dataset.id).menit = Math.max(0, Number(el.value) || 0);
  });

  bodyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const tr = btn.closest('tr[data-id]');
    const id = tr && tr.dataset.id;
    if (act === 'applyAll') {
      const s = bodyEl.querySelector('[data-f="bulkStatus"]').value;
      items().forEach((p) => (rs(p.id).status = s));
      render();
    } else if (act === 'send') {
      startSend(items().filter((p) => checked.has(p.id)));
    } else if (act === 'retry') {
      const failedIds = new Set(lastResults.filter((r) => !r.ok).map((r) => r.id));
      startSend(items().filter((p) => failedIds.has(p.id)));
    } else if (act === 'stop') {
      stopRequested = true;
      btn.disabled = true;
      btn.textContent = 'Menghentikan…';
    } else if (act === 'add') addPegawai();
    else if (act === 'edit') {
      editingId = id;
      render();
    } else if (act === 'cancelEdit') {
      editingId = null;
      render();
    } else if (act === 'saveEdit') saveEdit(tr);
    else if (act === 'del') delPegawai(id);
    else if (act === 'bulkAdd') bulkAdd();
    else if (act === 'export') exportJson();
    else if (act === 'import') importJson();
    else if (act === 'clearLog') {
      if (confirm('Hapus semua log?')) {
        log = [];
        save(KEY.log, log);
        render();
      }
    }
  });

  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || tab !== 'pegawai') return;
    if (e.target.closest('[data-form="add"]')) {
      e.preventDefault();
      addPegawai();
    } else if (e.target.closest('tr[data-id]') && editingId) {
      e.preventDefault();
      saveEdit(e.target.closest('tr[data-id]'));
    }
  });

  // ----- sending -----
  async function startSend(list) {
    if (running || list.length === 0) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
      alert('Tanggal belum diisi.');
      return;
    }
    const counts = {};
    list.forEach((p) => (counts[rs(p.id).status] = (counts[rs(p.id).status] || 0) + 1));
    const summary = Object.entries(counts)
      .map(([s, n]) => `  ${statusLabel(s)}: ${n}`)
      .join('\n');

    if (dryRun) {
      const csrf = readCsrf(document) || '(tidak ditemukan)';
      dryRunOutput =
        `DRY RUN — tidak ada request dikirim.\nPOST ${submitUrl()}\ncsrf: ${csrf}\n\n` +
        list
          .map((p, i) => {
            const st = rs(p.id);
            const f = Object.entries(M.fields(p)).map(([k, v]) => `${k}=${v}`).join('&');
            const label = MODE === 'struktural' ? `  (${p.nama})` : '';
            return `${i + 1}. tanggal=${tanggal}&${f}&status=${st.status}&menit_terlambat=${st.status === 'terlambat' ? Number(st.menit) || 0 : 0}&keterangan=${st.keterangan || ''}${label}`;
          })
          .join('\n');
      render();
      return;
    }

    const who = MODE === 'struktural' ? 'pejabat' : 'pegawai';
    const dup = list.filter((p) =>
      log.some((l) => l.ok && (l.page || 'pegawai') === MODE && l.tanggal === tanggal && l.nama === p.nama && (l.unit || '') === (p.unit || ''))
    );
    let msg = `Kirim kehadiran tanggal ${tanggal} untuk ${list.length} ${who}?\n\n${summary}`;
    if (dup.length) msg += `\n\nPERHATIAN: ${dup.length} ${who} sudah pernah sukses dikirim untuk tanggal ini:\n` + dup.map((p) => '  - ' + p.nama).join('\n');
    if (!confirm(msg)) return;

    let csrf = readCsrf(document);
    if (!csrf) {
      alert('Token CSRF tidak ditemukan. Muat ulang halaman setelah login.');
      return;
    }

    running = true;
    stopRequested = false;
    dryRunOutput = '';
    const ids = new Set(list.map((p) => p.id));
    lastResults = lastResults.filter((r) => !ids.has(r.id));
    progress = { done: 0, total: list.length };
    render();

    for (let i = 0; i < list.length; i++) {
      if (stopRequested) break;
      const p = list[i];
      const st = { ...rs(p.id) };
      const r = await postOne(csrf, tanggal, p, st);
      if (r.csrf) {
        csrf = r.csrf;
        const pageCsrf = document.querySelector('input[name="csrf"]');
        if (pageCsrf) pageCsrf.value = r.csrf;
      }
      lastResults.push({ id: p.id, ok: r.ok, msg: r.msg });
      log.unshift({ at: new Date().toISOString(), page: MODE, tanggal, nama: p.nama, unit: p.unit, status: st.status, ok: r.ok, msg: r.msg });
      if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
      save(KEY.log, log);
      progress.done = i + 1;
      render();
      if (r.loggedOut) {
        alert('Session habis. Login ulang lalu buka halaman ini lagi, kemudian klik "Ulangi yang gagal" / Kirim untuk sisanya.');
        break;
      }
      if (i < list.length - 1) await sleep(DELAY_MS);
    }

    // tandai yang belum terkirim karena stop/logout
    list.forEach((p) => {
      if (!lastResults.some((r) => r.id === p.id)) lastResults.push({ id: p.id, ok: false, msg: 'Tidak dikirim (dihentikan)' });
    });
    running = false;
    stopRequested = false;
    render();
  }

  // ----- tab: pegawai -----
  function renderPegawai() {
    const rows = pegawai
      .map((p, i) =>
        editingId === p.id
          ? `<tr data-id="${p.id}"><td>${i + 1}</td>
          <td><input type="text" data-e="nama" value="${esc(p.nama)}" style="width:100%"></td>
          <td><input type="text" data-e="unit" value="${esc(p.unit)}" style="width:100%"></td>
          <td><button type="button" class="aeb-btn aeb-primary" data-act="saveEdit">Simpan</button>
              <button type="button" class="aeb-btn" data-act="cancelEdit">Batal</button></td></tr>`
          : `<tr data-id="${p.id}"><td>${i + 1}</td><td>${esc(p.nama)}</td><td>${esc(p.unit)}</td>
          <td><button type="button" class="aeb-btn" data-act="edit">Edit</button>
              <button type="button" class="aeb-btn aeb-danger" data-act="del">Hapus</button></td></tr>`
      )
      .join('');
    bodyEl.innerHTML = `
      <div class="aeb-row" data-form="add">
        <input type="text" data-a="nama" placeholder="Nama pegawai" style="flex:2;min-width:160px">
        <input type="text" data-a="unit" placeholder="Unit" style="flex:1;min-width:120px">
        <button type="button" class="aeb-btn aeb-primary" data-act="add">Tambah</button>
      </div>
      <details style="margin-bottom:10px">
        <summary>Tambah banyak sekaligus / backup</summary>
        <p class="aeb-muted" style="margin:6px 0">Satu pegawai per baris, format: <code>nama;unit</code></p>
        <textarea data-a="bulk" rows="5" style="width:100%" placeholder="Budi Santoso;Fakultas Hukum&#10;Siti Aminah;Fakultas Hukum"></textarea>
        <div class="aeb-row" style="margin-top:6px">
          <button type="button" class="aeb-btn" data-act="bulkAdd">Tambahkan semua</button>
          <span style="margin-left:auto"></span>
          <button type="button" class="aeb-btn" data-act="export">Export JSON</button>
          <button type="button" class="aeb-btn" data-act="import">Import JSON</button>
        </div>
      </details>
      ${
        pegawai.length
          ? `<table class="aeb-table"><thead><tr><th>#</th><th>Nama</th><th>Unit</th><th style="width:150px">Aksi</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="aeb-muted">Belum ada pegawai.</p>'
      }`;
    bodyEl.querySelector('[data-a="nama"]').focus();
  }

  function exists(nama, unit, exceptId) {
    const n = nama.toLowerCase();
    const u = unit.toLowerCase();
    return pegawai.some((p) => p.id !== exceptId && p.nama.toLowerCase() === n && p.unit.toLowerCase() === u);
  }

  function addPegawai() {
    const nama = bodyEl.querySelector('[data-a="nama"]').value.trim();
    const unit = bodyEl.querySelector('[data-a="unit"]').value.trim();
    if (!nama || !unit) return alert('Nama dan unit wajib diisi.');
    if (exists(nama, unit)) return alert('Pegawai dengan nama & unit itu sudah ada.');
    const p = { id: uid(), nama, unit };
    pegawai.push(p);
    checked.add(p.id);
    persistPegawai();
    persistSelection();
    render();
    // biarkan unit terisi untuk input berikutnya
    bodyEl.querySelector('[data-a="unit"]').value = unit;
  }

  function saveEdit(tr) {
    const nama = tr.querySelector('[data-e="nama"]').value.trim();
    const unit = tr.querySelector('[data-e="unit"]').value.trim();
    if (!nama || !unit) return alert('Nama dan unit wajib diisi.');
    if (exists(nama, unit, tr.dataset.id)) return alert('Pegawai dengan nama & unit itu sudah ada.');
    const p = pegawai.find((x) => x.id === tr.dataset.id);
    if (p) Object.assign(p, { nama, unit });
    editingId = null;
    persistPegawai();
    render();
  }

  function delPegawai(id) {
    const p = pegawai.find((x) => x.id === id);
    if (!p || !confirm(`Hapus ${p.nama}?`)) return;
    pegawai = pegawai.filter((x) => x.id !== id);
    checked.delete(id);
    persistPegawai();
    persistSelection();
    render();
  }

  function bulkAdd() {
    const text = bodyEl.querySelector('[data-a="bulk"]').value;
    let added = 0;
    const skipped = [];
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const [nama, unit] = line.split(/[;\t]/).map((s) => (s || '').trim());
      if (!nama || !unit || exists(nama, unit)) return skipped.push(line.trim());
      const p = { id: uid(), nama, unit };
      pegawai.push(p);
      checked.add(p.id);
      added++;
    });
    persistPegawai();
    persistSelection();
    render();
    alert(`${added} pegawai ditambahkan.` + (skipped.length ? `\n${skipped.length} baris dilewati (format salah / duplikat):\n` + skipped.slice(0, 10).join('\n') : ''));
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(pegawai.map(({ nama, unit }) => ({ nama, unit })), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pegawai-emonev-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        if (!Array.isArray(data)) throw new Error('Format harus array');
        let added = 0;
        data.forEach((x) => {
          const nama = String(x.nama || '').trim();
          const unit = String(x.unit || '').trim();
          if (nama && unit && !exists(nama, unit)) {
            const p = { id: uid(), nama, unit };
            pegawai.push(p);
            checked.add(p.id);
            added++;
          }
        });
        persistPegawai();
        persistSelection();
        render();
        alert(`${added} pegawai diimport.`);
      } catch (e) {
        alert('Gagal import: ' + e.message);
      }
    };
    input.click();
  }

  // ----- tab: log -----
  function renderLog() {
    bodyEl.innerHTML = `
      <div class="aeb-row"><span class="aeb-muted">${log.length} entri terakhir (maks ${LOG_LIMIT})</span>
        <span style="margin-left:auto"></span>
        <button type="button" class="aeb-btn aeb-danger" data-act="clearLog" ${log.length ? '' : 'disabled'}>Hapus log</button></div>
      ${
        log.length
          ? `<table class="aeb-table"><thead><tr><th>Waktu</th><th>Jenis</th><th>Tanggal</th><th>Nama / Jabatan</th><th>Unit</th><th>Status</th><th>Hasil</th></tr></thead><tbody>${log
              .map(
                (l) => `<tr><td class="aeb-muted">${esc(new Date(l.at).toLocaleString('id-ID'))}</td><td>${esc(l.page || 'pegawai')}</td><td>${esc(l.tanggal)}</td><td>${esc(l.nama)}</td><td>${esc(l.unit)}</td><td>${esc(statusLabel(l.status))}</td>
                <td><span class="${l.ok ? 'aeb-ok' : 'aeb-fail'}">${l.ok ? '✓' : '✗'}</span> <span class="aeb-muted">${esc(l.msg)}</span></td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p class="aeb-muted">Belum ada log.</p>'
      }`;
  }

  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
