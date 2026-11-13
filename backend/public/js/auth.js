/* KamiTales — utilidades comunes de Acceder y Registro. */
(function () {
  'use strict';
  var RKEY = 'kami_auth_return';

  // Solo rutas internas: "/algo", nunca "//dominio" ni "/\dominio"
  function clean(r) { return typeof r === 'string' && /^\/(?![\/\\])[^\s]*$/.test(r) ? r : ''; }
  function returnTo() {
    var q = clean(new URLSearchParams(location.search).get('return') || '');
    if (q) return q;
    try { return clean(sessionStorage.getItem(RKEY) || ''); } catch (e) { return ''; }
  }
  function rememberReturn() { var r = returnTo(); try { if (r) sessionStorage.setItem(RKEY, r); else sessionStorage.removeItem(RKEY); } catch (e) { /* nada */ } }
  function finish(token, user, fallback) {
    try {
      localStorage.setItem('kami_token', token);
      localStorage.setItem('kami_user', JSON.stringify(user));
      sessionStorage.removeItem('kami_plan_checked');
    } catch (e) { /* nada */ }
    var dest = returnTo() || fallback || ('/perfil/' + encodeURIComponent(user.username));
    try { sessionStorage.removeItem(RKEY); } catch (e) { /* nada */ }
    location.replace(dest);
  }
  function session() {
    try { var t = localStorage.getItem('kami_token'), u = JSON.parse(localStorage.getItem('kami_user') || 'null'); return t && u && u.username ? { token: t, user: u } : null; } catch (e) { return null; }
  }

  // Mostrar / ocultar contraseña
  function bindEyes(root) {
    (root || document).querySelectorAll('[data-eye]').forEach(function (b) {
      var input = document.getElementById(b.getAttribute('data-eye'));
      b.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.setAttribute('aria-pressed', String(show));
        b.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
        b.innerHTML = '<i class="ti ti-' + (show ? 'eye-off' : 'eye') + '" aria-hidden="true"></i>';
        input.focus();
      });
    });
  }
  // Aviso de bloqueo de mayúsculas
  function bindCaps(input, hint) {
    function chk(e) { if (e.getModifierState) hint.hidden = !e.getModifierState('CapsLock'); }
    input.addEventListener('keydown', chk); input.addEventListener('keyup', chk);
    input.addEventListener('blur', function () { hint.hidden = true; });
  }

  // Mosaico de portadas reales en el panel de arte
  function buildWall(el) {
    if (!el || !matchMedia('(min-width: 960px)').matches) return;
    var colors = ['var(--k-accent)', 'var(--k-gold)', '#22d3ee', '#9d7bff', '#3ee08f', '#ff5fbf'];
    function paint(covers) {
      var html = '';
      for (var c = 0; c < 4; c++) {
        html += '<div class="au-col">';
        for (var i = 0; i < 6; i++) {
          var k = c * 6 + i, src = covers.length ? covers[(k * 7 + c) % covers.length] : '';
          html += src && (k % 3 !== 1 || covers.length > 6)
            ? '<span class="au-tile" style="background-image:url(\'' + src.replace(/'/g, '%27') + '\')"></span>'
            : '<span class="au-tile is-ph" style="--_c:' + colors[k % colors.length] + '"></span>';
        }
        html += '</div>';
      }
      el.innerHTML = html;
    }
    paint([]);
    fetch('/api/manga/trending?limit=18').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var covers = ((d && d.trending) || []).map(function (m) { return m.cover; }).filter(function (s) { return typeof s === 'string' && /^\/[^\s"'()]+$/.test(s); });
      if (covers.length) paint(covers);
    }).catch(function () { /* se queda el degradado */ });
  }

  window.KAMI_AUTH = { returnTo: returnTo, rememberReturn: rememberReturn, finish: finish, session: session, bindEyes: bindEyes, bindCaps: bindCaps, buildWall: buildWall, cleanReturn: clean };
})();
