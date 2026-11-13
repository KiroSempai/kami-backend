/* KamiTales — piezas comunes de Buscar y Géneros. */
(function () {
  'use strict';
  var TYPE = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', oneshot: 'One-shot', novel: 'Novela', comic: 'Cómic', webtoon: 'Webtoon' };
  var STATUS = { ongoing: 'En curso', completed: 'Completa', hiatus: 'En pausa', cancelled: 'Cancelada' };
  var COLORS = ['#ff3b6b', '#9d7bff', '#22d3ee', '#f5b83d', '#3ee08f', '#ff5fbf', '#60a5fa', '#fb923c'];
  var nf = new Intl.NumberFormat('es');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  // Resalta el texto buscado (sin distinguir tildes) sin romper el escapado
  function mark(text, q) {
    text = String(text || ''); if (!q) return esc(text);
    var t = norm(text), n = norm(q).trim(); if (!n) return esc(text);
    var i = t.indexOf(n); if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + n.length)) + '</mark>' + esc(text.slice(i + n.length));
  }
  function colorFor(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function safeImg(u) { return typeof u === 'string' && /^(https?:\/\/|\/)[^\s"'<>()]*$/.test(u) ? u : ''; }

  function work(m, q) {
    var img = safeImg(m.cover);
    var meta = [TYPE[m.type] || m.type || '', STATUS[m.status] || '', m.totalChapters ? m.totalChapters + ' cap.' : ''].filter(Boolean);
    var r = parseFloat(m.rating);
    return '<a class="k-cover" href="/obra/' + encodeURIComponent(m.id) + '"><div class="k-cover__art">' +
      (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" width="300" height="450">' : '<span class="ct-ph" style="--_c:' + colorFor(m.title) + '" aria-hidden="true">' + esc((m.title || '?').slice(0, 2)) + '</span>') +
      '<div class="k-cover__badges">' + (m.type === 'novel' ? '<span class="k-badge k-badge--info">Novela</span>' : '') + '</div></div>' +
      '<div class="k-cover__title">' + mark(m.title, q) + '</div>' +
      (m.author ? '<div class="k-cover__meta"><span>' + mark(m.author, q) + '</span></div>' : '') +
      '<div class="k-cover__meta"><span>' + esc(meta.join(' · ')) + '</span>' + (r ? '<span class="k-num">' + r.toFixed(1).replace('.', ',') + ' ★</span>' : '') + '</div></a>';
  }
  function person(u, q) {
    var av = safeImg(u.avatar);
    return '<a class="ct-person" href="/perfil/' + encodeURIComponent(u.username) + '"><span class="k-avatar" style="background:' + colorFor(u.username) + '">' +
      (av ? '<img src="' + esc(av) + '" alt="" style="width:100%;height:100%;object-fit:cover">' : esc((u.avatar && u.avatar.length <= 3 ? u.avatar : u.username.slice(0, 2)).toUpperCase())) + '</span>' +
      '<span style="min-width:0"><b>' + mark(u.username, q) + '</b>' + (u.bio ? '<p>' + esc(u.bio) + '</p>' : '') +
      '<span class="ct-meta"><span>' + nf.format(u.followers || 0) + (u.followers === 1 ? ' seguidor' : ' seguidores') + '</span>' + (u.works ? '<span>' + u.works + (u.works === 1 ? ' obra' : ' obras') + '</span>' : '') + '</span></span></a>';
  }
  function community(c, q) {
    var img = safeImg(c.avatar) || safeImg(c.cover);
    return '<a class="ct-comm" href="/comunidad#comunidad/' + encodeURIComponent(c.id) + '"><span class="ct-comm__img" style="' + (img ? 'background-image:url(\'' + esc(img) + '\')' : 'background-color:' + colorFor(c.name)) + '">' + (img ? '' : esc(c.name.slice(0, 2).toUpperCase())) + '</span>' +
      '<span style="min-width:0"><b>' + mark(c.name, q) + '</b>' + (c.description ? '<p>' + esc(c.description) + '</p>' : '') +
      '<span class="ct-meta"><span>' + nf.format(c.members || 0) + (c.members === 1 ? ' miembro' : ' miembros') + '</span>' + (c.work ? '<span>' + esc(c.work) + '</span>' : '') + '</span></span></a>';
  }
  function genreCard(g, i, fmt) {
    var count = fmt === 'novel' ? g.novels : fmt === 'comic' ? g.comics : g.count;
    var covers = (g.covers || []).map(safeImg).filter(Boolean).slice(0, 3);
    while (covers.length < 3) covers.push('');
    var col = COLORS[i % COLORS.length];
    return '<a class="ct-gcard" style="--_g:' + col + '" href="/generos?g=' + encodeURIComponent(g.name) + '"><span class="ct-fan" aria-hidden="true">' +
      covers.map(function (c) { return c ? '<i style="background-image:url(\'' + esc(c) + '\')"></i>' : '<i class="is-empty"></i>'; }).reverse().join('') +
      '</span><b>' + esc(g.name) + '</b><span>' + count + (count === 1 ? ' obra' : ' obras') + (fmt === 'all' && g.novels ? ' · ' + g.novels + (g.novels === 1 ? ' novela' : ' novelas') : '') + '</span></a>';
  }
  function skeleton(n) { return Array.from({ length: n }).map(function () { return '<div class="k-cover" aria-hidden="true"><div class="k-cover__art k-skeleton"></div><div class="k-skeleton" style="height:12px;width:80%"></div></div>'; }).join(''); }
  function empty(icon, title, text, cta) { return '<div class="k-card" style="grid-column:1/-1"><div class="k-empty"><i class="ti ' + icon + '" aria-hidden="true"></i><h3>' + esc(title) + '</h3><p>' + text + '</p>' + (cta || '') + '</div></div>'; }
  function getJSON(url) { return fetch(url).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Error ' + r.status); e.status = r.status; throw e; } return d; }); }); }
  // Catálogo filtrado (obras). f: { q, format, status, genres[], sort, page, limit }
  function fetchWorks(f) {
    var p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.format && f.format !== 'all') p.set('format', f.format);
    if (f.status) p.set('status', f.status);
    if (f.genres && f.genres.length) p.set('genres', f.genres.join(','));
    p.set('sort', f.sort || 'popular'); p.set('page', f.page || 1); p.set('limit', f.limit || 24);
    return getJSON('/api/manga?' + p.toString());
  }
  window.KCAT = { TYPE: TYPE, STATUS: STATUS, COLORS: COLORS, esc: esc, norm: norm, mark: mark, work: work, person: person, community: community, genreCard: genreCard, skeleton: skeleton, empty: empty, getJSON: getJSON, fetchWorks: fetchWorks, nf: nf };
})();
