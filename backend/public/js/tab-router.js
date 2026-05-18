/**
 * KAMI — tab-router.js
 * Incluir al final del <body> de perfil.html
 *
 * Lee el parámetro ?tab= de la URL y activa el tab correspondiente.
 * Si no hay parámetro, abre el tab por defecto (biblioteca).
 *
 * Uso en perfil.html:
 *   <script src="/js/tab-router.js"></script>
 *   (o pegar inline al final del body, antes del cierre </body>)
 */

(function () {
    // Mapa parámetro → id del botón tab en perfil.html
    const TAB_MAP = {
        biblioteca: 'tab-biblioteca',
        estadisticas: 'tab-estadisticas',
        historial: 'tab-historial',
        actividad: 'tab-actividad',
        listas: 'tab-listas',
        logros: 'tab-logros',
    };

    function activateTab(tabKey) {
        const id = TAB_MAP[tabKey];
        const btn = id ? document.getElementById(id) : null;

        if (btn) {
            btn.click();   // reutiliza la función showTab() ya existente en perfil.html
        }
    }

    function routeFromURL() {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get('tab');
        const hash = window.location.hash.replace('#', '');
        let activeTab = null;

        // Priority: URL param > URL hash > localStorage > default
        if (tab && TAB_MAP[tab]) {
            activeTab = tab;
        } else if (hash && TAB_MAP[hash]) {
            activeTab = hash;
        } else {
            try {
                const saved = localStorage.getItem('kami_active_tab');
                if (saved && TAB_MAP[saved]) activeTab = saved;
            } catch {}
        }

        if (activeTab) {
            activateTab(activeTab);
            // Clean URL but keep hash for persistence
            const cleanURL = window.location.pathname + '#' + activeTab;
            window.history.replaceState({}, '', cleanURL);
        }
    }

    // Esperar a que el DOM esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', routeFromURL);
    } else {
        routeFromURL();
    }
})();