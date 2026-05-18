(function() {
  'use strict';

  var TOKEN = localStorage.getItem('kami_token');
  var username = 'Usuario';
  var isAdmin = false;
  try {
    var u = JSON.parse(localStorage.getItem('kami_user') || '{}');
    username = u.username || 'Usuario';
    isAdmin = u.role === 'admin';
  } catch(e) {}

  // Saltar protecciones si es admin (para verificar tamaños, inspeccionar, etc.)
  var skipSecurity = isAdmin;

  // ── Estado ──
  var state = {
    mangaId: null,
    chapterNum: null,
    pages: [],
    currentPage: 0,
    totalPages: 0,
  };

  // ── Bloquear teclas ──
  if (!skipSecurity) {
    document.addEventListener('keydown', function(e) {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || (e.ctrlKey && (e.key === 'U' || e.key === 'S'))) {
        e.preventDefault();
        return false;
      }
    });
  }

  // Navegación con teclas (para todos)
  document.addEventListener('keydown', function(e) {
    if (state.totalPages > 0) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextPage(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevPage(); }
    }
  });

  // ── Bloquear al perder foco (captura/grabación) ──
  if (!skipSecurity) {
    function blackoutCanvas() {
      var overlay = document.getElementById('kami-reader-overlay');
      if (!overlay || overlay.style.display !== 'flex') return;
      var c = document.getElementById('kami-reader-canvas');
      if (!c) return;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, c.width, c.height);
    }

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) blackoutCanvas();
    });

    window.addEventListener('blur', function() {
      blackoutCanvas();
    });

    window.addEventListener('focus', function() {
      if (state.totalPages > 0) loadPage(state.currentPage);
    });

    // ── Protección clic derecho ──
    document.addEventListener('contextmenu', function(e) {
      if (document.getElementById('kami-reader-overlay') && document.getElementById('kami-reader-overlay').style.display === 'flex') {
        e.preventDefault();
      }
    });
  }

  // ── AES key caching ──
  var cryptoKey = null;
  var cryptoKeyPromise = null;

  function getCryptoKey() {
    if (cryptoKey) return Promise.resolve(cryptoKey);
    if (cryptoKeyPromise) return cryptoKeyPromise;
    cryptoKeyPromise = fetch('/api/image/key', { headers: { 'Authorization': 'Bearer ' + TOKEN } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        return crypto.subtle.importKey('raw', Uint8Array.from(atob(data.key), function(c) { return c.charCodeAt(0); }), { name: 'AES-CBC' }, false, ['decrypt']);
      })
      .then(function(k) { cryptoKey = k; return k; });
    return cryptoKeyPromise;
  }

  // ── Renderizar página en canvas (con descifrado AES) ──
  function renderPage(url) {
    var canvas = document.getElementById('kami-reader-canvas');
    var ctx = canvas.getContext('2d');
    var container = document.getElementById('kami-reader-container');

    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#07070e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } })
      .then(function(r) { return r.json(); })
      .then(function(encrypted) {
        return getCryptoKey().then(function(key) {
          var iv = Uint8Array.from(atob(encrypted.iv), function(c) { return c.charCodeAt(0); });
          var data = Uint8Array.from(atob(encrypted.data), function(c) { return c.charCodeAt(0); });
          return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data);
        });
      })
      .then(function(decrypted) {
        var blob = new Blob([decrypted], { type: encrypted && encrypted.type === 'png' ? 'image/png' : 'image/webp' });
        var img = new Image();
        img.onload = function() {
          var scale = Math.min(canvas.width / img.width, canvas.height / img.height);
          var w = img.width * scale;
          var h = img.height * scale;
          var x = (canvas.width - w) / 2;
          var y = (canvas.height - h) / 2;

          ctx.drawImage(img, x, y, w, h);

          // Watermark
          ctx.save();
          ctx.font = '12px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(username + ' · KAMI', canvas.width - 16, canvas.height - 16);
          ctx.restore();

          // Antishot pattern (puntos de 1px en grid cada 8px, casi invisibles)
          ctx.fillStyle = 'rgba(255,255,255,0.04)';
          for (var px = 0; px < canvas.width; px += 8) {
            for (var py = 0; py < canvas.height; py += 8) {
              ctx.fillRect(px, py, 1, 1);
            }
          }
        };
        img.onerror = function() {
          showReaderError('No se pudo cargar la imagen');
        };
        img.src = URL.createObjectURL(blob);
      })
      .catch(function(err) {
        showReaderError(err.message || 'Error al cargar la p\u00e1gina');
      });
  }

  function showReaderError(msg) {
    var canvas = document.getElementById('kami-reader-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#14141f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8888a0';
    ctx.font = '14px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

  // ── Navegación ──
  function updatePageCounter() {
    var el = document.getElementById('kami-reader-page');
    if (el) el.textContent = 'P\u00e1gina ' + (state.currentPage + 1) + ' de ' + state.totalPages;
  }

  function loadPage(idx) {
    if (idx < 0 || idx >= state.totalPages) return;
    state.currentPage = idx;
    updatePageCounter();
    var url = '/api/image/' + state.mangaId + '/' + state.chapterNum + '/' + (idx + 1);
    renderPage(url);
  }

  window.nextPage = function() {
    if (state.currentPage < state.totalPages - 1) loadPage(state.currentPage + 1);
  };

  window.prevPage = function() {
    if (state.currentPage > 0) loadPage(state.currentPage - 1);
  };

  // ── Abrir lector ──
  window.kamiOpenReader = async function(mangaId, chapterNum) {
    state.mangaId = mangaId;
    state.chapterNum = chapterNum;

    var overlay = document.getElementById('kami-reader-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kami-reader-overlay';
      overlay.innerHTML = `
        <style>
          #kami-reader-overlay{position:fixed;inset:0;z-index:99999;background:#07070e;flex-direction:column;display:none;}
          #kami-reader-overlay .reader-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#0d0d18;z-index:10;}
          #kami-reader-overlay .reader-header .reader-title{font-size:13px;color:rgba(255,255,255,0.5);}
          #kami-reader-overlay .reader-header .reader-controls{display:flex;align-items:center;gap:12px;}
          #kami-reader-overlay .reader-header button{width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#8888a0;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;transition:.15s;}
          #kami-reader-overlay .reader-header button:hover{background:rgba(255,255,255,0.1);color:#f2f2fa;}
          #kami-reader-overlay .reader-header .reader-page-num{font-size:12px;color:rgba(255,255,255,0.3);white-space:nowrap;}
          #kami-reader-container{flex:1;position:relative;overflow:hidden;min-height:0;}
          #kami-reader-canvas{width:100%;height:100%;display:block;pointer-events:none;}
          #kami-reader-overlay .reader-overlay{position:absolute;inset:0;z-index:2;cursor:pointer;}
          #kami-reader-overlay .reader-nav-area{position:absolute;top:0;bottom:0;width:30%;z-index:3;cursor:pointer;}
          #kami-reader-overlay .reader-nav-left{left:0;}
          #kami-reader-overlay .reader-nav-right{right:0;}
          #kami-reader-overlay .reader-nav-area:hover{background:rgba(255,255,255,0.03);}
          #kami-reader-overlay .reader-antishot{position:absolute;inset:0;z-index:4;pointer-events:none;background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,0.008) 3px,rgba(255,255,255,0.008) 6px);mix-blend-mode:difference;}
          #kami-reader-overlay .reader-footer{display:flex;align-items:center;justify-content:center;gap:16px;padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#0d0d18;}
          #kami-reader-overlay .reader-footer button{width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#8888a0;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:.15s;}
          #kami-reader-overlay .reader-footer button:hover{background:rgba(255,255,255,0.1);color:#f2f2fa;}
          #kami-reader-overlay .reader-footer button:disabled{opacity:0.2;cursor:default;}
          #kami-reader-overlay .reader-loading{display:flex;align-items:center;justify-content:center;flex:1;color:rgba(255,255,255,0.2);font-size:14px;gap:10px;}
          #kami-reader-overlay .reader-loading .spinner{width:20px;height:20px;border:2px solid rgba(255,255,255,0.04);border-top-color:#e8344a;border-radius:50%;animation:readerSpin .8s linear infinite;}
          @keyframes readerSpin{to{transform:rotate(360deg)}}
        </style>
        <div class="reader-header">
          <div class="reader-title" id="kami-reader-title"></div>
          <div class="reader-controls">
            <span class="reader-page-num" id="kami-reader-page"></span>
            <button onclick="kamiCloseReader()" title="Cerrar">\u2715</button>
          </div>
        </div>
        <div id="kami-reader-container">
          <canvas id="kami-reader-canvas"></canvas>
          <div class="reader-antishot" id="reader-antishot"></div>
          <div class="reader-overlay" id="reader-overlay-click"></div>
          <div class="reader-nav-area reader-nav-left" onclick="prevPage()" title="Anterior"></div>
          <div class="reader-nav-area reader-nav-right" onclick="nextPage()" title="Siguiente"></div>
        </div>
        <div class="reader-footer">
          <button onclick="prevPage()" id="reader-prev-btn" title="Anterior">\u25c0</button>
          <span id="kami-reader-page-footer" style="font-size:12px;color:rgba(255,255,255,0.3);"></span>
          <button onclick="nextPage()" id="reader-next-btn" title="Siguiente">\u25b6</button>
        </div>
      `;
      document.body.appendChild(overlay);

      // Click en overlay pasa a siguiente página
      document.getElementById('reader-overlay-click').addEventListener('click', function(e) {
        var rect = this.getBoundingClientRect();
        var x = e.clientX - rect.left;
        if (x > rect.width * 0.5) nextPage();
        else prevPage();
      });
    }

    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    document.getElementById('kami-reader-title').textContent = 'Cap\u00edtulo ' + chapterNum;

    // Cargar capítulo
    document.getElementById('kami-reader-container').innerHTML = '<div class="reader-loading"><div class="spinner"></div><span>Cargando cap\u00edtulo...</span></div>';

    try {
      var res = await fetch('/api/chapters/' + mangaId + '/' + chapterNum);
      var data = await res.json();
      if (!data.chapter) throw new Error('Cap\u00edtulo no encontrado');

      state.totalPages = data.chapter.pages;
      state.currentPage = 0;

      // Restaurar container con canvas + overlays
      var container = document.getElementById('kami-reader-container');
      container.innerHTML = '<canvas id="kami-reader-canvas"></canvas><div class="reader-antishot"></div><div class="reader-overlay" id="reader-overlay-click"></div><div class="reader-nav-area reader-nav-left" onclick="prevPage()"></div><div class="reader-nav-area reader-nav-right" onclick="nextPage()"></div>';

      document.getElementById('reader-overlay-click').addEventListener('click', function(e) {
        var rect = this.getBoundingClientRect();
        var x = e.clientX - rect.left;
        if (x > rect.width * 0.5) nextPage();
        else prevPage();
      });

      updatePageCounter();
      loadPage(0);
    } catch(e) {
      document.getElementById('kami-reader-container').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;flex:1;color:#8888a0;font-size:14px;">Error al cargar el cap\u00edtulo</div>';
    }
  };

  window.kamiCloseReader = function() {
    var overlay = document.getElementById('kami-reader-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
  };

})();
