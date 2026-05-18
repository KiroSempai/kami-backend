/**
 * ═══════════════════════════════════════════════════════
 *  KAMI — login-demo.js
 *  Gestión de autenticación LOCAL (sin backend real)
 *
 *  Simula el flujo completo de login y registro
 *  guardando la sesión en localStorage.
 *
 *  Incluir ANTES del cierre de </body> en login.html
 *  y register.html:
 *    <script src="js/login-demo.js"></script>
 *
 *  En producción, reemplazar este archivo por llamadas
 *  reales a /api/auth/login y /api/auth/register.
 * ═══════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    /* ──────────────────────────────────────────
       CONFIGURACIÓN
    ────────────────────────────────────────── */
    const IS_LOCAL = window.location.protocol === 'file:';

    function path(page) {
        return IS_LOCAL ? page + '.html' : '/' + (page === 'index' ? '' : page);
    }

    /** Simula un pequeño delay de red */
    const fakeDelay = (ms = 900) => new Promise(r => setTimeout(r, ms));

    /* ──────────────────────────────────────────
       USUARIOS DE DEMOSTRACIÓN
       En producción estos vienen del servidor.
    ────────────────────────────────────────── */
    const DEMO_USERS = [
        {
            username: 'YuAsahi',
            email: 'yu@example.com',
            password: '12345678',
            premium: true,
            role: 'premium',
            avatar: 'YU',
        },
        {
            username: 'DemoUser',
            email: 'demo@kami.es',
            password: 'demo1234',
            premium: false,
            role: 'user',
            avatar: 'DE',
        },
    ];

    /* ──────────────────────────────────────────
       GUARDAR / BORRAR SESIÓN
    ────────────────────────────────────────── */
    function saveSession(user) {
        // Guarda el usuario (sin la contraseña) y un token falso
        const { password, ...safeUser } = user;
        localStorage.setItem('kami_token', 'kami_demo_' + Date.now());
        localStorage.setItem('kami_user', JSON.stringify(safeUser));
    }

    function isLoggedIn() {
        return !!(localStorage.getItem('kami_token') && localStorage.getItem('kami_user'));
    }

    /* ──────────────────────────────────────────
       REDIRECCIÓN POST-LOGIN
       Si venía de otra página, vuelve a ella.
       Si no, va al perfil.
    ────────────────────────────────────────── */
    function redirectAfterLogin(user) {
        const returnTo = sessionStorage.getItem('kami_return_to');
        sessionStorage.removeItem('kami_return_to');

        if (returnTo && returnTo !== path('login') && returnTo !== path('register')) {
            window.location.href = returnTo;
        } else {
            window.location.href = path('perfil');
        }
    }

    /* ──────────────────────────────────────────
       LÓGICA DE LOGIN
    ────────────────────────────────────────── */
    async function handleLogin(e) {
        e.preventDefault();

        const emailInput = document.getElementById('email');
        const passInput = document.getElementById('password');
        const submitBtn = document.getElementById('submit-btn');
        const alertBox = document.getElementById('alert-box');

        if (!emailInput || !passInput) return;

        const email = emailInput.value.trim().toLowerCase();
        const password = passInput.value;

        // Ocultar alerta anterior
        if (alertBox) {
            alertBox.style.display = 'none';
            alertBox.textContent = '';
        }

        // Activar estado "cargando"
        if (submitBtn) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
        }

        await fakeDelay(800);

        // Buscar el usuario en los datos de demo
        const foundUser = DEMO_USERS.find(
            u => u.email === email && u.password === password
        );

        if (foundUser) {
            // ✅ Login correcto
            saveSession(foundUser);

            if (alertBox) {
                alertBox.style.display = 'flex';
                alertBox.className = 'alert alert-success';
                alertBox.textContent = `¡Bienvenido de vuelta, ${foundUser.username}! Redirigiendo...`;
            }

            await fakeDelay(700);
            redirectAfterLogin(foundUser);

        } else {
            // ❌ Credenciales incorrectas
            if (submitBtn) {
                submitBtn.classList.remove('loading');
                submitBtn.disabled = false;
            }

            if (alertBox) {
                alertBox.style.display = 'flex';
                alertBox.className = 'alert alert-warning';
                alertBox.textContent = 'Email o contraseña incorrectos. Prueba con yu@example.com / 12345678';
            }

            // Shake en los inputs
            [emailInput, passInput].forEach(inp => {
                inp.style.borderColor = '#e8334a';
                inp.style.animation = 'kamiShake 0.4s ease';
                setTimeout(() => {
                    inp.style.animation = '';
                    inp.style.borderColor = '';
                }, 500);
            });
        }
    }

    /* ──────────────────────────────────────────
       LÓGICA DE REGISTRO
    ────────────────────────────────────────── */
    async function handleRegister(e) {
        // Si el form ya tiene su propio handler, lo respetamos
        // Solo actuamos si no hay backend real
        if (!IS_LOCAL && window.location.hostname !== 'localhost') return;

        e.preventDefault();
        e.stopPropagation();

        const submitBtn = document.getElementById('submit-btn');
        const formError = document.getElementById('form-error');
        const formSuccess = document.getElementById('form-success');

        // Recoger campos del formulario
        const username = (document.getElementById('username') || {}).value?.trim();
        const email = (document.getElementById('email') || {}).value?.trim().toLowerCase();
        const password = (document.getElementById('password') || {}).value;

        if (!username || !email || !password) return;

        // Simular carga
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('loading');
        }

        await fakeDelay(1000);

        // Comprobar si el email ya existe en demo
        const exists = DEMO_USERS.find(u => u.email === email);
        if (exists) {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('loading'); }
            if (formError) {
                formError.classList.add('visible');
                const errTxt = document.getElementById('form-error-text');
                if (errTxt) errTxt.textContent = 'Este email ya está en uso. ¿Quizás querías iniciar sesión?';
            }
            return;
        }

        // ✅ Registro exitoso → crear usuario y guardar sesión
        const newUser = {
            username,
            email,
            password,
            premium: false,
            avatar: username.substring(0, 2).toUpperCase(),
        };

        // Añadirlo a los datos de demo para esta sesión
        DEMO_USERS.push(newUser);
        saveSession(newUser);

        // Mostrar mensaje de éxito
        if (formSuccess) {
            formSuccess.classList.add('visible');
            const successText = formSuccess.querySelector('span');
            if (successText) successText.textContent = `¡Cuenta creada! Bienvenido, ${username}. Redirigiendo...`;
        }

        await fakeDelay(1200);
        redirectAfterLogin(newUser);
    }

    /* ──────────────────────────────────────────
       REDIRECCIÓN SI YA HAY SESIÓN ACTIVA
       Evita que el usuario logueado vea login/register.
    ────────────────────────────────────────── */
    function checkAlreadyLoggedIn() {
        if (isLoggedIn()) {
            const user = JSON.parse(localStorage.getItem('kami_user') || '{}');
            window.location.href = path('perfil');
        }
    }

    /* ──────────────────────────────────────────
       INYECTAR ANIMACIÓN SHAKE
    ────────────────────────────────────────── */
    function injectStyles() {
        if (document.getElementById('kami-auth-styles')) return;
        const s = document.createElement('style');
        s.id = 'kami-auth-styles';
        s.textContent = `
      @keyframes kamiShake {
        0%, 100% { transform: translateX(0); }
        20%       { transform: translateX(-6px); }
        40%       { transform: translateX(6px); }
        60%       { transform: translateX(-4px); }
        80%       { transform: translateX(4px); }
      }
      .alert {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-radius: 10px;
        font-size: 13px;
        margin-bottom: 18px;
      }
      .alert-warning {
        background: rgba(232,51,74,0.1);
        border: 1px solid rgba(232,51,74,0.3);
        color: #e8334a;
      }
      .alert-success {
        background: rgba(45,202,122,0.1);
        border: 1px solid rgba(45,202,122,0.3);
        color: #2dca7a;
      }
    `;
        document.head.appendChild(s);
    }

    /* ──────────────────────────────────────────
       INICIALIZACIÓN según la página actual
    ────────────────────────────────────────── */
    function init() {
        injectStyles();

        const page = window.location.pathname.split('/').pop().replace('.html', '') || 'index';

        if (page === 'login') {
            // Si ya está logueado, redirigir
            checkAlreadyLoggedIn();

            // Sobreescribir el handleLogin del HTML con nuestra versión local
            window.handleLogin = handleLogin;

            // Asegurarse de que el enlace "Registrarse" usa la ruta correcta
            document.querySelectorAll('a[href="/register"]').forEach(a => {
                a.setAttribute('href', path('register'));
            });

            // Poner hint de demo bajo el formulario si es local
            if (IS_LOCAL) {
                const form = document.getElementById('login-form');
                if (form) {
                    const hint = document.createElement('p');
                    hint.style.cssText = 'margin-top:14px;font-size:11px;color:#4a4a62;text-align:center;line-height:1.6;';
                    hint.innerHTML = '💡 <strong style="color:#6a6a82;">Demo local</strong> — usa <code style="color:#8888a0;background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;">yu@example.com</code> / <code style="color:#8888a0;background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;">12345678</code>';
                    form.appendChild(hint);
                }
            }
        }

        if (page === 'register') {
            checkAlreadyLoggedIn();

            // Capturar el submit del formulario de registro
            const regForm = document.getElementById('register-form');
            if (regForm && IS_LOCAL) {
                // Guardar el handler original si existe
                const originalHandler = regForm.onsubmit;
                regForm.addEventListener('submit', handleRegister);
            }

            // Arreglar enlace "Inicia sesión"
            document.querySelectorAll('a[href="/login"]').forEach(a => {
                a.setAttribute('href', path('login'));
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();