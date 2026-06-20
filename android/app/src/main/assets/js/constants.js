const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const LOCAL_METADATA_ENDPOINT = "/api/catalog";
const LOCAL_SOURCE_PROXY_ENDPOINT = "/api/source";
const JIKAN_TOP_ENDPOINT = "https://api.jikan.moe/v4/top/anime?filter=airing&limit=25";
const JIKAN_POPULAR_ENDPOINT = "https://api.jikan.moe/v4/top/anime?filter=bypopularity&limit=25";
const JIKAN_SEASON_ENDPOINT = "https://api.jikan.moe/v4/seasons/now?limit=25";
const HOME_INITIAL_CARD_LIMIT = 14;
const HOME_CARD_LIMIT = 54;
const LIBRARY_CARD_LIMIT = 360;
const SEARCH_CARD_LIMIT = 720;
const ADDON_CARD_LIMIT = 120;
const ANIPUB_FALLBACK_CACHE_KEY = "animetv-anipub-title-map";
const ANIPUB_FALLBACK_CACHE_TTL = 1000 * 60 * 60;
const API_TIMEOUT_MS = 5000;
const RESPONSE_CACHE_TTL = 1000 * 60 * 5;
const RESPONSE_CACHE_PREFIX = "animetv-response-cache:";
const ANIPUB_FULL_CATALOG_ENDPOINT = "/api/anipub/catalog/all?limit=12000";
const TIOANIME_SLUGS_ENDPOINT = "/api/tioanime/slugs";
const ANIMEAV1_SLUGS_ENDPOINT = "/api/animeav1/slugs";
const JKANIME_SLUGS_ENDPOINT = "/api/jkanime/slugs";
const TRANSLATE_ENDPOINT = "/api/translate";
const SUBTITLE_TRANSLATION_CACHE_PREFIX = "animetv-subtitle-translation:";
const ANIPUB_EPISODE_FALLBACK_PREFIX = "animetv-anipub-episode:";
const ANIPUB_EPISODE_FALLBACK_TTL = 1000 * 60 * 60;
const ANIME1V_FALLBACK_PREFIX = "animetv-anime1v-fallback:";
const ANIME1V_FALLBACK_TTL = 1000 * 60 * 45;
const JIMOV_FALLBACK_PREFIX = "animetv-jimov-fallback:";
const JIMOV_FALLBACK_TTL = 1000 * 60 * 45;
const LANGUAGE_PREFERENCES_KEY = "animetv-language-preferences";
const APP_LANGUAGE_KEY = "animetv-app-language";
const APP_THEME_KEY = "animetv-app-theme";
const APP_UI_PREFS_KEY = "animetv-ui-preferences";
const ANIME1V_API_KEY_STORAGE = "animetv-anime1v-api-key";
const PREFERRED_SOURCE_KEY = "animetv-preferred-playback-source";
const WATCH_HISTORY_KEY = "animetv-watch-history";
const RESUME_POSITIONS_KEY = "animetv-resume-positions";
const pendingSourceLookups = new Map();
const ANILIST_META_CACHE_PREFIX = "animetv-anilist-meta:";
const ANILIST_META_CACHE_TTL = 1000 * 60 * 60 * 24;   // 24 h — metadata is stable
const ANILIST_SEARCH_CACHE_TTL = 1000 * 60 * 60 * 6;  // 6 h — search results
const ANILIST_MEDIA_ENDPOINT = "/api/anilist/media";
const ANILIST_SEARCH_ENDPOINT = "/api/anilist/search";
// Format groups used for franchise display.
// ONA (Original Net Animation) is included in TV formats because many modern
// anime are classified as ONA by AniList when they stream first before TV
// broadcast (e.g. Rent-a-Girlfriend S4/S5, many Netflix/Amazon titles).
// These are functionally regular series seasons, not one-shot specials.
const ANILIST_TV_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const ANILIST_EXTRA_FORMATS = new Set(["MOVIE", "OVA", "SPECIAL", "MUSIC"]);
// Relation types treated as franchise/season links
const ANILIST_FRANCHISE_RELATIONS = new Set(["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY"]);
