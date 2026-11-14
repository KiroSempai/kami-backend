/* ═══════════════════════════════════════════════════════════════════
   KamiTales — Shell común (kami-shell.js)
   Sustituye a menu-global.js. Cárgalo en <head>, sin defer:

     <link rel="stylesheet" href="/css/kami.css">
     <script src="/js/kami-shell.js"></script>

   1. Aplica la apariencia guardada antes de pintar (sin parpadeo).
   2. Dibuja la nav superior, la barra inferior móvil y el panel de
      apariencia en todas las páginas.
   3. Expone window.KAMI: theme, toast(), openAppearance(), refreshNav().

   Opciones por página, en <body>:
     data-shell="full"     nav completa (por defecto)
     data-shell="minimal"  logo + volver + acciones (lector, ficha)
     data-shell="none"     sin nav (pantallas a pantalla completa)
     data-shell-back="/ruta"  destino del botón volver en modo minimal
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── 1. Apariencia ─────────────────────────────────────────────── */
  var STORE_KEY = 'kami_appearance';
  var DEFAULTS = { theme: 'dark', accent: 'shinku', custom: '', density: 'comfy', text: 'md', font: 'jakarta', glow: 'on', motion: 'system', skin: 'none', ambient: 'off', gradient: 'off' };
  // Ambientes del modo premium (solo en tema oscuro)
  var SKINS = [
    { id: 'none', name: 'Clásico', desc: 'El negro de KamiTales', colors: ['#0a0912', '#ff3b6b'] },
    { id: 'aurora', name: 'Aurora', desc: 'Azul profundo y luces boreales', colors: ['#060a14', '#22d3ee'] },
    { id: 'kin', name: 'Kin', desc: 'Negro cálido y oro', colors: ['#0d0a06', '#f5c842'] },
    { id: 'tokyo', name: 'Neón Tokio', desc: 'Violeta eléctrico y rejilla', colors: ['#09061a', '#b56bff'] },
    { id: 'sakura', name: 'Sakura', desc: 'Ciruela nocturna y rosa', colors: ['#10070f', '#ff8fcf'] },
  ];
  function isPremium() { var u = getUser(); return !!(u && (u.isPremium || u.isOwner || u.role === 'admin')); }
  var ACCENTS = [
    { id: 'shinku', name: 'Shinku', color: '#ff3b6b' },
    { id: 'sakura', name: 'Sakura', color: '#ff5fbf' },
    { id: 'denki', name: 'Denki', color: '#22d3ee' },
    { id: 'matcha', name: 'Matcha', color: '#3ee08f' },
    { id: 'kin', name: 'Kin', color: '#f5b83d' },
    { id: 'murasaki', name: 'Murasaki', color: '#9d7bff' },
  ];

  function readPrefs() {
    var p = {};
    try { p = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { p = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = p[k] != null ? p[k] : DEFAULTS[k];
    return out;
  }
  function writePrefs(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* almacenamiento bloqueado */ } }

  function luminance(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0;
    var n = parseInt(m[1], 16), rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  function applyPrefs(p) {
    var r = document.documentElement;
    if (p.theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', p.theme);
    r.setAttribute('data-density', p.density);
    r.setAttribute('data-text', p.text);
    r.setAttribute('data-font', p.font);
    r.setAttribute('data-glow', p.glow);
    if (p.motion === 'system') r.removeAttribute('data-motion'); else r.setAttribute('data-motion', p.motion);
    if (p.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(p.custom)) {
      r.setAttribute('data-accent', 'custom');
      r.style.setProperty('--k-accent', p.custom);
      var light = luminance(p.custom) > 0.45;
      r.style.setProperty('--k-on-accent', light ? '#0b0a12' : '#ffffff');
      r.style.setProperty('--k-accent-fill', light ? 'var(--k-accent)' : 'color-mix(in oklab, var(--k-accent), #000 24%)');
    } else {
      r.setAttribute('data-accent', p.accent);
      r.style.removeProperty('--k-accent');
      r.style.removeProperty('--k-on-accent');
      r.style.removeProperty('--k-accent-fill');
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = (p.theme === 'light') ? '#f3f2f7' : '#0a0912';
    if (p.font === 'legible') ensureFont('legible', 'family=Atkinson+Hyperlegible:wght@400;700');
    // Modo premium
    var prem = isPremium();
    if (prem) r.setAttribute('data-premium', ''); else r.removeAttribute('data-premium');
    if (prem && p.skin && p.skin !== 'none') r.setAttribute('data-skin', p.skin); else r.removeAttribute('data-skin');
    if (prem && p.ambient === 'on') r.setAttribute('data-ambient', 'on'); else r.removeAttribute('data-ambient');
    if (prem && p.gradient === 'on') r.setAttribute('data-gradient', 'on'); else r.removeAttribute('data-gradient');
  }

  var prefs = readPrefs();
  applyPrefs(prefs);

  /* ── Sesión en las llamadas a la API ───────────────────────────────
     Las rutas que escriben exigen sesión. Si una página llama a /api/ sin
     cabecera Authorization, se añade aquí el token guardado. */
  if (window.fetch && !window.fetch.__kami) {
    var nativeFetch = window.fetch;
    var wrapped = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var sameApi = /^\/api\//.test(url) || url.indexOf(location.origin + '/api/') === 0;
        var tok = sameApi ? localStorage.getItem('kami_token') : null;
        if (tok && typeof input === 'string') {
          init = init || {};
          var h = new Headers(init.headers || {});
          if (!h.has('Authorization')) { h.set('Authorization', 'Bearer ' + tok); init = Object.assign({}, init, { headers: h }); }
        }
      } catch (e) { /* sin almacenamiento: la llamada sigue igual */ }
      return nativeFetch.call(this, input, init);
    };
    wrapped.__kami = true;
    window.fetch = wrapped;
  }

  /* ── Recursos comunes (fuentes e iconos) ───────────────────────── */
  function ensureFont(id, query) {
    if (document.getElementById('k-font-' + id)) return;
    var l = document.createElement('link');
    l.id = 'k-font-' + id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?' + query + '&display=swap';
    document.head.appendChild(l);
  }
  ensureFont('core', 'family=Big+Shoulders+Display:wght@700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&family=Noto+Sans+JP:wght@500;700');
  if (!document.querySelector('link[href*="tabler-icons"]')) {
    var ti = document.createElement('link');
    ti.rel = 'stylesheet';
    ti.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css';
    document.head.appendChild(ti);
  }

  /* ── Utilidades ────────────────────────────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function getUser() { try { return JSON.parse(localStorage.getItem('kami_user') || 'null'); } catch (e) { return null; } }
  function getToken() { try { return localStorage.getItem('kami_token'); } catch (e) { return null; } }
  function isLogged() { return !!(getUser() && getToken()); }

  var ROUTES = {
    home: '/', explore: '/', community: '/comunidad', library: '/biblioteca', genres: '/generos',
    studio: '/estudio', profile: '/perfil', messages: '/mensajes', premium: '/premium',
    settings: '/ajustes', login: '/acceder', register: '/registro', search: '/buscar', design: '/design',
  };
  var LINKS = [
    { key: 'explore', label: 'Explorar', icon: 'ti-compass' },
    { key: 'community', label: 'Comunidad', icon: 'ti-messages' },
    { key: 'library', label: 'Biblioteca', icon: 'ti-books' },
    { key: 'studio', label: 'Estudio', icon: 'ti-pencil-plus' },
  ];

  // Sección activa según la URL
  function activeKey() {
    var p = location.pathname;
    if (p === '/' || p === '/explorar' || /^\/(obra\/[^/]+$|generos|buscar|leer\/)/.test(p)) return 'explore';
    if (/^\/comunidad/.test(p)) return 'community';
    if (/^\/biblioteca/.test(p)) return 'library';
    if (/^\/estudio|^\/obra\/[^/]+\/(editar|nuevo-capitulo)/.test(p)) return 'studio';
    if (/^\/perfil/.test(p)) return 'profile';
    return null;
  }

  /* ── 2. Nav ────────────────────────────────────────────────────── */
  function avatarHTML(u, cls) {
    cls = cls || '';
    var initial = esc((u && u.username || '?').charAt(0).toUpperCase());
    if (u && u.avatar && /^(\/|https?:|data:image)/.test(u.avatar)) return '<span class="k-avatar ' + cls + '"><img src="' + esc(u.avatar) + '" alt=""></span>';
    var style = (u && u.avatarColor && /^#[0-9a-f]{3,8}$/i.test(u.avatarColor)) ? ' style="background:' + u.avatarColor + '"' : '';
    return '<span class="k-avatar ' + cls + '"' + style + '>' + initial + '</span>';
  }

  function buildNav(mode) {
    var key = activeKey();
    var user = getUser(), logged = isLogged();
    var nav = document.createElement('header');
    nav.className = 'k-nav' + (mode === 'minimal' ? ' k-nav--minimal' : '');
    nav.id = 'k-nav';

    var back = '';
    if (mode === 'minimal') {
      var dest = document.body.getAttribute('data-shell-back') || '';
      back = '<a class="k-btn k-btn--quiet k-btn--icon k-nav__back" href="' + esc(dest || ROUTES.explore) + '" data-k-back="' + (dest ? '' : '1') + '" aria-label="Volver"><i class="ti ti-arrow-left"></i></a>';
    }

    var links = LINKS.filter(function (l) { return l.key !== 'studio' || logged; }).map(function (l) {
      return '<li><a class="k-nav__link" href="' + ROUTES[l.key] + '"' + (key === l.key ? ' aria-current="page"' : '') + '><i class="ti ' + l.icon + '" aria-hidden="true"></i><span>' + l.label + '</span></a></li>';
    }).join('');

    var actions;
    if (logged) {
      actions =
        '<a class="k-btn k-btn--quiet k-btn--icon k-nav__mobile-only" href="' + ROUTES.search + '" aria-label="Buscar"><i class="ti ti-search"></i></a>' +
        '<a class="k-btn k-btn--quiet k-btn--icon k-nav__icon" href="' + ROUTES.messages + '" aria-label="Mensajes"><i class="ti ti-mail"></i></a>' +
        '<a class="k-btn k-btn--quiet k-btn--icon k-nav__icon" href="' + ROUTES.community + '#notificaciones" aria-label="Notificaciones" id="k-notif"><i class="ti ti-bell"></i></a>' +
        '<div class="k-nav__avatar">' +
          '<button type="button" id="k-avatar-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="k-user-menu" aria-label="Menú de ' + esc(user.username || 'usuario') + '">' + avatarHTML(user) + '</button>' +
          '<div class="k-menu" id="k-user-menu" role="menu">' +
            '<div class="k-menu__head"><div style="font-weight:700">' + esc(user.username || 'Usuario') + '</div><div class="k-faint" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">' + esc(user.email || '') + '</div></div>' +
            '<a role="menuitem" class="k-menu__item" href="' + ROUTES.profile + '"><i class="ti ti-user"></i>Mi perfil</a>' +
            '<a role="menuitem" class="k-menu__item" href="' + ROUTES.library + '"><i class="ti ti-books"></i>Mi biblioteca</a>' +
            '<a role="menuitem" class="k-menu__item" href="' + ROUTES.studio + '"><i class="ti ti-pencil-plus"></i>Estudio</a>' +
            '<a role="menuitem" class="k-menu__item" href="' + ROUTES.premium + '"><i class="ti ti-crown"></i>Premium</a>' +
            '<a role="menuitem" class="k-menu__item" href="/monedas"><i class="ti ti-coin"></i>Monedas</a>' +
            '<div class="k-menu__sep"></div>' +
            '<button role="menuitem" type="button" class="k-menu__item" data-k-appearance><i class="ti ti-palette"></i>Apariencia</button>' +
            '<a role="menuitem" class="k-menu__item" href="' + ROUTES.settings + '"><i class="ti ti-settings"></i>Configuración</a>' +
            '<div class="k-menu__sep"></div>' +
            '<button role="menuitem" type="button" class="k-menu__item k-menu__item--danger" data-k-logout><i class="ti ti-logout"></i>Cerrar sesión</button>' +
          '</div>' +
        '</div>';
    } else {
      actions =
        '<a class="k-btn k-btn--quiet k-btn--icon k-nav__mobile-only" href="' + ROUTES.search + '" aria-label="Buscar"><i class="ti ti-search"></i></a>' +
        '<button type="button" class="k-btn k-btn--quiet k-btn--icon" data-k-appearance aria-label="Apariencia"><i class="ti ti-palette"></i></button>' +
        '<span class="k-nav__auth-desktop"><a class="k-btn k-btn--secondary" href="' + ROUTES.login + '">Acceder</a></span>' +
        '<a class="k-btn k-btn--primary" href="' + ROUTES.register + '">Crear cuenta</a>';
    }

    nav.innerHTML =
      '<a class="k-skip" href="#k-main">Saltar al contenido</a>' + back +
      '<a class="k-nav__brand" href="' + ROUTES.explore + '" aria-label="KamiTales, inicio"><span class="k-nav__mark" aria-hidden="true">神</span><span class="k-nav__word" translate="no">Kami<b>Tales</b></span></a>' +
      (mode === 'minimal' ? '' : '<ul class="k-nav__links">' + links + '</ul>') +
      (mode === 'minimal' ? '' : '<form class="k-nav__search" role="search" action="' + ROUTES.search + '"><label class="k-visually-hidden" for="k-nav-q">Buscar obras, autores y comunidades</label><div class="k-input-group"><i class="ti ti-search" aria-hidden="true"></i><input class="k-input" id="k-nav-q" name="q" type="search" placeholder="Buscar obras, autores…" autocomplete="off"></div></form>') +
      '<div class="k-nav__actions">' + actions + '</div>';
    return nav;
  }

  function buildTabbar() {
    var key = activeKey(), logged = isLogged();
    var items = [
      { k: 'explore', href: ROUTES.explore, icon: 'ti-compass', label: 'Explorar' },
      { k: 'community', href: ROUTES.community, icon: 'ti-messages', label: 'Comunidad' },
      { k: 'studio', href: logged ? ROUTES.studio : ROUTES.register, icon: 'ti-plus', label: 'Crear', create: true },
      { k: 'library', href: ROUTES.library, icon: 'ti-books', label: 'Biblioteca' },
      logged ? { k: 'profile', href: ROUTES.profile, icon: 'ti-user-circle', label: 'Perfil' } : { k: 'login', href: ROUTES.login, icon: 'ti-login', label: 'Acceder' },
    ];
    var bar = document.createElement('nav');
    bar.className = 'k-tabbar'; bar.id = 'k-tabbar'; bar.setAttribute('aria-label', 'Navegación principal');
    bar.innerHTML = items.map(function (i) {
      return '<a href="' + i.href + '"' + (i.create ? ' class="k-tabbar__create"' : '') + (key === i.k ? ' aria-current="page"' : '') + '><i class="ti ' + i.icon + '" aria-hidden="true"></i>' + i.label + '</a>';
    }).join('');
    return bar;
  }

  /* ── 3. Panel de apariencia ────────────────────────────────────── */
  function seg(name, current, options) {
    return '<div class="k-segmented" role="group" data-k-pref="' + name + '">' + options.map(function (o) {
      return '<button type="button" value="' + o[0] + '" aria-pressed="' + (current === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function premiumGroup(p) {
    var prem = isPremium();
    return '<div class="k-sheet__group k-premium-group' + (prem ? '' : ' is-locked') + '"><h3><i class="ti ti-crown" aria-hidden="true"></i> Modo premium' + (prem ? '' : ' <span class="k-badge k-badge--gold">Premium</span>') + '</h3>' +
      '<div class="k-skins" data-k-skins>' + SKINS.map(function (s) {
        return '<button type="button" class="k-skin" value="' + s.id + '" aria-pressed="' + (p.skin === s.id) + '"' + (prem ? '' : ' disabled') + ' style="--_a:' + s.colors[0] + ';--_b:' + s.colors[1] + '"><span class="k-skin__art" aria-hidden="true"></span><b>' + s.name + '</b></button>';
      }).join('') + '</div>' +
      '<label class="k-switch"><input type="checkbox" id="k-pref-ambient"' + (p.ambient === 'on' ? ' checked' : '') + (prem ? '' : ' disabled') + '>Fondo animado</label>' +
      '<label class="k-switch"><input type="checkbox" id="k-pref-gradient"' + (p.gradient === 'on' ? ' checked' : '') + (prem ? '' : ' disabled') + '>Acento degradado</label>' +
      (prem ? '' : '<a class="k-btn k-btn--secondary k-btn--sm" href="' + ROUTES.premium + '"><i class="ti ti-crown" aria-hidden="true"></i>Desbloquear con Premium</a>') +
    '</div>';
  }

  function buildSheet() {
    var p = prefs;
    var sheet = document.createElement('div');
    sheet.className = 'k-sheet'; sheet.id = 'k-appearance';
    sheet.innerHTML =
      '<div class="k-sheet__scrim" data-k-close></div>' +
      '<section class="k-sheet__panel" role="dialog" aria-modal="true" aria-labelledby="k-ap-title">' +
        '<div class="k-row k-row--between"><h2 class="k-h2" id="k-ap-title">Apariencia</h2><button type="button" class="k-btn k-btn--quiet k-btn--icon" data-k-close aria-label="Cerrar"><i class="ti ti-x"></i></button></div>' +
        '<p class="k-muted" style="margin:-12px 0 0;font-size:14px">Se guarda en este navegador y se aplica a todo KamiTales.</p>' +
        '<div class="k-sheet__group"><h3>Tema</h3>' + seg('theme', p.theme, [['dark', 'Noche'], ['light', 'Washi'], ['system', 'Sistema']]) + '</div>' +
        '<div class="k-sheet__group"><h3>Color de acento</h3><div class="k-swatches" data-k-accents>' +
          ACCENTS.map(function (a) { return '<button type="button" class="k-swatch" style="--_c:' + a.color + '" value="' + a.id + '" aria-label="' + a.name + '" title="' + a.name + '" aria-pressed="' + (p.accent === a.id) + '"></button>'; }).join('') +
          '<label class="k-swatch k-swatch--custom" title="Color propio" aria-pressed="' + (p.accent === 'custom') + '"><span class="k-visually-hidden">Color propio</span><input type="color" id="k-accent-custom" value="' + (p.custom || '#ff3b6b') + '"></label>' +
        '</div></div>' +
        '<div class="k-sheet__group"><h3>Tamaño del texto</h3>' + seg('text', p.text, [['sm', 'S'], ['md', 'M'], ['lg', 'L'], ['xl', 'XL']]) + '</div>' +
        '<div class="k-sheet__group"><h3>Densidad</h3>' + seg('density', p.density, [['comfy', 'Cómoda'], ['compact', 'Compacta']]) + '</div>' +
        '<div class="k-sheet__group"><h3>Letra</h3>' + seg('font', p.font, [['jakarta', 'KamiTales'], ['legible', 'Alta legibilidad']]) + '</div>' +
        premiumGroup(p) +
        '<div class="k-sheet__group"><h3>Efectos</h3>' +
          '<label class="k-switch"><input type="checkbox" id="k-pref-glow"' + (p.glow === 'on' ? ' checked' : '') + '>Brillo neón</label>' +
          '<label class="k-switch"><input type="checkbox" id="k-pref-motion"' + (p.motion === 'reduce' ? ' checked' : '') + '>Reducir animaciones</label>' +
        '</div>' +
        '<div class="k-preview-card" aria-hidden="true"><span class="k-eyebrow">Vista previa</span><div class="k-row"><span class="k-badge k-badge--accent">Nuevo cap.</span><span class="k-badge k-badge--gold">Exclusiva</span></div><div class="k-row"><span class="k-btn k-btn--primary k-btn--sm">Leer ahora</span><span class="k-btn k-btn--secondary k-btn--sm">Seguir</span></div></div>' +
        '<button type="button" class="k-btn k-btn--quiet" data-k-reset><i class="ti ti-restore"></i>Restablecer</button>' +
      '</section>';
    return sheet;
  }

  var lastFocus = null;
  function openAppearance() {
    var s = document.getElementById('k-appearance'); if (!s) return;
    lastFocus = document.activeElement;
    s.classList.add('is-open');
    var first = s.querySelector('.k-segmented button[aria-pressed="true"]'); if (first) first.focus();
    closeMenu();
  }
  function closeAppearance() {
    var s = document.getElementById('k-appearance'); if (!s) return;
    s.classList.remove('is-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function setPref(k, v) {
    prefs[k] = v; writePrefs(prefs); applyPrefs(prefs);
    document.dispatchEvent(new CustomEvent('kami:appearance', { detail: Object.assign({}, prefs) }));
  }

  function bindSheet(sheet) {
    sheet.addEventListener('click', function (e) {
      var t = e.target.closest('button, [data-k-close]'); if (!t) return;
      if (t.hasAttribute('data-k-close')) return closeAppearance();
      if (t.hasAttribute('data-k-reset')) { prefs = Object.assign({}, DEFAULTS); writePrefs(prefs); applyPrefs(prefs); var fresh = buildSheet(); sheet.replaceWith(fresh); bindSheet(fresh); fresh.classList.add('is-open'); return; }
      var group = t.closest('[data-k-pref]');
      if (group) { group.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); return setPref(group.getAttribute('data-k-pref'), t.value); }
      if (t.closest('[data-k-skins]') && t.classList.contains('k-skin')) {
        sheet.querySelectorAll('.k-skin').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
        return setPref('skin', t.value);
      }
      if (t.closest('[data-k-accents]') && t.classList.contains('k-swatch')) {
        sheet.querySelectorAll('.k-swatch').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
        return setPref('accent', t.value);
      }
    });
    var custom = sheet.querySelector('#k-accent-custom');
    custom.addEventListener('input', function () {
      sheet.querySelectorAll('.k-swatch').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      custom.parentNode.setAttribute('aria-pressed', 'true');
      prefs.custom = custom.value; setPref('accent', 'custom');
    });
    sheet.querySelector('#k-pref-glow').addEventListener('change', function (e) { setPref('glow', e.target.checked ? 'on' : 'off'); });
    sheet.querySelector('#k-pref-motion').addEventListener('change', function (e) { setPref('motion', e.target.checked ? 'reduce' : 'system'); });
    sheet.querySelector('#k-pref-ambient').addEventListener('change', function (e) { setPref('ambient', e.target.checked ? 'on' : 'off'); });
    sheet.querySelector('#k-pref-gradient').addEventListener('change', function (e) { setPref('gradient', e.target.checked ? 'on' : 'off'); });
  }

  /* ── Menú de usuario ───────────────────────────────────────────── */
  function closeMenu() {
    var m = document.getElementById('k-user-menu'), b = document.getElementById('k-avatar-btn');
    if (m) m.classList.remove('is-open'); if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    var m = document.getElementById('k-user-menu'), b = document.getElementById('k-avatar-btn'); if (!m) return;
    var open = !m.classList.contains('is-open');
    m.classList.toggle('is-open', open); b.setAttribute('aria-expanded', String(open));
    if (open) { var f = m.querySelector('.k-menu__item'); if (f) f.focus(); }
  }

  function logout() {
    try { localStorage.removeItem('kami_token'); localStorage.removeItem('kami_user'); } catch (e) { /* nada */ }
    location.href = ROUTES.explore;
  }

  /* ── Toast ─────────────────────────────────────────────────────── */
  function toast(msg, type) {
    var box = document.getElementById('k-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'k-toasts'; box.className = 'k-toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var icon = type === 'ok' ? 'ti-circle-check' : type === 'bad' ? 'ti-alert-circle' : 'ti-info-circle';
    var el = document.createElement('div');
    el.className = 'k-toast' + (type ? ' k-toast--' + type : '');
    el.innerHTML = '<i class="ti ' + icon + '" aria-hidden="true"></i><span></span>';
    el.querySelector('span').textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 220); }, 3200);
  }

  /* ── Notificaciones sin leer ───────────────────────────────────── */
  function loadUnread() {
    var t = getToken(), a = document.getElementById('k-notif'); if (!t || !a || !window.fetch) return;
    fetch('/api/notifications/unread-count', { headers: { Authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var n = d && (d.count != null ? d.count : d.unread); if (!n) return;
        var c = document.createElement('span'); c.className = 'k-count'; c.textContent = n > 99 ? '99+' : n;
        a.appendChild(c); a.setAttribute('aria-label', 'Notificaciones, ' + n + ' sin leer');
      }).catch(function () { /* sin conexión o sin sesión */ });
  }

  /* ── Montaje ───────────────────────────────────────────────────── */
  function mount() {
    var body = document.body;
    var mode = body.getAttribute('data-shell') || 'full';
    // Quitar la nav antigua si alguna página la trae en el HTML
    document.querySelectorAll('body > nav.nf-nav, body > .netflix-nav').forEach(function (n) { n.remove(); });
    body.classList.add('k-has-shell');
    if (!document.getElementById('k-main')) {
      var main = document.querySelector('main') || body.querySelector(':scope > :not(script):not(style)');
      if (main && !main.id) main.id = 'k-main';
    }
    if (mode !== 'none') {
      var nav = buildNav(mode);
      body.insertBefore(nav, body.firstChild);
      window.addEventListener('scroll', function () { nav.classList.toggle('is-scrolled', window.scrollY > 8); }, { passive: true });
      var backBtn = nav.querySelector('[data-k-back="1"]');
      if (backBtn) backBtn.addEventListener('click', function (e) { if (history.length > 1 && document.referrer.indexOf(location.host) >= 0) { e.preventDefault(); history.back(); } });
    }
    if (mode === 'full') { body.appendChild(buildTabbar()); body.classList.add('k-has-tabbar'); }
    var sheet = buildSheet(); body.appendChild(sheet); bindSheet(sheet);

    document.addEventListener('click', function (e) {
      if (e.target.closest('#k-avatar-btn')) { e.stopPropagation(); return toggleMenu(); }
      if (e.target.closest('[data-k-appearance]')) { e.preventDefault(); return openAppearance(); }
      if (e.target.closest('[data-k-logout]')) return logout();
      if (!e.target.closest('#k-user-menu')) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      var sheetOpen = document.getElementById('k-appearance').classList.contains('is-open');
      if (e.key === 'Tab' && sheetOpen) { // mantener el foco dentro del panel
        var f = document.querySelectorAll('#k-appearance .k-sheet__panel button, #k-appearance .k-sheet__panel input');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key !== 'Escape') return;
      if (document.getElementById('k-appearance').classList.contains('is-open')) closeAppearance(); else closeMenu();
    });
    var q = new URLSearchParams(location.search).get('q'), qi = document.getElementById('k-nav-q');
    if (q && qi) qi.value = q;
    loadUnread();
    refreshPlan();
    if (/[?&]cuenta=eliminada/.test(location.search)) setTimeout(function () { toast('Tu cuenta se ha eliminado. Gracias por haber pasado por KamiTales.'); }, 300);
  }

  function refreshPlan(force) {
    var t = getToken(); if (!t || !window.fetch) return;
    try { if (!force && sessionStorage.getItem('kami_plan_checked')) return; } catch (e) { /* nada */ }
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.user) return;
        var u = getUser() || {}, before = isPremium();
        u.isPremium = !!d.user.isPremium; u.isOwner = !!d.user.isOwner; u.role = d.user.role;
        try { localStorage.setItem('kami_user', JSON.stringify(u)); sessionStorage.setItem('kami_plan_checked', '1'); } catch (e) { /* nada */ }
        if (before !== isPremium()) { applyPrefs(prefs); var s = document.getElementById('k-appearance'); if (s) { var fresh = buildSheet(); s.replaceWith(fresh); bindSheet(fresh); } }
      }).catch(function () { /* sin conexión */ });
  }

  function refreshNav() {
    var old = document.getElementById('k-nav'), oldBar = document.getElementById('k-tabbar');
    var mode = document.body.getAttribute('data-shell') || 'full';
    if (old) old.replaceWith(buildNav(mode));
    if (oldBar) oldBar.replaceWith(buildTabbar());
    loadUnread();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  /* ── API pública ───────────────────────────────────────────────── */
  window.KAMI = {
    theme: { get: function () { return Object.assign({}, prefs); }, set: setPref, accents: ACCENTS, skins: SKINS, defaults: DEFAULTS, isPremium: isPremium, refreshPlan: refreshPlan },
    toast: toast, openAppearance: openAppearance, refreshNav: refreshNav, logout: logout, routes: ROUTES,
  };
  // Compatibilidad con el código que llamaba a menu-global.js
  window.kamiRefreshNav = refreshNav;
  window.kamiLogout = logout;
  window.nfToggleDD = function (e) { if (e) e.stopPropagation(); toggleMenu(); };
  window.nfToggleSearch = function () { var i = document.getElementById('k-nav-q'); if (i) i.focus(); else location.href = ROUTES.search; };
})();
