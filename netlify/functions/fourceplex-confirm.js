// fourceplex-confirm.js — shared delete-confirmation modal for Fource.Plex
// Provides: window.fpConfirm(msg, title?) → Promise<boolean>
(function () {
  const css = `
#fp-confirm-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;align-items:center;justify-content:center;backdrop-filter:blur(3px)}
#fp-confirm-overlay.open{display:flex}
#fp-confirm-box{background:#16161a;border:1px solid rgba(255,255,255,.13);border-radius:12px;padding:24px 24px 20px;width:330px;max-width:94vw;animation:fpCmIn .17s ease}
@keyframes fpCmIn{from{opacity:0;transform:scale(.95) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}
body.light #fp-confirm-box{background:#ffffff;border-color:rgba(0,0,0,.12)}
.fp-cm-icon{width:38px;height:38px;border-radius:50%;background:rgba(248,113,113,.13);border:1px solid rgba(248,113,113,.22);display:flex;align-items:center;justify-content:center;margin-bottom:13px}
.fp-cm-title{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9998a8;margin-bottom:7px}
body.light .fp-cm-title{color:#56566a}
.fp-cm-msg{font-size:13px;color:#f0eff4;line-height:1.55;margin-bottom:22px}
body.light .fp-cm-msg{color:#16161e}
.fp-cm-actions{display:flex;gap:8px;justify-content:flex-end}
.fp-cm-cancel{font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;padding:6px 14px;border-radius:6px;cursor:pointer;border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.04);color:#9998a8;transition:all .14s}
.fp-cm-cancel:hover{background:rgba(255,255,255,.09);color:#f0eff4}
body.light .fp-cm-cancel{border-color:rgba(0,0,0,.11);background:rgba(0,0,0,.04);color:#56566a}
body.light .fp-cm-cancel:hover{background:rgba(0,0,0,.08);color:#16161e}
.fp-cm-del{font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;padding:6px 15px;border-radius:6px;cursor:pointer;border:1px solid rgba(248,113,113,.38);background:rgba(248,113,113,.11);color:#f87171;transition:all .14s}
.fp-cm-del:hover{background:rgba(248,113,113,.22);border-color:rgba(248,113,113,.6);color:#fca5a5}
`;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const overlay = document.createElement('div');
  overlay.id = 'fp-confirm-overlay';
  overlay.innerHTML = `
    <div id="fp-confirm-box">
      <div class="fp-cm-icon">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#f87171" stroke-width="1.6">
          <path d="M3 5h10M5 5V3h6v2M6 8v4M10 8v4"/>
          <rect x="3" y="5" width="10" height="9" rx="1"/>
        </svg>
      </div>
      <div class="fp-cm-title" id="fp-cm-title">Potwierdź usunięcie</div>
      <div class="fp-cm-msg" id="fp-cm-msg"></div>
      <div class="fp-cm-actions">
        <button class="fp-cm-cancel" id="fp-cm-cancel">Anuluj</button>
        <button class="fp-cm-del" id="fp-cm-del">Usuń</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let _resolve = null;

  function close(result) {
    overlay.classList.remove('open');
    if (_resolve) { _resolve(result); _resolve = null; }
  }

  document.getElementById('fp-cm-cancel').addEventListener('click', () => close(false));
  document.getElementById('fp-cm-del').addEventListener('click', () => close(true));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close(false);
  });

  /**
   * Show a styled confirmation modal.
   * @param {string} msg  - Body text describing what will be deleted.
   * @param {string} [title] - Optional title override.
   * @returns {Promise<boolean>} resolves true if user clicked Usuń, false otherwise.
   */
  window.fpConfirm = function (msg, title) {
    document.getElementById('fp-cm-title').textContent = title || 'Potwierdź usunięcie';
    document.getElementById('fp-cm-msg').textContent = msg || 'Tej operacji nie można cofnąć.';
    overlay.classList.add('open');
    setTimeout(() => document.getElementById('fp-cm-del').focus(), 80);
    return new Promise(res => { _resolve = res; });
  };
})();
