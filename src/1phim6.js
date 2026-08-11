'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const forge = require('node-forge');

const listCache = new NodeCache({ stdTTL: 600 });
const detailCache = new NodeCache({ stdTTL: 300 });

const BASE = 'https://www.1phim19.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const jar = new CookieJar();
const client = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 20000,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'vi,en-US;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Connection': 'keep-alive',
  },
}));

async function fetchHtml(url, referer) {
  try {
    const res = await client.get(url, {
      headers: { 'Referer': referer || BASE + '/' }
    });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  } catch(e) {
    console.error('[1Phim6] fetchHtml error:', url, e.message);
    return null;
  }
}

// ── CryptoJS AES Decrypt ──────────────────────────────────────────────────────
function cryptoJsAesDecrypt(passphrase, encryptedJsonStr) {
  try {
    const obj = JSON.parse(encryptedJsonStr);
    const salt = forge.util.hexToBytes(obj.salt);
    const iv   = forge.util.hexToBytes(obj.iv);
    const ct   = forge.util.decode64(obj.ciphertext);
    const key  = forge.pkcs5.pbkdf2(
      passphrase, salt, 999, 32, forge.md.sha512.create()
    );
    const decipher = forge.cipher.createDecipher('AES-CBC', key);
    decipher.start({ iv });
    decipher.update(forge.util.createBuffer(ct));
    decipher.finish();
    const result = decipher.output.toString();
    console.log('[1Phim6] decrypted URL:', result.substring(0, 80));
    return result;
  } catch(e) {
    console.error('[1Phim6] cryptoJsAesDecrypt error:', e.message);
    return null;
  }
}

