# KAMI — Estado del proyecto (Mayo 2026)

## Goal
Red social de manga estilo X.com con feed algorítmico, composer profesional, interacciones con toggle, WebSocket en tiempo real, comunidades auto-creadas y perfiles con actividad.

## Constraints
- Nav unificada `.nf-nav` (excluye KMI detail)
- KMI detail: topbar minimal "Volver" + logo
- Feed desde API real, sin mock data
- Composer: optimistic UI + fetch + toast + borradores, sin alert()
- Session: IntersectionObserver + sessionStorage por tab
- Scoring: OtakuCred, FandomJet, Safety, Fatigue
- Interacciones: toggle con DELETE, Redis opcional, WebSocket, parent_id, spoiler inheritance

## Key Decisions
- Feed usa XHR (no fetch) para mejor control de errores
- `/api/feed/posts` público; auth solo para postear y scoring
- Views: Opción D (IntersectionObserver + batch POST /track-views + viewed_posts con 4h anti-fraude)
- Roles: user_with_role view (admin/company/creator/golden/silver/user)
- Canales de noticias: solo posts con is_news=true, filtrados por follows

## Done
### Infraestructura
- Nav Netflix-global, KMI detail 3-columnas, layout X-comunidad
- Sidebar con 7 items (Inicio, Explorar, Notificaciones, Mensajes, Listas, Marcadores), secciones reales con goToSection
- Botón "Postear" lateral + In-Feed Composer expandible en Inicio
- Notificaciones: badge con polling 30s, panel, mark-as-read

### Feed
- 3 tabs: Para ti → /for-you (scoring), Al Día → /latest (cronológico), Mis Comunidades → /posts (genérico)
- Skeleton loading, cache localStorage, session restore, infinite scroll, timeout+retry
- Manga Mixer: 4 sub-algoritmos con tablas, +100 follow bonus, +30/-60 status bonus, -50 community penalty, spoiler blocker

### Composer
- Vincular manga (API real), capítulo auto-fill desde biblioteca, GIF picker (Giphy SDK + proxy), spoiler, comunidad, reply/quote
- Admin/company/creator ven checkboxes "Destacar en mi Canal" y "Anuncio Global"

### Interactions
- Toggle likes/reposts/bookmarks (POST /interact con DELETE), contadores reales con delta cache 10s + sync 5min
- feed_notifications, WebSocket Socket.io en canales post:{id}
- Repost menú (simple / quote), pin post (pinned_post_id), dots menu (hide/pin)

### Communities
- Auto-creación al añadir KMI, tabla community_members, join/leave
- Vista dual: posts filtrados + chat con WebSocket
- Canales de noticias agrupados por entidad (admin/company/creator), filtrados por follows

### Explore
- 2 tabs: Para mí (canales + trending + hashtags + posts populares) y Comunidades (catálogo)
- Canales de Noticias: tarjetas por entidad, al hacer clic → vista in-feed con ← Volver
- Búsqueda real de posts/mangas/usuarios, trending keywords 6h, hashtags 24h

### Views (Opción D)
- IntersectionObserver (≥50% visible), batch cada 5s, POST /track-views
- viewed_posts table con 4h anti-fraude por usuario
- Feed ya no incrementa views automáticamente

### Profile
- Privacidad: tabs Biblioteca/Estadísticas/Historial/Listas ocultas para no-dueños
- Actividad con 4 sub-tabs: Posts, Respuestas, Multimedia, Me gusta (via /profile-activity)
- renderFeedPosts + interacciones copiadas desde index.html
- Follow/unfollow toggle, sidebar "A quién seguir" funcional

### Admin
- POST /api/admin/set-role (creator/company)
- Vista user_with_role con CASCADE

## Archivos clave
| Archivo | Rol |
|---------|-----|
| `backend/public/index.html` | Comunidad: feed, composer, explorer, sidebar, notificaciones |
| `backend/public/perfil.html` | Perfil: biblioteca, actividad, privacidad, renderFeedPosts |
| `backend/public/js/feed-tracker.js` | Helpers de interacción |
| `backend/public/css/common.css` | Nav, variables, scrollbar |
| `backend/routes/routes-feed.js` | Feed, interact, track-views, pin-post, profile-activity, company-posts, user-posts |
| `backend/routes/routes-communities.js` | Comunidades CRUD, canales, search, trending, chat |
| `backend/routes/routes-social.js` | Follow/unfollow, seguidores, activity |
| `backend/routes/routes-admin.js` | Asignación de roles |
| `backend/routes/routes-manga.js` | CRUD manga + auto-crear comunidad |
| `backend/server.js` | Montaje de rutas |
| `migrate-*.sql` | Migraciones de todas las tablas |

## In Progress
- Feed filter pills (FanArt, Reseña, etc.) no filtran API data
- Tab "Mis Comunidades" llama a /posts genérico
- Chat comunitario con WebSocket funcional pero placeholder visual

## Next Steps
1. Conectar filtros del feed con la API
2. Hacer que "Mis Comunidades" filtre por comunidades del usuario
3. Mejorar UI del chat comunitario
4. Sistema de mensajes directos
