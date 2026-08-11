'use strict';
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const phim = require('./1phim6');

const GENRE_NAMES    = phim.GENRES.map(g => g.name);
const COUNTRY_NAMES  = phim.COUNTRIES.map(c => c.name);
const GENRE_MAP      = {};
phim.GENRES.forEach(g => { GENRE_MAP[g.name] = g.slug; });
const COUNTRY_MAP    = {};
phim.COUNTRIES.forEach(c => { COUNTRY_MAP[c.name] = c.code; });

const EXTRA_BASE = [{ name: 'skip' }, { name: 'search' }];
const EXTRA_FULL = [
  { name: 'skip' },
  { name: 'search' },
  { name: 'genre',   options: GENRE_NAMES },
  { name: 'country', options: COUNTRY_NAMES },
];

const manifest = {
  id: 'community.1phim6.com',
  version: '1.1.0',
  name: '1Phim6',
  description: 'Xem phim từ 1Phim6 — Phim Bộ, Phim Lẻ, Hoạt Hình, Thuyết Minh',
  logo: 'https://www.1phim6.com/favicon.ico',
  catalogs: [
    { id: 'phimbo',     type: 'movie', name: '📺 Phim Bộ',        extra: EXTRA_FULL },
    { id: 'phimle',     type: 'movie', name: '🎬 Phim Lẻ',        extra: EXTRA_FULL },
    { id: 'hoathinh',   type: 'movie', name: '🎌 Hoạt Hình',      extra: EXTRA_BASE },
    { id: 'tvshow',     type: 'movie', name: '📡 TV Shows',        extra: EXTRA_BASE },
    { id: 'thuyetminh', type: 'movie', name: '🎙️ Thuyết Minh',    extra: EXTRA_BASE },
    { id: 'longtieng',  type: 'movie', name: '🔊 Lồng Tiếng',     extra: EXTRA_BASE },
    { id: 'hanquoc',    type: 'movie', name: '🇰🇷 Phim Hàn',       extra: EXTRA_BASE },
    { id: 'trungquoc',  type: 'movie', name: '🇨🇳 Phim Trung',     extra: EXTRA_BASE },
    { id: 'aumi',       type: 'movie', name: '🇺🇸 Phim Âu Mỹ',     extra: EXTRA_BASE },
    { id: 'nhatban',    type: 'movie', name: '🇯🇵 Phim Nhật',       extra: EXTRA_BASE },
    { id: 'hongkong',   type: 'movie', name: '🇭🇰 Phim Hồng Kông',  extra: EXTRA_BASE },
    { id: 'vietsubmoi', type: 'movie', name: '🔥 Vietsub Mới',     extra: EXTRA_BASE },
  ],
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['1phim6:'],
};

const CATALOG_MAP = {
  'phimbo':     { type: 'list', action: 'phim-bo' },
  'phimle':     { type: 'list', action: 'phim-le' },
  'hoathinh':   { type: 'list', action: 'phim-hoat-hinh' },
  'tvshow':     { type: 'list', action: 'tv-show' },
  'thuyetminh': { type: 'list', action: 'phim-thuyet-minh' },
  'longtieng':  { type: 'list', action: 'phim-long-tieng' },
  'hanquoc':    { type: 'country', code: 'kr' },
  'trungquoc':  { type: 'country', code: 'cn' },
  'aumi':       { type: 'country', code: 'us' },
  'nhatban':    { type: 'country', code: 'jp' },
  'hongkong':   { type: 'country', code: 'hk' },
  'vietsubmoi': { type: 'list', action: 'phim-vietsub' },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = Math.floor((parseInt(extra.skip) || 0) / 24) + 1;
  let items = [];
  try {
    if (extra.search) {
      items = await phim.search(extra.search, page);
    } else if (extra.genre && GENRE_MAP[extra.genre]) {
      items = await phim.getByGenre(GENRE_MAP[extra.genre], page);
    } else if (extra.country && COUNTRY_MAP[extra.country]) {
      items = await phim.getByCountry(COUNTRY_MAP[extra.country], page);
    } else {
      const cat = CATALOG_MAP[id];
      if (!cat) return { metas: [] };
      if (cat.type === 'list') {
        items = await phim.getList(cat.action, page);
      } else if (cat.type === 'country') {
        items = await phim.getByCountry(cat.code, page);
      }
    }
    if (!Array.isArray(items)) items = [];
    return { metas: items.map(phim.toMeta) };
  } catch(e) {
    console.error('[catalog] error:', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('1phim6:')) return { meta: null };
  try {
    const slug = id.replace('1phim6:', '');
    const data = await phim.getDetail(slug);
    if (!data) return { meta: null };
    const meta = phim.toMeta(data);
    const eps = await phim.getEpisodes(data.url);
    if (eps.length > 1) {
      meta.videos = eps.map(ep => ({
        id: `1phim6:${ep.slug}`,
        title: ep.label,
        season: 1,
        episode: ep.num,
      }));
    }
    return { meta };
  } catch(e) { return { meta: null }; }
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith('1phim6:')) return { streams: [] };
  try {
    const slug = id.replace('1phim6:', '');
    const epUrl = `https://www.1phim6.com/${slug}/`;
    const data = await phim.getStream(epUrl);
    if (!data) {
      return { streams: [{
        externalUrl: epUrl,
        title: '🔗 Mở 1Phim6',
      }]};
    }
    return { streams: [{
      url: data.streamUrl,
      title: '▶ 1Phim6 HLS',
      behaviorHints: {
        notWebReady: false,
        headers: {
          'Referer': 'https://www.1phim6.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
    }]};
  } catch(e) {
    console.error('[stream] error:', e.message);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`1Phim6 Addon: http://localhost:${PORT}/manifest.json`);