function extractPlayerUrl(html) {
  let m = html.match(/CryptoJSAesDecrypt\s*\(\s*'Encrypt'\s*,\s*`(\{[\s\S]*?\})`/);
  if (!m) {
    m = html.match(/CryptoJSAesDecrypt\s*\(\s*'Encrypt'\s*,\s*"(\{[\s\S]*?\})"/);
  }
  if (!m) {
    console.log('[1Phim6] CryptoJSAesDecrypt pattern not found');
    return null;
  }
  const encJson = m[1].replace(/\\\//g, '/').replace(/\\"/g, '"');
  return cryptoJsAesDecrypt('Encrypt', encJson);
}

// ── Slug helpers ─────────────────────────────────────────────────────────────
// Dùng __ thay / để tránh conflict khi Stremio parse ID
function toSlug(href) {
  // href dạng /phim/ten-phim hoặc https://...../phim/ten-phim
  const raw = href.replace(/^.*\/phim\//, '').replace(/\/$/, '');
  return `phim__${raw}`;
}

function fromSlug(slug) {
  // Chuyển phim__ten-phim → phim/ten-phim
  return slug.replace('phim__', 'phim/');
}

function toEpSlug(href) {
  // href dạng /phim/ten-phim/tap-1 hoặc full URL
  const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
  // /phim/ten-phim/tap-1 → phim__ten-phim__tap-1
  return path.replace(/^\//, '').replace(/\//g, '__');
}

function fromEpSlug(slug) {
  return slug.replace(/__/g, '/');
}

// ── Parse danh sách phim ──────────────────────────────────────────────────────
function parseList(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('ul.list-film li').each((i, el) => {
    const $el = $(el);
    const a = $el.find('a[title][href]').first();
    if (!a.length) return;
    const href = a.attr('href') || '';
    const title = a.attr('title') || a.text().trim();
    if (!title || !href.includes('/phim/')) return;
    const url = href.startsWith('http') ? href : BASE + href;
    const slug = toSlug(href);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const thumb = $el.find('img').first().attr('src') || '';
    const year = ($el.find('.name').text().match(/\b(20|19)\d{2}\b/) || [])[0] || '';
    const status = $el.find('.status').text().trim();
    items.push({ slug, title, thumb, url, year, status });
  });

  console.log(`[1Phim6] parseList → ${items.length} items`);
  return items;
}

// ── Danh sách phim ───────────────────────────────────────────────────────────
async function getList(action = 'phim-bo', page = 1) {
  const key = `list_${action}_${page}`;
  const c = listCache.get(key); if (c) return c;
  let url = `${BASE}/${action}/`;
  if (page > 1) url += `?page=${page}`;
  console.log('[1Phim6] getList:', url);
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function getByCountry(countryCode, page = 1) {
  const key = `country_${countryCode}_${page}`;
  const c = listCache.get(key); if (c) return c;
  let url = `${BASE}/quoc-gia/${countryCode}/`;
  if (page > 1) url += `?page=${page}`;
  console.log('[1Phim6] getByCountry:', url);
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function getByGenre(slug, page = 1) {
  const key = `genre_${slug}_${page}`;
  const c = listCache.get(key); if (c) return c;
  let url = `${BASE}/the-loai/${slug}/`;
  if (page > 1) url += `?page=${page}`;
  console.log('[1Phim6] getByGenre:', url);
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function search(keyword, page = 1) {
  const key = `search_${keyword}_${page}`;
  const c = listCache.get(key); if (c) return c;
  const normalized = keyword
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let url = `${BASE}/search/${normalized}/`;
  if (page > 1) url += `?page=${page}`;
  console.log('[1Phim6] search:', url);
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

// ── Danh sách tập ────────────────────────────────────────────────────────────
async function getEpisodes(movieUrl) {
  const key = `eps_${movieUrl}`;
  const c = detailCache.get(key); if (c) return c;
  const html = await fetchHtml(movieUrl);
  if (!html) return [];
  const $ = cheerio.load(html);
  const eps = [];

  const tapBlock = $('.page-tap');
  if (!tapBlock.length) {
    const slug = toEpSlug(movieUrl.replace(BASE, ''));
    return [{ label: 'Tập 1', url: movieUrl, slug, num: 1 }];
  }

  tapBlock.find('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).find('span').text().trim() || $(el).text().trim();
    const epUrl = href.startsWith('http') ? href : BASE + href;
    const slug = toEpSlug(epUrl.replace(BASE, ''));
    const numMatch = label.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0]) : i + 1;
    eps.push({ label, url: epUrl, slug, num });
  });

  detailCache.set(key, eps);
  return eps;
}

// ── Lấy stream URL ───────────────────────────────────────────────────────────
async function getStream(epUrl) {
  const key = `stream_${epUrl}`;
  const c = detailCache.get(key); if (c) return c;
  console.log('[1Phim6] getStream:', epUrl);
  const html = await fetchHtml(epUrl);
  if (!html) return null;

  let streamUrl = null;

  const playerUrl = extractPlayerUrl(html);
  if (playerUrl) {
    const hashMatch = playerUrl.match(/[?&]v=([a-f0-9]{32})/);
    if (hashMatch) {
      streamUrl = `${BASE}/pmm2/${hashMatch[1]}.m3u8`;
      console.log('[1Phim6] stream via CryptoJS:', streamUrl);
    }
  }

  if (!streamUrl) {
    const vpmMatch = html.match(/vpm\.php\?v=([a-f0-9]{32})/);
    if (vpmMatch) {
      streamUrl = `${BASE}/pmm2/${vpmMatch[1]}.m3u8`;
      console.log('[1Phim6] stream via fallback:', streamUrl);
    }
  }

  if (!streamUrl) {
    console.error('[1Phim6] stream not found for:', epUrl);
    return null;
  }

  const $ = cheerio.load(html);
  const title = $('title').text().split(' - ')[0].trim();
  const thumb = $('meta[property="og:image"]').attr('content') || '';
  const result = { streamUrl, title, thumb, referer: epUrl };
  detailCache.set(key, result);
  return result;
}

// ── Chi tiết phim ────────────────────────────────────────────────────────────
async function getDetail(slug) {
  const key = `detail_${slug}`;
  const c = detailCache.get(key); if (c) return c;
  const path = fromSlug(slug);
  const url = `${BASE}/${path}`;
  console.log('[1Phim6] getDetail:', url);
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim()
    || $('title').text().split(' - ')[0].trim();
  const thumb = $('meta[property="og:image"]').attr('content') || '';
  const desc  = $('meta[property="og:description"]').attr('content')
    || $('.description, .movie-desc').first().text().trim() || '';
  const year = ($('.name').text().match(/\b(20|19)\d{2}\b/) || [])[0] || '';
  const genres = [];
  $('a[href*="/the-loai/"]').each((i, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });
  const data = { slug, title, thumb, desc, year, genres, url };
  detailCache.set(key, data);
  return data;
}

function toMeta(item) {
  return {
    id: `1phim6:${item.slug}`,
    type: 'movie',
    name: item.title || item.slug,
    poster: item.thumb || '',
    background: item.thumb || '',
    description: item.desc || item.status || '',
    year: item.year ? parseInt(item.year) : undefined,
    genres: item.genres || [],
    language: 'vi',
  };
}

const GENRES = [
  { slug: 'phim-hanh-dong',   name: '💥 Hành Động' },
  { slug: 'phim-vo-thuat',    name: '⚔️ Võ Thuật' },
  { slug: 'phim-tam-ly',      name: '🎭 Tâm Lý' },
  { slug: 'phim-hai-huoc',    name: '😂 Hài Hước' },
  { slug: 'phim-hoat-hinh',   name: '🎌 Hoạt Hình' },
  { slug: 'phim-phieu-luu',   name: '🧭 Phiêu Lưu' },
  { slug: 'phim-kinh-di',     name: '👻 Kinh Dị' },
  { slug: 'phim-hinh-su',     name: '🔍 Hình Sự' },
  { slug: 'phim-chien-tranh', name: '🪖 Chiến Tranh' },
  { slug: 'phim-than-thoai',  name: '🐉 Thần Thoại' },
  { slug: 'phim-vien-tuong',  name: '🚀 Viễn Tưởng' },
  { slug: 'phim-co-trang',    name: '🏯 Cổ Trang' },
];

const COUNTRIES = [
  { code: 'us', name: '🇺🇸 Âu Mỹ' },
  { code: 'hk', name: '🇭🇰 Hồng Kông' },
  { code: 'jp', name: '🇯🇵 Nhật Bản' },
  { code: 'vn', name: '🇻🇳 Việt Nam' },
  { code: 'kr', name: '🇰🇷 Hàn Quốc' },
  { code: 'cn', name: '🇨🇳 Trung Quốc' },
  { code: 'th', name: '🇹🇭 Thái Lan' },
  { code: 'tw', name: '🇹🇼 Đài Loan' },
];

module.exports = {
  getList, getByCountry, getByGenre, search,
  getEpisodes, getStream, getDetail, toMeta,
  fromSlug, fromEpSlug,
  GENRES, COUNTRIES,
};
