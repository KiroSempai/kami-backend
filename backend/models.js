/**
 * KAMI - Models
 * Definiciones de estructura de datos
 */

// ═══════════════════════════════════════
// USER MODEL
// ═══════════════════════════════════════
const UserModel = {
    // id: uuid
    // username: string
    // email: string
    // passwordHash: string (bcrypt)
    // avatar: string (base64 o URL)
    // banner: string (base64 o URL)
    // bio: string
    // country: string
    // language: 'es' | 'en' | 'pt' | 'ja'
    // timezone: string
    // createdAt: timestamp
    // updatedAt: timestamp
    // lastLoginAt: timestamp
    // isVerified: boolean
    // isPremium: boolean
    // premiumExpires: timestamp
    // settings: {
    //   readingMode: 'vertical' | 'horizontal' | 'webtoon' | 'double',
    //   imageQuality: 'high' | 'balanced' | 'low' | 'auto',
    //   autoPreload: boolean,
    //   darkMode: boolean,
    //   nightFilter: boolean,
    //   scrollSaving: boolean,
    //   twoFA: boolean,
    //   emailNotifications: boolean,
    //   pushNotifications: boolean,
    // }
};

// ═══════════════════════════════════════
// PROFILE MODEL
// ═══════════════════════════════════════
const ProfileModel = {
    // userId: uuid (relación con User)
    // avatar: string
    // banner: string
    // username: string
    // bio: string
    // country: string
    // badges: string[] (achievements)
    // joinedDate: timestamp
    // isPublic: boolean
    // stats: {
    //   titlesRead: number,
    //   chaptersCompleted: number,
    //   hoursRead: number,
    //   currentStreak: number,
    //   maxStreak: number,
    //   followers: number,
    //   following: number,
    // }
    // favoritesList: uuid[] (manga IDs)
    // customLists: {
    //   name: string,
    //   description: string,
    //   mangas: uuid[],
    //   isPublic: boolean,
    //   isCollaborative: boolean,
    // }[]
    // activityFeed: {
    //   type: 'read' | 'favorited' | 'completed' | 'started',
    //   mangaId: uuid,
    //   chapter: number,
    //   timestamp: timestamp,
    // }[]
    // readingHeatmap: { date: string, count: number }[] (últimos 365 días)
    // compatibility: { userId: uuid, score: number }[]
};

// ═══════════════════════════════════════
// LIBRARY MODEL
// ═══════════════════════════════════════
const LibraryModel = {
    // userId: uuid
    // mangas: {
    //   mangaId: uuid,
    //   title: string,
    //   state: 'leyendo' | 'continuando' | 'pendientes' | 'favoritos' | 'terminados' | 'abandonados' | 'releyendo',
    //   currentChapter: number,
    //   currentPage: number,
    //   currentScroll: number,
    //   chapterHistory: { chapter: number, readAt: timestamp }[],
    //   score: number (1-10),
    //   notes: string,
    //   addedAt: timestamp,
    //   lastReadAt: timestamp,
    //   tags: string[],
    //   progress: number, // porcentaje
    // }[]
    // lastUpdated: timestamp
};

// ═══════════════════════════════════════
// MANGA MODEL
// ═══════════════════════════════════════
const MangaModel = {
    // id: uuid
    // title: string
    // alternativeTitles: string[]
    // cover: string (URL o base64)
    // description: string
    // type: 'manga' | 'manhwa' | 'manhua'
    // status: 'ongoing' | 'completed'
    // genres: string[] (Seinen, Shonen, Acción, etc)
    // chapters: {
    //   number: number,
    //   title: string,
    //   pages: number,
    //   releaseDate: timestamp,
    //   scanGroup: string,
    //   images: string[], // URLs
    // }[]
    // rating: number (1-10)
    // totalRatings: number
    // totalReads: number
    // updatedAt: timestamp
};

// ═══════════════════════════════════════
// SESSION MODEL
// ═══════════════════════════════════════
const SessionModel = {
    // sessionId: uuid
    // userId: uuid
    // token: string (JWT)
    // device: string (navegador, OS)
    // ipAddress: string
    // lastActivity: timestamp
    // expiresAt: timestamp
    // isActive: boolean
};

// ═══════════════════════════════════════
// EXPORTAR - Solo esquemas, sin datos mock
// ═══════════════════════════════════════

module.exports = {
    UserModel,
    ProfileModel,
    LibraryModel,
    MangaModel,
    SessionModel,
};