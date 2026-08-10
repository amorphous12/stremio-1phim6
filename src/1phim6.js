'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const forge = require('node-forge');

const listCache = new NodeCache({ stdTTL: 600 });
const detailCache = new NodeCache({ stdTTL: 300 });

const BASE = 'https://www.1phim6.com';
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
// passphrase='Encrypt', PBKDF2 SHA512, keySize=32 bytes, iterations=999
function cryptoJsAesDecrypt(passphrase, encryptedJsonStr) {
  try {
    const obj = JSON.parse(encryptedJsonStr);
    const salt = forge.util.hexToBytes(obj.salt);
    const iv   = forge.util.hexToBytes(obj.iv);
    const ct   = forge.util.decode64(obj.ciphertext);

    // PBKDF2 SHA512, 999 iterations, 32 bytes key
    const key = forge.pkcs5.pbkdf2(
      passphrase,
      salt,
      999,
      32,
      forge.md.sha512.create()
    );

    const decipher = forge.cipher.createDecipher('AES-CBC', key);
    decipher.start({ iv });
    decipher.update(forge.util.createBuffer(ct));
    decipher.finish();

    // Unpad PKCS7
    const result = decipher.output.toString();
    console.log('[1Phim6] decrypted URL:', result.substring(0, 80));
    return result;
  } catch(e) {
    console.error('[1Phim6] cryptoJsAesDecrypt error:', e.message);
    return null;
  }
}

// Tìm và giải mã CryptoJSAesDecrypt trong HTML
function extractPlayerUrl(html) {
  // Pattern backtick: CryptoJSAesDecrypt('Encrypt', `{...}`)
  let m = html.match(/CryptoJSAesDecrypt\s*\(\s*'Encrypt'\s*,\s*`(\{[\s\S]*?\})`/);
  if (!m) {
    // Pattern double-quote: CryptoJSAesDecrypt('Encrypt', "{...}")
    m = html.match(/CryptoJSAesDecrypt\s*\(\s*'Encrypt'\s*,\s*"(\{[\s\S]*?\})"/);
  }
  if (!m) {
    console.log('[1Phim6] CryptoJSAesDecrypt pattern not found');
    return null;
  }
  const encJson = m[1].replace(/\\\//g, '/').replace(/\\"/g, '"');
  return cryptoJsAesDecrypt('Encrypt', encJson);
}

// ── Parse danh sách phim ──────────────────────────────────────────────────────
function parseList(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('li').each((i, el) => {
    const $el = $(el);
    const a = $el.find('a[title][href]').first();
    if (!a.length) return;
    const href = a.attr('href') || '';
    const title = a.attr('title') || a.text().trim();
    const url = href.startsWith('http') ? href : BASE + href;
    const slug = url.replace(/^.*1phim6\.com\//, '').replace(/\/$/, '');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const thumb = $el.find('img').first().attr('src') || '';
    const year = ($el.text().match(/\b(19|20)\d{2}\b/) || [])[0] || '';
    items.push({ slug, title: title.trim(), thumb, url, year });
  });

  return items;
}

// ── Danh sách phim ───────────────────────────────────────────────────────────
async function getList(action = 'phim-bo', page = 1) {
  const key = `list_${action}_${page}`;
  const c = listCache.get(key); if (c) return c;
  let url = `${BASE}/${action}/`;
  if (page > 1) url += `?page=${page}`;
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function getByCountry(countryCode, page = 1) {
  const key = `country_${countryCode}_${page}`;
  const c = listCache.get(key); if (c) return c;
  const url = `${BASE}/index.php?do=phim&act=searchs&country=${countryCode}&page=${page}`;
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function getByGenre(slug, page = 1) {
  const key = `genre_${slug}_${page}`;
  const c = listCache.get(key); if (c) return c;
  let url = `${BASE}/the-loai/${slug}/`;
  if (page > 1) url += `?page=${page}`;
  const html = await fetchHtml(url);
  const r = parseList(html);
  listCache.set(key, r); return r;
}

async function search(keyword, page = 1) {
  const key = `search_${keyword}_${page}`;
  const c = listCache.get(key); if (c) return c;
  // Normalize keyword: bỏ dấu, lowercase, thay space bằng -
  const normalized = keyword
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let url = `${BASE}/search/${normalized}/`;
  if (page > 1) url += `?page=${page}`;
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

  // Tìm div.page-tap chứa danh sách tập
  const tapBlock = $('.page-tap');
  if (!tapBlock.length) {
    // Phim lẻ — chỉ có 1 tập
    const slug = movieUrl.replace(/^.*1phim6\.com\//, '').replace(/\/$/, '');
    return [{ label: 'Tập 1', url: movieUrl, slug, num: 1 }];
  }

  tapBlock.find('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).find('span').text().trim() || $(el).text().trim();
    const epUrl = href.startsWith('http') ? href : BASE + href;
    const epSlug = epUrl.replace(/^.*1phim6\.com\//, '').replace(/\/$/, '');
    const numMatch = label.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0]) : i + 1;
    eps.push({ label, url: epUrl, slug: epSlug, num });
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

  // Giải mã CryptoJS AES → vpm.php?v=HASH
  let streamUrl = null;
  const playerUrl = extractPlayerUrl(html);

  if (playerUrl) {
    const hashMatch = playerUrl.match(/[?&]v=([a-f0-9]{32})/);
    if (hashMatch) {
      streamUrl = `${BASE}/pmm2/${hashMatch[1]}.m3u8`;
      console.log('[1Phim6] stream URL:', streamUrl);
    }
  }

  // Fallback: tìm vpm.php trực tiếp trong HTML
  if (!streamUrl) {
    const vpmMatch = html.match(/vpm\.php\?v=([a-f0-9]{32})/);
    if (vpmMatch) {
      streamUrl = `${BASE}/pmm2/${vpmMatch[1]}.m3u8`;
      console.log('[1Phim6] stream URL (fallback):', streamUrl);
    }
  }

  if (!streamUrl) {
    console.error('[1Phim6] stream URL not found for:', epUrl);
    return null;
  }

  // Parse meta
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
  const url = `${BASE}/${slug}/`;
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  const title = $('h1, .movie-title').first().text().trim()
    || $('title').text().split(' - ')[0].trim();
  const thumb = $('meta[property="og:image"]').attr('content') || '';
  const desc = $('meta[property="og:description"]').attr('content')
    || $('.description, .movie-desc').first().text().trim() || '';
  const year = ($('.year').text().match(/\d{4}/) || [])[0] || '';
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
    description: item.desc || '',
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
  GENRES, COUNTRIES,
};