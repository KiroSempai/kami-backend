// Notificaciones y Mensajes - KAMI
let notifTab = 'notifs';

window.toggleNotifPanel = function(e) {
  e.stopPropagation();
  const panel = document.getElementById('kami-notif-panel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  notifTab = 'notifs';
  panel.style.display = 'block';
  loadNotifs();
  loadMsgCount();
};

window.switchNotifTab = function(tab) {
  notifTab = tab;
  const tabNotifs = document.getElementById('notif-tab-notifs');
  const tabMsg = document.getElementById('notif-tab-msg');
  if (tabNotifs) { tabNotifs.style.borderBottomColor = tab === 'notifs' ? 'var(--accent)' : 'transparent'; tabNotifs.style.color = tab === 'notifs' ? 'var(--text-primary)' : 'var(--text-muted)'; }
  if (tabMsg) { tabMsg.style.borderBottomColor = tab === 'msg' ? 'var(--accent)' : 'transparent'; tabMsg.style.color = tab === 'msg' ? 'var(--text-primary)' : 'var(--text-muted)'; }
  if (tab === 'notifs') loadNotifs();
  else loadMsgThreads();
};

async function loadNotifs() {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  const content = document.getElementById('notif-panel-content');
  if (!content) return;
  content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Cargando...</div>';
  try {
    const r = await fetch('/api/notifications', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) { content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Error al cargar</div>'; return; }
    const data = await r.json();
    renderNotifs(data.notifications, data.unreadCount);
  } catch { content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Error de conexion</div>'; }
}

function renderNotifs(notifs, unreadCount) {
  const content = document.getElementById('notif-panel-content');
  const dot = document.getElementById('kami-notif-dot');
  if (!content) return;
  if (dot) dot.style.display = unreadCount > 0 ? 'block' : 'none';
  if (notifs.length === 0) {
    content.innerHTML = '<div style="padding:30px 20px;text-align:center;color:#4a4a62;font-size:13px;">🔔 Sin notificaciones</div>';
    return;
  }
  const icons = { ban:'🚫', warning:'⚠️', info:'ℹ️', mute:'🔇', strike:'❗' };
  let html = '';
  for (const n of notifs) {
    const bg = n.is_read ? '' : 'background:rgba(232,51,74,0.06);';
    html += '<div class="kami-notif-item" data-id="' + n.id + '" style="padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .12s;' + bg + (n.is_read ? 'opacity:0.6;' : '') + '" onclick="markNotifRead(' + n.id + ')" onmouseover="this.style.background=\'rgba(255,255,255,0.06)\'" onmouseout="this.style.background=\'' + (n.is_read ? 'transparent' : 'rgba(232,51,74,0.06)') + '">';
    html += '<div style="display:flex;gap:8px;align-items:flex-start;">';
    html += '<span style="font-size:16px;">' + (icons[n.type] || '📢') + '</span>';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div style="font-size:13px;font-weight:600;color:#f2f2fa;">' + escHtml(n.title) + '</div>';
    html += '<div style="font-size:11px;color:#4a4a62;margin-top:2px;">' + escHtml(n.message) + '</div>';
    html += '<div style="font-size:10px;color:#4a4a62;margin-top:4px;">' + new Date(n.created_at).toLocaleDateString('es-ES', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) + '</div>';
    html += '</div></div></div>';
  }
  html += '<div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;">';
  html += '<span style="font-size:11px;color:#4c9df5;cursor:pointer;" onclick="event.stopPropagation();markAllRead()">Marcar todas como leidas</span>';
  html += '</div>';
  content.innerHTML = html;
}

async function loadMsgThreads() {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  const content = document.getElementById('notif-panel-content');
  if (!content) return;
  content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Cargando...</div>';
  try {
    const r = await fetch('/api/messages', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) { content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Error</div>'; return; }
    const data = await r.json();
    renderMsgThreads(data.threads);
  } catch { content.innerHTML = '<div style="padding:20px;text-align:center;color:#4a4a62;font-size:13px;">Error de conexion</div>'; }
}

function renderMsgThreads(threads) {
  const content = document.getElementById('notif-panel-content');
  if (!content) return;
  if (threads.length === 0) {
    content.innerHTML = '<div style="padding:30px 20px;text-align:center;color:#4a4a62;font-size:13px;">💬 Sin conversaciones</div><div style="padding:0 12px 12px;text-align:center;"><a href="/messages" style="font-size:11px;color:#4c9df5;">Ir al centro de mensajes →</a></div>';
    return;
  }
  const statusIcons = { open:'🟢', pending:'🟡', resolved:'🔵', closed:'⚪' };
  let html = '';
  for (const t of threads) {
    html += '<div style="padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .12s;" onclick="window.location.href=\'/messages?thread=' + t.id + '\'" onmouseover="this.style.background=\'rgba(255,255,255,0.06)\'" onmouseout="this.style.background=\'transparent\'">';
    html += '<div style="display:flex;gap:8px;align-items:flex-start;">';
    html += '<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;flex-shrink:0;">' + (t.user_name || '?')[0].toUpperCase() + '</div>';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div style="font-size:13px;font-weight:600;color:#f2f2fa;">' + escHtml(t.subject) + '</div>';
    html += '<div style="font-size:10px;color:#4a4a62;margin-top:2px;"><span>' + (statusIcons[t.status] || '') + ' ' + t.status + '</span> · ' + (t.user_name || '?') + '</div>';
    html += '</div>';
    if (t.unread > 0) html += '<div style="background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;min-width:18px;text-align:center;">' + t.unread + '</div>';
    html += '</div></div>';
  }
  html += '<div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;"><a href="/messages" style="font-size:11px;color:#4c9df5;text-decoration:none;">Ver todos los mensajes →</a></div>';
  content.innerHTML = html;
}

async function loadMsgCount() {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  try {
    const r = await fetch('/api/messages/unread/count', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) return;
    const data = await r.json();
    const badge = document.getElementById('msg-tab-badge');
    if (badge) {
      badge.style.display = data.unreadCount > 0 ? 'inline' : 'none';
      badge.textContent = data.unreadCount;
    }
  } catch {}
}

window.markNotifRead = async function(id) {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  await fetch('/api/notifications/read/' + id, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
  loadNotifs();
  loadNotifCount();
};

window.markAllRead = async function() {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  await fetch('/api/notifications/read-all', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
  loadNotifs();
  loadNotifCount();
};

document.addEventListener('click', function(e) {
  const panel = document.getElementById('kami-notif-panel');
  const bell = document.getElementById('kami-notif-bell');
  if (panel && panel.style.display === 'block' && bell && !bell.contains(e.target) && !panel.contains(e.target)) {
    panel.style.display = 'none';
  }
});

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadNotifCount() {
  const token = localStorage.getItem('kami_token');
  if (!token) return;
  try {
    const [notifR, msgR] = await Promise.all([
      fetch('/api/notifications/unread-count', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/messages/unread/count', { headers: { 'Authorization': 'Bearer ' + token } }),
    ]);
    const notifData = notifR.ok ? await notifR.json() : { unreadCount: 0 };
    const msgData = msgR.ok ? await msgR.json() : { unreadCount: 0 };
    const dot = document.getElementById('kami-notif-dot');
    if (dot) dot.style.display = (notifData.unreadCount + msgData.unreadCount) > 0 ? 'block' : 'none';
    const msgDot = document.getElementById('kami-msg-dot');
    if (msgDot) msgDot.style.display = msgData.unreadCount > 0 ? 'block' : 'none';
    const badge = document.getElementById('msg-tab-badge');
    if (badge) {
      badge.style.display = msgData.unreadCount > 0 ? 'inline' : 'none';
      badge.textContent = msgData.unreadCount;
    }
  } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadNotifCount);
} else {
  loadNotifCount();
}
