/* ═══════════════════════════════════════════════════════════════════════════════
   🌌 KAMI — GLASS HUB MOBILE JAVASCRIPT
   Sleek mobile menu unifier, dynamic data loader, and view controller.
   ═══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Helper functions ──
  function initials(username) {
    return (username || '?').charAt(0).toUpperCase();
  }

  function esc(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getActiveUser() {
    try { return JSON.parse(localStorage.getItem('kami_user') || 'null'); } catch (e) { return null; }
  }

  function getActiveToken() {
    return localStorage.getItem('kami_token');
  }

  // ── INJECT COMPONENT HTML ──
  function injectGlassHubHTML() {
    if (document.getElementById('glassDrawer')) return; // Already injected

    const drawerHTML = `
      <!-- Drawer Overlay -->
      <div class="glass-drawer-overlay" id="glassDrawerOverlay" onclick="window.closeGlassDrawer()"></div>
      
      <!-- Glass Drawer -->
      <aside class="glass-drawer" id="glassDrawer">
        <div class="glass-drawer-header">
          <div class="glass-profile-info">
            <div class="glass-avatar-ring">
              <div class="glass-avatar" id="glassDrawerAvatar">?</div>
            </div>
            <div class="glass-user-meta">
              <div class="glass-username" id="glassDrawerUsername">Cargando...</div>
              <div class="glass-handle" id="glassDrawerHandle">@usuario</div>
            </div>
          </div>
          <div class="glass-level-container">
            <div class="glass-level-badge">NIVEL <span id="glassDrawerLevel">1</span></div>
            <div class="glass-xp-bar-wrap">
              <div class="glass-xp-bar-progress" id="glassDrawerXpProgress" style="width: 0%"></div>
            </div>
            <div class="glass-xp-text" id="glassDrawerXpText">0 / 100 XP</div>
          </div>
        </div>
        
        <div class="glass-drawer-content">
          <div class="glass-section-label">Navegación Unificada</div>
          <button class="glass-btn-toggle" id="glassToggleViewBtn">
            <i class="ti ti-rotate-2"></i>
            <span id="glassToggleViewText">Cambiar Vista</span>
          </button>
          
          <div class="glass-separator"></div>
          
          <div class="glass-section-label">Mi Portal</div>
          <div class="glass-menu-list">
            <button class="glass-menu-item" onclick="window.openGlassPanel('library')">
              <div class="glass-menu-icon"><i class="ti ti-books"></i></div>
              <div class="glass-menu-text">
                <span class="glass-menu-title">Mi Biblioteca</span>
                <span class="glass-menu-desc">Biblioteca y listas unificadas</span>
              </div>
              <i class="ti ti-chevron-right glass-menu-arrow"></i>
            </button>
            
            <button class="glass-menu-item" onclick="window.openGlassPanel('stats')">
              <div class="glass-menu-icon"><i class="ti ti-chart-bar"></i></div>
              <div class="glass-menu-text">
                <span class="glass-menu-title">Estadísticas</span>
                <span class="glass-menu-desc">Métricas, logros e historial</span>
              </div>
              <i class="ti ti-chevron-right glass-menu-arrow"></i>
            </button>
          </div>
        </div>
        
        <div class="glass-drawer-footer">
          <div class="glass-footer-btns">
            <button class="glass-footer-btn" id="glassFooterProfileBtn"><i class="ti ti-user"></i> Perfil</button>
            <button class="glass-footer-btn logout" id="glassFooterAuthBtn"><i class="ti ti-logout"></i> Salir</button>
          </div>
        </div>
      </aside>

      <!-- Glass Library Panel Overlay -->
      <div class="glass-panel-overlay" id="glassLibraryPanelOverlay" onclick="window.closeGlassPanel('library')"></div>
      
      <!-- Glass Library Panel -->
      <div class="glass-panel" id="glassLibraryPanel">
        <div class="glass-panel-header">
          <div class="glass-panel-title-wrap">
            <i class="ti ti-books"></i>
            <span class="glass-panel-title">Mi Biblioteca</span>
          </div>
          <button class="glass-panel-close" onclick="window.closeGlassPanel('library')"><i class="ti ti-x"></i></button>
        </div>
        
        <div class="glass-panel-body">
          <div class="glass-tabs">
            <button class="glass-tab-btn active" id="glassLibTabMangas" onclick="window.switchLibTab('mangas')">
              <i class="ti ti-book-2"></i> Mis Mangas
            </button>
            <button class="glass-tab-btn" id="glassLibTabListas" onclick="window.switchLibTab('listas')">
              <i class="ti ti-list-details"></i> Mis Listas
            </button>
          </div>
          
          <!-- Library filter tags -->
          <div class="glass-subtabs" id="glassLibraryFilterSubtabs">
            <button class="glass-subtab-btn active" onclick="window.filterLibrary('reading', this)">Leyendo</button>
            <button class="glass-subtab-btn" onclick="window.filterLibrary('planned', this)">Pendientes</button>
            <button class="glass-subtab-btn" onclick="window.filterLibrary('completed', this)">Terminados</button>
            <button class="glass-subtab-btn" onclick="window.filterLibrary('favorite', this)">Favoritos</button>
            <button class="glass-subtab-btn" onclick="window.filterLibrary('dropped', this)">Abandonados</button>
          </div>
          
          <!-- Grid Container -->
          <div id="glassLibraryContent">
            <div class="glass-empty-state">
              <i class="ti ti-loader animate-spin"></i>
              <p>Cargando biblioteca...</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Glass Stats Panel Overlay -->
      <div class="glass-panel-overlay" id="glassStatsPanelOverlay" onclick="window.closeGlassPanel('stats')"></div>
      
      <!-- Glass Stats Panel -->
      <div class="glass-panel" id="glassStatsPanel">
        <div class="glass-panel-header">
          <div class="glass-panel-title-wrap">
            <i class="ti ti-chart-bar"></i>
            <span class="glass-panel-title">Métricas y Logros</span>
          </div>
          <button class="glass-panel-close" onclick="window.closeGlassPanel('stats')"><i class="ti ti-x"></i></button>
        </div>
        
        <div class="glass-panel-body">
          <div class="glass-tabs">
            <button class="glass-tab-btn active" id="glassStatsTabMetrics" onclick="window.switchStatsTab('metrics')">
              <i class="ti ti-chart-pie"></i> Métricas
            </button>
            <button class="glass-tab-btn" id="glassStatsTabAchievements" onclick="window.switchStatsTab('achievements')">
              <i class="ti ti-award"></i> Logros (14)
            </button>
          </div>
          
          <!-- Metrics View -->
          <div id="glassStatsMetricsContent">
            <div class="glass-stats-grid" id="glassStatsMetricsGrid">
              <!-- Grid metrics dynamically inserted -->
            </div>
            
            <div class="glass-section-label" style="margin-top: 10px;">Géneros Favoritos</div>
            <div class="glass-genres-box" id="glassStatsGenresBox">
              <!-- Genres dynamically inserted -->
            </div>
            
            <div class="glass-section-label">Historial de Lectura Reciente</div>
            <div class="glass-history-timeline" id="glassStatsHistoryTimeline">
              <!-- Timeline dynamically inserted -->
            </div>
          </div>
          
          <!-- Achievements View -->
          <div id="glassStatsAchievementsContent" style="display: none;">
            <div class="glass-achievements-grid" id="glassStatsAchievementsGrid">
              <!-- Dynamic achievements grid -->
            </div>
          </div>
        </div>
      </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = drawerHTML;
    document.body.appendChild(wrapper);

    // Setup events
    setupDrawerActions();
  }

  // ── ROUTING SWITCHES ──
  function setupDrawerActions() {
    const user = getActiveUser();
    const token = getActiveToken();

    // Toggle view button (Community <-> Reader)
    const toggleBtn = document.getElementById('glassToggleViewBtn');
    const toggleText = document.getElementById('glassToggleViewText');
    const path = window.location.pathname;

    const isMangoteca = path.indexOf('/inicio-mangoteca') >= 0 || path.indexOf('inicio-mangoteca-mobile') >= 0;
    
    if (isMangoteca) {
      toggleText.textContent = 'Cambiar a Comunidad';
      toggleBtn.onclick = function() {
        window.location.href = '/';
      };
    } else {
      toggleText.textContent = 'Cambiar a Mangoteca';
      toggleBtn.onclick = function() {
        window.location.href = '/inicio-mangoteca';
      };
    }

    // Profile and Auth footer buttons
    const profileBtn = document.getElementById('glassFooterProfileBtn');
    const authBtn = document.getElementById('glassFooterAuthBtn');

    if (user && token) {
      profileBtn.onclick = function() {
        window.location.href = `/profile/${user.username}`;
      };
      authBtn.innerHTML = '<i class="ti ti-logout"></i> Salir';
      authBtn.onclick = function() {
        localStorage.removeItem('kami_token');
        localStorage.removeItem('kami_user');
        window.location.href = '/login';
      };
    } else {
      profileBtn.onclick = function() {
        window.location.href = '/login';
      };
      authBtn.innerHTML = '<i class="ti ti-login"></i> Acceder';
      authBtn.onclick = function() {
        window.location.href = '/login';
      };
    }
  }

  // ── DYNAMIC DATA FETCHING & BINDING ──
  async function loadProfileStats() {
    const user = getActiveUser();
    const token = getActiveToken();

    const usernameEl = document.getElementById('glassDrawerUsername');
    const handleEl = document.getElementById('glassDrawerHandle');
    const avatarEl = document.getElementById('glassDrawerAvatar');

    if (!user || !token) {
      usernameEl.textContent = 'Invitado';
      handleEl.textContent = '@anonimo';
      avatarEl.textContent = '?';
      avatarEl.style.background = '#e8334a';
      document.getElementById('glassDrawerLevel').textContent = '1';
      document.getElementById('glassDrawerXpProgress').style.width = '0%';
      document.getElementById('glassDrawerXpText').textContent = '0 / 100 XP';
      return;
    }

    // Set basic user details
    usernameEl.textContent = user.username || 'Usuario';
    handleEl.textContent = `@${(user.username || '').toLowerCase()}`;
    
    if (user.avatar && (user.avatar.indexOf('/') === 0 || user.avatar.indexOf('http') === 0)) {
      avatarEl.innerHTML = `<img src="${user.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      avatarEl.textContent = initials(user.username);
      avatarEl.style.background = user.avatarColor || '#e8334a';
    }

    // Fetch Level and XP
    try {
      const res = await fetch(`/api/stats/xp/${user.id || user.userId}`);
      if (res.ok) {
        const data = await res.json();
        document.getElementById('glassDrawerLevel').textContent = data.level;
        document.getElementById('glassDrawerXpProgress').style.width = `${data.progress}%`;
        document.getElementById('glassDrawerXpText').textContent = `${data.xp} / ${data.xpForNext} XP`;
      }
    } catch (e) {
      console.error('Error fetching XP:', e);
    }
  }

  // Cache to prevent repetitive requests
  let libraryData = null;
  let statsData = null;
  let historyData = null;
  let achievementsData = null;

  // ── PANEL: LIBRARY DATA LOADER ──
  window.loadLibraryPanelData = async function(force = false) {
    const user = getActiveUser();
    const token = getActiveToken();
    const content = document.getElementById('glassLibraryContent');

    if (!user || !token) {
      content.innerHTML = `
        <div class="glass-empty-state">
          <i class="ti ti-lock"></i>
          <p>Debes iniciar sesión para ver tu biblioteca</p>
          <button class="glass-btn-toggle" style="margin-top: 10px; max-width: 180px;" onclick="window.location.href='/login'">Acceder</button>
        </div>
      `;
      return;
    }

    if (libraryData && !force) {
      window.renderLibraryState();
      return;
    }

    content.innerHTML = `
      <div class="glass-empty-state">
        <i class="ti ti-loader animate-spin" style="font-size:24px;color:var(--accent);"></i>
        <p>Cargando mangas guardados...</p>
      </div>
    `;

    try {
      const res = await fetch('/api/library', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        libraryData = data.library || {};
        window.renderLibraryState();
      } else {
        throw new Error('Unauthorized');
      }
    } catch (e) {
      content.innerHTML = `
        <div class="glass-empty-state">
          <i class="ti ti-cloud-off"></i>
          <p>Error de conexión al cargar la biblioteca</p>
        </div>
      `;
    }
  };

  let currentLibTab = 'mangas';
  let currentLibFilter = 'reading';

  window.switchLibTab = function(tab) {
    currentLibTab = tab;
    document.getElementById('glassLibTabMangas').classList.toggle('active', tab === 'mangas');
    document.getElementById('glassLibTabListas').classList.toggle('active', tab === 'listas');

    const filterSubtabs = document.getElementById('glassLibraryFilterSubtabs');
    if (tab === 'listas') {
      filterSubtabs.style.display = 'none';
      window.loadListasTab();
    } else {
      filterSubtabs.style.display = 'flex';
      window.renderLibraryState();
    }
  };

  window.filterLibrary = function(filter, btn) {
    currentLibFilter = filter;
    document.querySelectorAll('#glassLibraryFilterSubtabs .glass-subtab-btn').forEach(b => {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    window.renderLibraryState();
  };

  window.renderLibraryState = function() {
    const list = libraryData ? libraryData[currentLibFilter] || [] : [];
    const content = document.getElementById('glassLibraryContent');

    if (list.length === 0) {
      content.innerHTML = `
        <div class="glass-empty-state">
          <i class="ti ti-inbox"></i>
          <p>Sin mangas en esta sección</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="glass-library-grid">
        ${list.map(m => {
          const progressPercent = m.totalChapters > 0 ? Math.min(100, Math.round((m.progress / m.totalChapters) * 100)) : 0;
          return `
            <div class="glass-manga-card" onclick="window.location.href='/manga/${m.mangaId}'">
              <div class="glass-manga-thumb">
                ${m.cover ? `<img src="${m.cover}" class="glass-manga-cover" alt="">` : `<i class="ti ti-book-2"></i>`}
                ${m.rating ? `
                  <div class="glass-manga-badge">
                    <i class="ti ti-star-filled" style="font-size:7px"></i> ${m.rating}
                  </div>
                ` : ''}
                <div class="glass-manga-play" onclick="event.stopPropagation(); window.location.href='/reader/${m.mangaId}/${m.progress + 1}'">
                  <i class="ti ti-player-play-filled"></i>
                </div>
              </div>
              <div class="glass-manga-info">
                <div class="glass-manga-title">${esc(m.title)}</div>
                <div style="margin-top:auto;">
                  <div class="glass-manga-progress-bar">
                    <div class="glass-manga-progress-fill" style="width: ${progressPercent}%"></div>
                  </div>
                  <span class="glass-manga-chapters">Cap. ${m.progress}/${m.totalChapters || '?'}</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  };

  // Fetch bookmarked lists/bookmarks unifiers
  window.loadListasTab = async function() {
    const content = document.getElementById('glassLibraryContent');
    const token = getActiveToken();

    content.innerHTML = `
      <div class="glass-empty-state">
        <i class="ti ti-loader animate-spin" style="font-size:24px;color:var(--accent);"></i>
        <p>Cargando marcadores...</p>
      </div>
    `;

    try {
      const res = await fetch('/api/feed/bookmarks', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const d = await res.json();
        if (!d.success || !d.posts || !d.posts.length) {
          content.innerHTML = `
            <div class="glass-empty-state">
              <i class="ti ti-bookmark"></i>
              <p>Sin marcadores o listas guardadas aún</p>
            </div>
          `;
          return;
        }

        content.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${d.posts.map(p => `
              <div class="glass-list-item" onclick="window.location.href='/#post-${p.id}'">
                <div class="glass-list-icon"><i class="ti ti-bookmark-filled"></i></div>
                <div class="glass-list-meta">
                  <div class="glass-list-title">${esc(p.text)}</div>
                  <div class="glass-list-count">Publicado por @${esc(p.user)}</div>
                </div>
                <i class="ti ti-chevron-right" style="font-size:11px;color:var(--text-muted);"></i>
              </div>
            `).join('')}
          </div>
        `;
      }
    } catch (e) {
      content.innerHTML = `
        <div class="glass-empty-state">
          <i class="ti ti-bookmark-off"></i>
          <p>No se pudieron obtener los marcadores</p>
        </div>
      `;
    }
  };

  // ── PANEL: STATS & ACHIEVEMENTS DATA LOADER ──
  window.loadStatsPanelData = async function(force = false) {
    const user = getActiveUser();
    const token = getActiveToken();
    const metricsGrid = document.getElementById('glassStatsMetricsGrid');

    if (!user || !token) {
      metricsGrid.innerHTML = `
        <div class="glass-empty-state" style="grid-column: span 2;">
          <i class="ti ti-lock"></i>
          <p>Inicia sesión para visualizar tus métricas</p>
        </div>
      `;
      return;
    }

    if (statsData && !force) {
      window.renderStatsMetrics();
      window.renderAchievements();
      return;
    }

    metricsGrid.innerHTML = `
      <div class="glass-empty-state" style="grid-column: span 2;">
        <i class="ti ti-loader animate-spin"></i>
        <p>Calculando estadísticas de lectura...</p>
      </div>
    `;

    try {
      // 1. Fetch main stats
      const statsRes = await fetch(`/api/stats/${user.username}`);
      if (statsRes.ok) statsData = await statsRes.json();

      // 2. Fetch history timeline
      const histRes = await fetch(`/api/stats/history/${user.id || user.userId}`);
      if (histRes.ok) {
        const hd = await histRes.json();
        historyData = hd.entries || [];
      }

      // 3. Fetch achievements
      const achRes = await fetch(`/api/stats/achievements/${user.id || user.userId}`);
      if (achRes.ok) {
        const ad = await achRes.json();
        achievementsData = ad.achievements || [];
      }

      window.renderStatsMetrics();
      window.renderAchievements();

    } catch (e) {
      metricsGrid.innerHTML = `
        <div class="glass-empty-state" style="grid-column: span 2;">
          <i class="ti ti-cloud-off"></i>
          <p>Ocurrió un error al obtener las métricas</p>
        </div>
      `;
    }
  };

  let currentStatsTab = 'metrics';

  window.switchStatsTab = function(tab) {
    currentStatsTab = tab;
    document.getElementById('glassStatsTabMetrics').classList.toggle('active', tab === 'metrics');
    document.getElementById('glassStatsTabAchievements').classList.toggle('active', tab === 'achievements');

    document.getElementById('glassStatsMetricsContent').style.display = tab === 'metrics' ? 'block' : 'none';
    document.getElementById('glassStatsAchievementsContent').style.display = tab === 'achievements' ? 'block' : 'none';
  };

  window.renderStatsMetrics = function() {
    if (!statsData) return;
    const grid = document.getElementById('glassStatsMetricsGrid');
    const genresBox = document.getElementById('glassStatsGenresBox');
    const timeline = document.getElementById('glassStatsHistoryTimeline');
    const s = statsData.stats || {};

    // Render 4 major metrics cards
    grid.innerHTML = `
      <div class="glass-stat-card">
        <div class="glass-stat-icon blue"><i class="ti ti-books"></i></div>
        <div class="glass-stat-info">
          <div class="glass-stat-val">${s.titlesRead || 0}</div>
          <div class="glass-stat-lbl">Títulos</div>
        </div>
      </div>
      <div class="glass-stat-card">
        <div class="glass-stat-icon green"><i class="ti ti-hash"></i></div>
        <div class="glass-stat-info">
          <div class="glass-stat-val">${s.chaptersCompleted || 0}</div>
          <div class="glass-stat-lbl">Capítulos</div>
        </div>
      </div>
      <div class="glass-stat-card">
        <div class="glass-stat-icon gold"><i class="ti ti-clock"></i></div>
        <div class="glass-stat-info">
          <div class="glass-stat-val">${s.hoursRead || 0}h</div>
          <div class="glass-stat-lbl">Horas leídas</div>
        </div>
      </div>
      <div class="glass-stat-card">
        <div class="glass-stat-icon orange"><i class="ti ti-flame-filled"></i></div>
        <div class="glass-stat-info">
          <div class="glass-stat-val">${s.currentStreak || 0}d</div>
          <div class="glass-stat-lbl">Racha actual</div>
        </div>
      </div>
    `;

    // Render Favorite Genres bars
    const favs = statsData.favoriteGenres || [];
    if (favs.length === 0) {
      genresBox.innerHTML = '<p style="font-size:11px;color:var(--text-muted);text-align:center;">Agrega mangas a tu biblioteca para medir géneros</p>';
    } else {
      const maxCount = favs[0].count || 1;
      const palette = ['#e8334a', '#a855f7', '#4c9df5', '#2dca7a', '#f5c842', '#fb923c'];
      genresBox.innerHTML = favs.map((g, idx) => {
        const percent = Math.round((g.count / maxCount) * 100);
        const color = palette[idx % palette.length];
        return `
          <div class="glass-genre-row">
            <div class="glass-genre-meta">
              <span>${g.name}</span>
              <span style="color:var(--text-secondary);">${g.count} mangas</span>
            </div>
            <div class="glass-genre-bar-wrap">
              <div class="glass-genre-bar-fill" style="width: ${percent}%; background: ${color}"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render History Timeline entries
    if (!historyData || historyData.length === 0) {
      timeline.innerHTML = '<p style="font-size:11px;color:var(--text-muted);text-align:center;padding:15px;">Sin lecturas registradas en el historial</p>';
    } else {
      timeline.innerHTML = historyData.slice(0, 10).map(h => {
        const dateStr = new Date(h.created_at).toLocaleDateString('es-ES', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const cap = h.metadata && h.metadata.chapter ? `Capítulo ${h.metadata.chapter}` : 'Empezado';
        return `
          <div class="glass-history-item">
            ${h.manga_cover ? `<img src="${h.manga_cover}" class="glass-history-cover" alt="">` : `<i class="ti ti-book" style="font-size:14px;margin-left:4px;margin-right:8px;color:var(--text-muted);"></i>`}
            <div class="glass-history-meta">
              <div class="glass-history-manga">${esc(h.manga_title)}</div>
              <div class="glass-history-action">${cap}</div>
            </div>
            <div class="glass-history-time">${dateStr}</div>
          </div>
        `;
      }).join('');
    }
  };

  window.renderAchievements = function() {
    if (!achievementsData) return;
    const grid = document.getElementById('glassStatsAchievementsGrid');

    grid.innerHTML = achievementsData.map(a => {
      const cardClass = a.unlocked ? 'unlocked' : 'locked';
      const statusText = a.unlocked ? 'Desbloqueado' : 'Bloqueado';
      return `
        <div class="glass-achievement-card ${cardClass}">
          <div class="glass-ach-badge-wrap">
            <div class="glass-ach-emoji">${a.emoji}</div>
            <span class="glass-ach-status">${statusText}</span>
          </div>
          <div class="glass-ach-details">
            <div class="glass-ach-name">${a.name}</div>
            <div class="glass-ach-desc">${a.desc}</div>
          </div>
          <div class="glass-ach-progress-container">
            <div class="glass-ach-progress-bar">
              <div class="glass-ach-progress-fill" style="width: ${a.progress}%"></div>
            </div>
            <div class="glass-ach-progress-text">${a.cur} / ${a.target}</div>
          </div>
        </div>
      `;
    }).join('');
  };

  // ── TRANSITION TRIGGERS ──
  window.openGlassDrawer = function() {
    // Refresh header dynamic data
    loadProfileStats();
    
    document.getElementById('glassDrawerOverlay').classList.add('active');
    document.getElementById('glassDrawer').classList.add('active');
  };

  window.closeGlassDrawer = function() {
    document.getElementById('glassDrawerOverlay').classList.remove('active');
    document.getElementById('glassDrawer').classList.remove('active');
  };

  window.openGlassPanel = function(panel) {
    window.closeGlassDrawer();

    if (panel === 'library') {
      document.getElementById('glassLibraryPanelOverlay').classList.add('active');
      document.getElementById('glassLibraryPanel').classList.add('active');
      window.loadLibraryPanelData();
    } else if (panel === 'stats') {
      document.getElementById('glassStatsPanelOverlay').classList.add('active');
      document.getElementById('glassStatsPanel').classList.add('active');
      window.loadStatsPanelData();
    }
  };

  window.closeGlassPanel = function(panel) {
    if (panel === 'library') {
      document.getElementById('glassLibraryPanelOverlay').classList.remove('active');
      document.getElementById('glassLibraryPanel').classList.remove('active');
    } else if (panel === 'stats') {
      document.getElementById('glassStatsPanelOverlay').classList.remove('active');
      document.getElementById('glassStatsPanel').classList.remove('active');
    }
  };

  // ── INTERCEPT & HOOK TOP-NAV AVATAR CLICK ──
  function hookMobileAvatarClick() {
    // Target common mobile avatar selectors
    const selectors = [
      '.top-nav-left .top-avatar',
      '#mob-avatar-btn',
      '#mobile-top-avatar-btn',
      '.top-avatar'
    ];

    let hooked = false;
    selectors.forEach(sel => {
      const avatarBtn = document.querySelector(sel);
      if (avatarBtn) {
        // Remove native inline onclicks if any
        avatarBtn.removeAttribute('onclick');
        
        avatarBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          window.openGlassDrawer();
        });
        hooked = true;
      }
    });

    if (!hooked) {
      // Retry in a second if DOM was still assembling
      setTimeout(hookMobileAvatarClick, 1000);
    }
  }

  // Initialize on Dom ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      injectGlassHubHTML();
      hookMobileAvatarClick();
    });
  } else {
    injectGlassHubHTML();
    hookMobileAvatarClick();
  }

})();
