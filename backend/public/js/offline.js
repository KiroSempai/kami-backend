const kamiOffline = {
  CACHE_PREFIX: 'kami_cache_',

  save(key, data) {
    try {
      localStorage.setItem(this.CACHE_PREFIX + key, JSON.stringify({
        data,
        timestamp: Date.now(),
        savedAt: new Date().toISOString()
      }));
    } catch (e) {
      console.warn('[offline] save failed:', e);
    }
  },

  load(key, maxAge) {
    try {
      const raw = localStorage.getItem(this.CACHE_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return {
        data: parsed.data,
        fresh: maxAge ? (Date.now() - parsed.timestamp) < maxAge : true,
        age: Date.now() - parsed.timestamp,
        savedAt: parsed.savedAt
      };
    } catch (e) {
      return null;
    }
  },

  remove(key) {
    localStorage.removeItem(this.CACHE_PREFIX + key);
  },

  isOffline() {
    return !navigator.onLine;
  },

  async safeFetch(url, options = {}, cacheConfig = {}) {
    const { cacheKey, maxAge } = typeof cacheConfig === 'string'
      ? { cacheKey: cacheConfig, maxAge: null }
      : cacheConfig;
    const effectiveKey = cacheKey || url;

    if (!this.isOffline()) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (effectiveKey) this.save(effectiveKey, data);
          return { data, fromCache: false, ok: true };
        } else {
          console.warn('[offline] safeFetch HTTP ' + res.status + ' for', url);
        }
      } catch (e) {
        console.warn('[offline] safeFetch error for', url, ':', e.message);
      }
    }

    const cached = effectiveKey ? this.load(effectiveKey, maxAge) : null;
    if (cached) {
      return {
        data: cached.data,
        fromCache: true,
        ok: true,
        stale: !cached.fresh,
        savedAt: cached.savedAt
      };
    }

    return { data: null, fromCache: false, ok: false };
  },

  showLoader() {
    const loader = document.getElementById('page-loader');
    const content = document.getElementById('page-content');
    if (loader) loader.style.display = 'flex';
    if (content) content.style.display = 'none';
  },

  showContent() {
    const loader = document.getElementById('page-loader');
    const content = document.getElementById('page-content');
    if (loader) loader.style.display = 'none';
    if (content) content.style.display = 'block';
  },

  initOfflineBadge() {
    const show = (on) => {
      let badge = document.getElementById('kami-offline-badge');
      if (on) {
        if (!badge) {
          badge = document.createElement('div');
          badge.id = 'kami-offline-badge';
          badge.textContent = '📍 Offline';
          document.body.appendChild(badge);
        }
        badge.style.display = 'flex';
      } else if (badge) {
        badge.style.display = 'none';
      }
    };
    window.addEventListener('offline', () => show(true));
    window.addEventListener('online', () => show(false));
    if (this.isOffline()) show(true);
  }
};

window.kamiDefaultCover = function(type) {
  var map = {
    manga: { emoji: '📘', bg: 'linear-gradient(145deg,#1a1a2e,#16213e)' },
    manhwa: { emoji: '📗', bg: 'linear-gradient(145deg,#0f3460,#1a3a2a)' },
    manhua: { emoji: '📙', bg: 'linear-gradient(145deg,#4a0e0e,#2d1a0e)' },
    oneshot: { emoji: '📕', bg: 'linear-gradient(145deg,#2d1a3a,#1a0e2e)' },
  };
  var d = map[type] || { emoji: '📖', bg: 'linear-gradient(145deg,#14141f,#1a1a2e)' };
  return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:32px;background:' + d.bg + ';">' + d.emoji + '</div>';
};

window.kamiDefaultCover = function(type) {
  var t = type || '';
  var de = t === 'manhwa' ? '📗' : t === 'manhua' ? '📙' : t === 'oneshot' ? '📕' : t === 'manga' ? '📘' : '📖';
  var db = t === 'manhwa' ? 'linear-gradient(145deg,#0f3460,#1a3a2a)' : t === 'manhua' ? 'linear-gradient(145deg,#4a0e0e,#2d1a0e)' : t === 'oneshot' ? 'linear-gradient(145deg,#2d1a3a,#1a0e2e)' : 'linear-gradient(145deg,#1a1a2e,#16213e)';
  return '<div class="kmi-cover-fallback" style="background:' + db + ';">' + de + '</div>';
};

window.kamiReplaceCover = function(img, type) {
  if (img) img.outerHTML = window.kamiDefaultCover(type || '');
};

window.kamiMangaCard = function(m, opts) {
  opts = opts || {};
  var ph = window.kamiDefaultCover(m.type);
  var coverHtml = m.cover
    ? '<img src="' + m.cover + '" alt="' + (m.title||'') + '" loading="lazy" onerror="kamiReplaceCover(this,\'' + (m.type||'') + '\')">'
    : ph;
  var badges = '';
  if (opts.rank) badges += '<div class="kmi-badge-rank">' + opts.rank + '</div>';
  if (opts.showRating !== false && m.rating) badges += '<div class="kmi-badge-rating">★ ' + m.rating.toFixed(1) + '</div>';
  var genreStr = (m.genres && m.genres.length ? m.genres.slice(0,2).join(', ') : '') || m.type || 'manga';
  var overlay = opts.extraOverlay || '';
  var footer = opts.extraFooter || '';
  var link = opts.link || '/manga/' + (m.mangaId || m.id || '');
  return '<div class="kmi-card" onclick="window.location.href=\'' + link + '\'">' +
    '<div class="kmi-cover-wrap">' + coverHtml + badges + overlay + '</div>' +
    '<div class="kmi-info">' +
      '<div class="kmi-title">' + (m.title||'') + '</div>' +
      (opts.showMeta !== false ? '<div class="kmi-meta">' + genreStr + (m.totalChapters ? ' · ' + m.totalChapters + ' caps' : '') + '</div>' : '') +
      footer +
    '</div>' +
  '</div>';
};

document.addEventListener('DOMContentLoaded', () => {
  kamiOffline.initOfflineBadge();
});

if ('serviceWorker' in navigator) {
  // SW desactivado — sw.js eliminado
}
