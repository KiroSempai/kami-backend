/* KamiTales — desbloquear un adelanto con monedas. Lo usan los dos lectores.
 *
 *   KAMI_UNLOCK.mount(el, { mangaId, chapter, offer, onUnlocked })
 *
 * «offer» viene del servidor ({ priceCoins, cost, goldCost, discountPct }) o es
 * null si el capítulo no se vende; entonces no se pinta nada y solo queda esperar.
 * El precio que se confirma se envía de vuelta: si cambió entretanto, no se cobra.
 */
(function () {
  'use strict';
  var NF = new Intl.NumberFormat('es-ES');
  var token = function () { try { return localStorage.getItem('kami_token'); } catch (e) { return null; } };
  var H = function () { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }; };
  var coin = '<i class="ti ti-coin" aria-hidden="true"></i>';
  var here = function () { return location.pathname; };
  // Se mira al cargar: el lector puede reescribir la dirección antes de pintar el capítulo
  var cameBack = /[?&]monedas=ok/.test(location.search);

  if (!document.getElementById('ku-css')) {
    var st = document.createElement('style'); st.id = 'ku-css';
    st.textContent =
      '.ku{display:grid;gap:10px;justify-items:center;width:100%;margin-top:4px}' +
      '.ku-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 22px;border-radius:999px;border:0;cursor:pointer;font-family:inherit;font-weight:700;font-size:15px;line-height:1;color:#1a1205;background:linear-gradient(120deg,#ffe08a,var(--k-gold,#f5c842) 60%,#d99a25);box-shadow:0 10px 30px -12px var(--k-gold,#f5c842);text-decoration:none;transition:filter .15s,transform .15s}' +
      '.ku-btn:hover{filter:brightness(1.07)}.ku-btn:active{transform:scale(.98)}.ku-btn:focus-visible{outline:2px solid #fff;outline-offset:3px}.ku-btn[disabled]{opacity:.6;cursor:progress}' +
      '.ku-btn s{opacity:.6;font-weight:500}.ku .ku-btn .ti{font-size:19px;color:inherit}.ku .ku-note .ti{font-size:15px;color:inherit}' +
      '.ku-ghost{background:none;border:0;color:inherit;opacity:.75;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;line-height:1;padding:10px 14px;border-radius:999px;text-decoration:underline;text-underline-offset:3px}.ku-ghost:hover{opacity:1}' +
      '.ku-note{margin:0;font-size:13px;line-height:1.5;opacity:.75;text-align:center;max-width:38ch}.ku-note b{opacity:1}.ku-note a{color:var(--k-gold,#f5c842)}' +
      '.ku-row{display:flex;flex-wrap:wrap;gap:6px 10px;justify-content:center;align-items:center}' +
      '.ku-err{color:#ff8f8f;opacity:1}';
    document.head.appendChild(st);
  }

  function mount(el, o) {
    if (!el) return;
    var offer = o.offer;
    if (!offer) { el.innerHTML = ''; return; }
    var box = document.createElement('div'); box.className = 'ku'; box.setAttribute('aria-live', 'polite');
    el.innerHTML = ''; el.appendChild(box);
    var busy = false;

    function price() { return offer.cost < offer.priceCoins ? '<s>' + NF.format(offer.priceCoins) + '</s> ' + NF.format(offer.cost) : NF.format(offer.cost); }
    function goldLine() {
      return offer.cost < offer.priceCoins ? '<p class="ku-note">Precio Gold: −' + offer.discountPct + ' %.</p>'
        : '<p class="ku-note">Con <a href="/premium">Gold</a> te costaría ' + NF.format(offer.goldCost) + '.</p>';
    }
    function idle(msg) {
      box.innerHTML = '<button type="button" class="ku-btn" data-ku="start">' + coin + 'Leer ya por ' + price() + ' monedas</button>' + (msg ? '<p class="ku-note ku-err">' + msg + '</p>' : goldLine());
    }
    function confirmStep(balance) {
      box.innerHTML = '<p class="ku-note">Tienes <b>' + NF.format(balance) + '</b> monedas. Este capítulo cuesta <b>' + NF.format(offer.cost) + '</b> y te quedarán <b>' + NF.format(balance - offer.cost) + '</b>.</p>' +
        '<div class="ku-row"><button type="button" class="ku-btn" data-ku="pay">' + coin + 'Confirmar</button><button type="button" class="ku-ghost" data-ku="cancel">Cancelar</button></div>';
      box.querySelector('[data-ku="pay"]').focus();
    }
    function needMore(balance) {
      box.innerHTML = '<p class="ku-note">Tienes <b>' + NF.format(balance) + '</b> monedas y este capítulo cuesta <b>' + NF.format(offer.cost) + '</b>. Te faltan ' + NF.format(offer.cost - balance) + '.</p>' +
        '<div class="ku-row"><a class="ku-btn" href="/monedas?volver=' + encodeURIComponent(here()) + '">' + coin + 'Conseguir monedas</a><button type="button" class="ku-ghost" data-ku="cancel">Ahora no</button></div>';
    }
    function closed() { box.innerHTML = '<p class="ku-note">Las monedas todavía no están disponibles. Este capítulo se libera gratis en su fecha.</p>'; }

    function start() {
      if (!token()) { location.href = '/acceder?return=' + encodeURIComponent(here()); return; }
      if (busy) return; busy = true;
      var b = box.querySelector('[data-ku="start"]'); if (b) b.disabled = true;
      fetch('/api/coins/wallet', { headers: H() }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (w) {
          if (!w.open && w.balance < offer.cost) return closed();
          if (w.balance >= offer.cost) confirmStep(w.balance); else needMore(w.balance);
        })
        .catch(function () { idle('No se pudo consultar tu saldo. Inténtalo de nuevo.'); })
        .then(function () { busy = false; });
    }
    function pay() {
      if (busy) return; busy = true;
      var b = box.querySelector('[data-ku="pay"]'); if (b) { b.disabled = true; b.innerHTML = '<i class="ti ti-loader-2" aria-hidden="true"></i>Desbloqueando…'; }
      fetch('/api/coins/unlock', { method: 'POST', headers: H(), body: JSON.stringify({ mangaId: o.mangaId, chapter: o.chapter, expect: offer.cost }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (x) {
          if (x.s === 200 && x.d.ok) {
            box.innerHTML = '<p class="ku-note"><b>Desbloqueado.</b> Abriendo el capítulo…</p>';
            if (window.KAMI && KAMI.toast && !x.d.already) KAMI.toast('Capítulo desbloqueado. Te quedan ' + NF.format(x.d.balance) + ' monedas.', 'good');
            if (o.onUnlocked) o.onUnlocked(x.d);
          } else if (x.s === 409 && x.d.code === 'price_changed') {
            offer = { priceCoins: x.d.priceCoins, cost: x.d.cost, goldCost: offer.goldCost, discountPct: x.d.cost < x.d.priceCoins ? offer.discountPct || 20 : 0 };
            idle('El precio ha cambiado. No se te ha cobrado nada.');
          } else if (x.s === 409 && x.d.code === 'free') {
            if (o.onUnlocked) o.onUnlocked(x.d);
          } else if (x.s === 402) { needMore(x.d.balance || 0); }
          else if (x.s === 401) { location.href = '/acceder?return=' + encodeURIComponent(here()); }
          else idle(x.d.error || 'No se pudo desbloquear. No se te ha cobrado nada.');
        })
        .catch(function () { idle('Sin conexión. No se te ha cobrado nada.'); })
        .then(function () { busy = false; });
    }
    box.addEventListener('click', function (e) {
      var t = e.target.closest('[data-ku]'); if (!t) return;
      if (t.dataset.ku === 'start') start(); else if (t.dataset.ku === 'pay') pay(); else idle();
    });
    idle();
    // Al volver de comprar monedas se retoma donde estaba: el aviso de pago puede tardar unos segundos
    if (cameBack && token()) {
      cameBack = false;
      try { if (/[?&]monedas=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* nada */ }
      box.innerHTML = '<p class="ku-note"><i class="ti ti-loader-2" aria-hidden="true"></i> Recibiendo tus monedas…</p>';
      var tries = 0;
      (function poll() {
        fetch('/api/coins/wallet', { headers: H() }).then(function (r) { return r.json(); }).then(function (w) {
          if (w.balance >= offer.cost) return confirmStep(w.balance);
          if (++tries < 8) setTimeout(poll, 2000); else idle('Tu pago aún no ha llegado. Espera un momento y vuelve a intentarlo.');
        }).catch(function () { idle(); });
      })();
    }
  }
  window.KAMI_UNLOCK = { mount: mount };
})();
