// KAMI — feed-tracker.js
// Recolección de señales de interacción para el algoritmo Manga Mixer

(function () {
  'use strict';

  function getToken() { return localStorage.getItem('kami_token'); }
  function api(path, opts) {
    var token = getToken();
    if (!token) return Promise.reject(new Error('No auth'));
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch('/api/feed' + path, opts).then(function(r) { if (!r.ok) throw new Error('API error'); return r.json(); });
  }

  // ── Interacciones con posts ──
  window.feedInteract = function(postId, type, metadata) {
    return api('/interact', {
      method: 'POST',
      body: { post_id: postId, interaction_type: type, metadata: metadata || {} }
    }).catch(function() {});
  };

  // ── Ocultar post / No me interesa ──
  window.feedHidePost = function(postId, mangaId) {
    return feedInteract(postId, 'hide', { manga_id: mangaId });
  };

  // ── Silenciar usuario ──
  window.feedMuteUser = function(postId, username) {
    return feedInteract(postId, 'mute', { username: username });
  };

  // ── Spoiler revelado ──
  window.feedSpoilerRevealed = function(postId) {
    return feedInteract(postId, 'spoiler_revealed');
  };

  // ── Preferencias de feed ──
  window.feedPref = function(type, value, action) {
    return api('/preferences', {
      method: 'POST',
      body: { pref_type: type, pref_value: value, action: action || 'add' }
    }).catch(function() {});
  };

  // ── Ocultar género ──
  window.feedHideGenre = function(genre) {
    return feedPref('hidden_genre', genre);
  };

  // ── Solicitar feed personalizado ──
  window.feedFetch = function(type, offset) {
    type = type || 'for-you';
    offset = offset || 0;
    return api('/' + type + '?limit=25&offset=' + offset);
  };

  // ── Integración con la UI existente ──
  // Reemplaza mockPosts cuando se usa la API real
  window.feedReplaceMock = false; // cambiar a true para usar API real

  console.log('[feed-tracker] Cargado');

})();
