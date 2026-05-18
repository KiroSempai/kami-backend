// KAMI — Nav global Netflix-style
// Barra horizontal oscura minimalista, sticky, con scroll effect

(function () {
  'use strict';

  var old = document.querySelector('.netflix-nav, .nav');
  if (old) old.remove();

  // ── Rutas ──
  var IS_LOCAL = window.location.protocol === 'file:';
  function pg(page) {
    if (IS_LOCAL) return page === 'index' ? 'index.html' : page + '.html';
    return page === 'index' ? '/' : '/' + page;
  }
  var R = {
    index: pg('index'), login: pg('login'), register: pg('register'),
    mangoteca: pg('mangoteca'), biblioteca: pg('biblioteca'), generos: pg('generos'),
    perfil: pg('perfil'), settings: pg('settings'),
  };

  // ── Auth ──
  function getUser() { try { return JSON.parse(localStorage.getItem('kami_user') || 'null'); } catch { return null; } }
  function getToken() { return localStorage.getItem('kami_token'); }

  // ── Link activo ──
  var path = window.location.pathname;
  var linkDefs = [
    { href: R.index, label: 'Comunidad' },
    { href: R.mangoteca, label: 'Mangoteca' },
    { href: R.biblioteca, label: 'Biblioteca' },
    { href: R.generos, label: 'Géneros' },
    { href: R.perfil, label: 'Perfil' },
  ];

  var activeIdx = -1;
  for (var i = 0; i < linkDefs.length; i++) {
    var l = linkDefs[i];
    if (l.href === (IS_LOCAL ? 'index.html' : '/') && path === (IS_LOCAL ? '' : '/')) { activeIdx = i; break; }
    if (l.href !== (IS_LOCAL ? 'index.html' : '/') && path.indexOf(l.href.replace(/^\//, '')) >= 0) { activeIdx = i; break; }
  }

  var linksHTML = '';
  for (var j = 0; j < linkDefs.length; j++) {
    var ld = linkDefs[j];
    var active = j === activeIdx ? ' active' : '';
    linksHTML += '<li><a href="' + ld.href + '" class="nf-link' + active + '">' + ld.label + '</a></li>';
  }

  // ── Construir nav ──
  var nav = document.createElement('nav');
  nav.className = 'nf-nav';
  nav.innerHTML =
    '<div class="nf-left">' +
      '<a href="' + R.index + '" class="nf-logo">' +
        '<img src="/assets/logo-kami.png" alt="KAMI" class="nf-logo-img">' +
        '<span class="nf-logo-text">KAMI</span>' +
      '</a>' +
      '<ul class="nf-links">' + linksHTML + '</ul>' +
    '</div>' +
    '<div class="nf-right" id="nf-right"></div>';

  document.body.insertBefore(nav, document.body.firstChild);

  // ── Scroll effect ──
  window.addEventListener('scroll', function() {
    nav.classList.toggle('nf-scrolled', window.scrollY > 50);
  });

  // ── Render right side ──
  renderRight();

  function renderRight() {
    var container = document.getElementById('nf-right');
    if (!container) return;
    var user = getUser();
    if (user && getToken()) {
      container.innerHTML = buildLoggedIn(user);
    } else {
      container.innerHTML = buildLoggedOut();
    }
    bindEvents();
  }

  function initials(u) { return (u.username || '?').charAt(0).toUpperCase(); }

  function buildLoggedIn(u) {
    var avStyle = 'background:linear-gradient(135deg,#e8344a,#f5c842);';
    var avContent = initials(u);
    if (u.avatar && (u.avatar.indexOf('/') === 0 || u.avatar.indexOf('http') === 0 || u.avatar.indexOf('data:') === 0)) {
      avStyle = 'background:rgba(232,52,74,0.08);padding:0;';
      avContent = '<img src="' + u.avatar + '" alt="">';
    } else if (u.avatarColor) {
      avStyle = 'background:' + u.avatarColor + ';';
    }
    return '' +
      '<button class="nf-icon-btn" onclick="nfToggleSearch()" title="Buscar"><i class="ti ti-search"></i></button>' +
      '<button class="nf-icon-btn" title="Notificaciones"><i class="ti ti-bell"></i></button>' +
      '<div class="nf-avatar-wrap">' +
        '<div class="nf-avatar" id="nf-avatar" onclick="nfToggleDD(event)" style="' + avStyle + '">' + avContent + '</div>' +
        '<div class="nf-dropdown" id="nf-dropdown">' +
          '<div class="nf-dd-header">' +
            '<div class="nf-dd-name">' + (u.username || 'Usuario') + '</div>' +
            '<div class="nf-dd-email">' + (u.email || '') + '</div>' +
          '</div>' +
          '<a href="' + R.perfil + '" class="nf-dd-item"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg> Mi Perfil</a>' +
          '<a href="' + R.biblioteca + '" class="nf-dd-item"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> Mi Biblioteca</a>' +
          '<a href="' + R.settings + '" class="nf-dd-item"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Configuración</a>' +
          '<div class="nf-dd-divider"></div>' +
          '<div onclick="kamiLogout()" class="nf-dd-item nf-dd-danger"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Cerrar sesión</div>' +
        '</div>' +
      '</div>';
  }

  function buildLoggedOut() {
    return '' +
      '<button class="nf-icon-btn" onclick="nfToggleSearch()" title="Buscar"><i class="ti ti-search"></i></button>' +
      '<a href="' + R.login + '" class="nf-btn nf-btn-ghost">Acceder</a>' +
      '<a href="' + R.register + '" class="nf-btn nf-btn-primary">Registrarse</a>';
  }

  function bindEvents() {
    document.addEventListener('click', function(e) {
      var wrap = document.querySelector('.nf-avatar-wrap');
      var dd = document.getElementById('nf-dropdown');
      if (wrap && dd && !wrap.contains(e.target) && !dd.contains(e.target)) {
        dd.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var dd = document.getElementById('nf-dropdown');
        if (dd) dd.classList.remove('open');
      }
    });
  }

  // ── Global functions ──
  window.nfToggleDD = function(e) {
    if (e) e.stopPropagation();
    document.getElementById('nf-dropdown').classList.toggle('open');
  };

  window.nfToggleSearch = function() {
    // Placeholder
  };

  window.kamiLogout = function() {
    localStorage.removeItem('kami_token');
    localStorage.removeItem('kami_user');
    window.location.href = R.index;
  };

  window.kamiRefreshNav = function() { renderRight(); };

})();
