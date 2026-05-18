var kamiAnnotations = (function() {
  'use strict';

  var TOKEN = localStorage.getItem('kami_token');
  var currentUser = null;
  try { currentUser = JSON.parse(localStorage.getItem('kami_user') || '{}'); } catch(e) {}

  var state = {
    mangaId: null,
    chapterNumber: null,
    pageNumber: null,
    annotations: [],
    selecting: false,
    enabled: false,
  };

  var container, canvas, overlay, popover;

  function init(opts) {
    state.mangaId = opts.mangaId;
    state.chapterNumber = opts.chapterNumber;
    state.pageNumber = opts.pageNumber;
    container = opts.container;
    canvas = opts.canvas;

    overlay = document.createElement('div');
    overlay.id = 'kami-annotations-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:5;';
    container.appendChild(overlay);

    popover = document.createElement('div');
    popover.id = 'kami-annotations-popover';
    popover.style.cssText = 'display:none;position:absolute;z-index:20;background:#14141f;border:1px solid rgba(255,255,255,0.13);border-radius:12px;padding:12px;min-width:220px;max-width:300px;box-shadow:0 12px 40px rgba(0,0,0,0.6);';
    container.appendChild(popover);

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mouseup', onMouseUp);
  }

  function toggle() {
    state.enabled = !state.enabled;
    overlay.style.cursor = state.enabled ? 'crosshair' : '';
    document.getElementById('kami-annotations-popover') && (document.getElementById('kami-annotations-popover').style.display = 'none');
    return state.enabled;
  }

  function onMouseDown(e) {
    if (!state.enabled) return;
    if (e.target.closest('#kami-annotations-popover')) return;
    state.selecting = true;
    var rect = container.getBoundingClientRect();
    state.selectionStart = {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  }

  function onMouseUp(e) {
    if (!state.enabled) return;
    state.selecting = false;
    if (!state.selectionStart) return;
    var rect = container.getBoundingClientRect();
    var x = ((e.clientX - rect.left) / rect.width) * 100;
    var y = ((e.clientY - rect.top) / rect.height) * 100;
    var sx = state.selectionStart.x;
    var sy = state.selectionStart.y;
    var dist = Math.sqrt(Math.pow(x - sx, 2) + Math.pow(y - sy, 2));

    if (dist < 0.5) { // clic sin arrastre — abrir nota si hay
      state.selectionStart = null;
      openNoteAt(e);
      return;
    }

    var region = {
      x: Math.min(sx, x),
      y: Math.min(sy, y),
      width: Math.abs(x - sx),
      height: Math.abs(y - sy),
    };

    showCreatePopup(region, e);
    state.selectionStart = null;
  }

  function openNoteAt(e) {
    var marker = e.target.closest('.kami-annotation-dot');
    if (marker) showAnnotationPopup(marker);
  }

  function showCreatePopup(region, e) {
    var rect = container.getBoundingClientRect();
    var py = (region.y / 100) * rect.height + region.height / 2 * rect.height / 100;

    popover.innerHTML = `
      <textarea id="kami-note-input" placeholder="Escribe una nota..." style="width:100%;min-height:60px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;color:#e0e0e0;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;resize:none;outline:none;"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
        <button onclick="kamiAnnotations.cancelCreate()" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:transparent;color:#8888a0;cursor:pointer;font-size:12px;">Cancelar</button>
        <button onclick="kamiAnnotations.saveNote(${JSON.stringify(region).replace(/"/g, "'")})" style="padding:6px 14px;border-radius:6px;border:none;background:#e8344a;color:#fff;cursor:pointer;font-size:12px;">Guardar</button>
      </div>
    `;
    popover.style.display = 'block';
    popover.style.left = (rect.width - 240) + 'px';
    popover.style.top = Math.min(Math.max(py - 40, 10), rect.height - 150) + 'px';

    setTimeout(function() { document.getElementById('kami-note-input').focus(); }, 100);
  }

  function cancelCreate() {
    popover.style.display = 'none';
  }

  async function saveNote(region) {
    var text = document.getElementById('kami-note-input')?.value;
    if (!text) { cancelCreate(); return; }

    try {
      var res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        body: JSON.stringify({
          mangaId: state.mangaId,
          chapterNumber: state.chapterNumber,
          pageNumber: state.pageNumber,
          region: region,
          noteText: text,
        }),
      });
      var data = await res.json();
      if (data.success) {
        cancelCreate();
        state.enabled = false;
        overlay.style.cursor = '';
        document.getElementById('btn-annotate') && document.getElementById('btn-annotate').classList.remove('active');
        await loadAnnotations();
      }
    } catch(e) {}
  }

  function showAnnotationPopup(marker) {
    var text = marker.dataset.text;
    var username = marker.dataset.username;
    var noteId = marker.dataset.id;
    var userId = marker.dataset.userid;
    var color = marker.dataset.color || '#f5c842';
    var yPct = parseFloat(marker.dataset.y);

    var isOwner = currentUser && (currentUser.id === userId || currentUser.userId === userId);
    var rect = container.getBoundingClientRect();
    var py = (yPct / 100) * rect.height;

    popover.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="width:24px;height:24px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#000;flex-shrink:0;">${getInitials(username)}</div>
        <div style="font-size:12px;font-weight:600;color:#e0e0e0;">${escHtml(username)}</div>
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.7);line-height:1.5;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:8px;">${escHtml(text)}</div>
      ${isOwner ? '<div style="margin-top:8px;text-align:right;"><button onclick="kamiAnnotations.deleteNote(' + noteId + ')" style="padding:4px 10px;border-radius:4px;border:1px solid rgba(232,51,74,0.3);background:transparent;color:#e8344a;cursor:pointer;font-size:11px;">Eliminar</button></div>' : ''}
    `;
    popover.style.display = 'block';
    popover.style.left = (rect.width - 240) + 'px';
    popover.style.top = Math.min(Math.max(py - 20, 10), rect.height - 120) + 'px';
  }

  async function deleteNote(id) {
    try {
      await fetch('/api/annotations/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + TOKEN } });
      popover.style.display = 'none';
      await loadAnnotations();
    } catch(e) {}
  }

  async function loadAnnotations() {
    try {
      var res = await fetch('/api/annotations/' + state.mangaId + '/' + state.chapterNumber + '/' + state.pageNumber, {
        headers: { 'Authorization': 'Bearer ' + TOKEN },
      });
      var data = await res.json();
      state.annotations = data.annotations || [];
      renderAnnotations();
    } catch(e) {}
  }

  function renderAnnotations() {
    document.querySelectorAll('.kami-annotation-dot').forEach(function(el) { el.remove(); });

    for (var i = 0; i < state.annotations.length; i++) {
      var a = state.annotations[i];
      var region = typeof a.region === 'string' ? JSON.parse(a.region) : a.region;
      var yCenter = region.y + region.height / 2;

      var dot = document.createElement('div');
      dot.className = 'kami-annotation-dot';
      dot.dataset.id = a.id;
      dot.dataset.userid = a.user_id;
      dot.dataset.text = a.note_text;
      dot.dataset.username = a.username || 'Anónimo';
      dot.dataset.color = a.color || '#f5c842';
      dot.dataset.y = yCenter;
      dot.style.cssText = 'position:absolute;right:8px;z-index:7;width:20px;height:20px;border-radius:50%;' +
        'background:' + (a.color || '#f5c842') + ';border:2px solid rgba(0,0,0,0.3);' +
        'display:flex;align-items:center;justify-content:center;' +
        'font-size:8px;font-weight:800;color:#000;cursor:pointer;' +
        'transition:transform .15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
      dot.style.top = 'calc(' + yCenter + '% - 10px)';
      dot.title = (a.username || 'Anónimo') + ': ' + (a.note_text || '');
      dot.onmouseenter = function() { this.style.transform = 'scale(1.3)'; };
      dot.onmouseleave = function() { this.style.transform = ''; };
      dot.onclick = function() { showAnnotationPopup(this); };
      dot.textContent = getInitials(a.username);
      container.appendChild(dot);
    }
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.substring(0, 2).toUpperCase();
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  return {
    init: init,
    toggle: toggle,
    loadAnnotations: loadAnnotations,
    saveNote: saveNote,
    cancelCreate: cancelCreate,
    deleteNote: deleteNote,
  };
})();
