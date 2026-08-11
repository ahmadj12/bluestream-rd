const express = require("express");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

// ====== CORS ======
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 8080;

// ====== Real-Debrid Token (من Environment Variable) ======
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  console.error("أضف المتغير في Railway: Variables → RD_TOKEN");
  process.exit(1);
}

// ====== دالة طلب HTTP ======
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${RD_TOKEN}`,
        'User-Agent': 'BlueStream/3.0',
        ...(options.headers || {}),
      },
    };

    const req = protocol.request(url, reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ====== TMDB API ======
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=ar-SA&append_to_response=external_ids`;
    const response = await fetchURL(url);
    if (response.status !== 200) return null;
    return response.data;
  } catch (err) {
    return null;
  }
}

// ====== البحث في Real-Debrid ======
async function searchRD(query) {
  try {
    const url = `https://api.real-debrid.com/rest/1.0/torrents?search=${encodeURIComponent(query)}&limit=10`;
    const response = await fetchURL(url);
    if (response.status !== 200) {
      console.error(`❌ RD search error: ${response.status}`);
      return [];
    }
    return response.data || [];
  } catch (err) {
    console.error('RD search error:', err.message);
    return [];
  }
}

// ====== اختيار أفضل ملف من نتائج RD ======
function pickBestFile(torrent, quality = '1080p') {
  if (!torrent.files || torrent.files.length === 0) return null;

  // فلترة الملفات حسب الجودة
  let candidates = torrent.files.filter(f => {
    const name = (f.path || '').toLowerCase();
    
    // استبعاد الملفات الغير مرغوبة
    if (name.includes('sample') || name.includes('trailer')) return false;
    if (name.includes('cam') || name.includes('ts')) return false;
    if (name.includes('.txt') || name.includes('.nfo')) return false;

    // قبول الفيديو
    const isVideo = /\.(mkv|mp4|avi|mov|webm)$/i.test(name);
    return isVideo;
  });

  if (candidates.length === 0) return null;

  // ترتيب حسب الجودة (الأعلى أولاً)
  const qualityOrder = ['2160p', '4k', '1080p', '720p', '480p'];
  for (const q of qualityOrder) {
    const found = candidates.find(f => f.path.toLowerCase().includes(q));
    if (found) return found;
  }

  // الأكبر حجماً
  return candidates.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
}

// ====== استخراج رابط مباشر من Real-Debrid ======
async function unrestrictLink(link) {
  try {
    const url = 'https://api.real-debrid.com/rest/1.0/unrestrict/link';
    const response = await fetchURL(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { link },
    });

    if (response.status === 200 || response.status === 201) {
      console.log(`✅ RD unrestricted: ${response.data.filename || 'video'}`);
      return response.data;
    }
    console.error(`❌ RD unrestrict failed: ${response.status}`, response.data);
    return null;
  } catch (err) {
    console.error('RD unrestrict error:', err.message);
    return null;
  }
}

// ====== إضافة Torrent للـ RD ======
async function addMagnet(magnet) {
  try {
    const url = 'https://api.real-debrid.com/rest/1.0/torrents/addMagnet';
    const response = await fetchURL(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { magnet },
    });

    if (response.status === 200 || response.status === 201) {
      return response.data;
    }
    console.error(`❌ RD addMagnet failed: ${response.status}`, response.data);
    return null;
  } catch (err) {
    console.error('RD addMagnet error:', err.message);
    return null;
  }
}

// ====== انتظار حتى يكتمل Torrent ======
async function waitForTorrent(torrentId, maxWaitMs = 90000) {
  const startTime = Date.now();
  const interval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const url = `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`;
      const response = await fetchURL(url);

      if (response.status === 200) {
        const status = response.data.status;
        console.log(`📊 Torrent status: ${status}`);

        if (status === 'downloaded' || status === 'waiting_files_selection') {
          return response.data;
        }
        if (status === 'error' || status === 'magnet_error') {
          console.error(`❌ Torrent error: ${response.data.status}`);
          return null;
        }
      }
    } catch (err) {
      console.warn('Wait check error:', err.message);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  console.log('⏱️ Torrent timeout');
  return null;
}

// ====== اختيار ملف من Torrent في RD ======
async function selectTorrentFile(torrentId, fileId) {
  try {
    const url = `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`;
    const response = await fetchURL(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { files: [fileId] },
    });
    return response.status === 200 || response.status === 204;
  } catch (err) {
    return false;
  }
}

// ====== البحث بكل الطرق ======
async function findTorrent(title, year, type, season = null, episode = null) {
  // بناء كلمات البحث
  const queries = [];
  
  // اسم نظيف مع السنة
  if (year) queries.push(`${title} ${year}`);
  queries.push(title);
  
  // إضافة الموسم والحلقة إذا كان مسلسل
  if (type === 'tv' && season && episode) {
    queries.push(`${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
    queries.push(`${title} ${season}x${episode}`);
  }

  // تجربة كل الاستعلامات
  for (const q of queries) {
    console.log(`🔍 RD search: "${q}"`);
    const results = await searchRD(q);
    
    if (results && results.length > 0) {
      // البحث عن أنسب نتيجة
      for (const torrent of results) {
        const filename = (torrent.filename || '').toLowerCase();
        const titleLower = title.toLowerCase();
        
        // تحقق من تطابق الاسم
        if (filename.includes(titleLower) || titleLower.includes(filename.split(' ')[0])) {
          const file = pickBestFile(torrent);
          if (file) {
            console.log(`✅ Found torrent: ${torrent.filename}`);
            return { torrent, file, magnet: torrent.magnet };
          }
        }
      }
      
      // لو ما لقينا، خذ أول نتيجة
      const firstResult = results[0];
      const file = pickBestFile(firstResult);
      if (file) {
        console.log(`⚠️ Using first result: ${firstResult.filename}`);
        return { torrent: firstResult, file, magnet: firstResult.magnet };
      }
    }
  }

  return null;
}

// ====== API الرئيسي: تشغيل فيلم/مسلسل/أنمي ======
app.get("/api/play", async (req, res) => {
  const { id, type, season, episode } = req.query;

  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  try {
    // 1) جلب metadata من TMDB
    const meta = await getTMDBMeta(id, type);
    if (!meta) {
      return res.status(404).json({ success: false, error: "TMDB metadata not found" });
    }

    const title = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

    console.log(`\n🎬 Playing: ${title} (${year})`);
    console.log(`📺 Type: ${type} | Season: ${season || 1} | Episode: ${episode || 1}`);

    // 2) البحث في Real-Debrid
    const found = await findTorrent(title, year, type, season, episode);
    
    if (!found) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${title}" في Real-Debrid`,
        title,
        year,
      });
    }

    // 3) إضافة Magnet للـ RD
    const magnetData = await addMagnet(found.magnet);
    if (!magnetData) {
      return res.status(500).json({ success: false, error: "Failed to add magnet to RD" });
    }

    const torrentId = magnetData.id;

    // 4) اختيار الملف
    await selectTorrentFile(torrentId, found.file.id);

    // 5) انتظار حتى يكتمل التحميل
    const torrentInfo = await waitForTorrent(torrentId);
    if (!torrentInfo) {
      return res.status(500).json({ success: false, error: "Torrent download timeout" });
    }

    // 6) إيجاد رابط الملف في RD
    const selectedFile = torrentInfo.files.find(f => f.id === found.file.id) || found.file;

    if (!selectedFile.links || selectedFile.links.length === 0) {
      return res.status(500).json({ success: false, error: "No links found in RD" });
    }

    // 7) استخراج الرابط المباشر
    const unrestricted = await unrestrictLink(selectedFile.links[0]);
    if (!unrestricted) {
      return res.status(500).json({ success: false, error: "Failed to unrestrict link" });
    }

    return res.json({
      success: true,
      provider: 'real-debrid',
      quality: '1080p',
      title,
      year,
      filename: found.torrent.filename,
      stream_url: unrestricted.download,
      subtitles: [],
      // معلومات إضافية مفيدة
      size_mb: Math.round((selectedFile.bytes || 0) / 1024 / 1024),
      duration: meta.runtime || null,
      poster: meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null,
    });

  } catch (err) {
    console.error("❌ API Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ====== API: جلب Metadata فقط ======
app.get("/api/metadata", async (req, res) => {
  const { id, type } = req.query;
  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  const meta = await getTMDBMeta(id, type);
  if (!meta) {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  return res.json({ success: true, ...meta });
});

// ====== Health Check ======
app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid Scraper API",
    version: "3.0",
    provider: "Real-Debrid",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      metadata: "/api/metadata?id={tmdb_id}&type={movie|tv}",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 Real-Debrid Scraper API v3.0 running on port ${PORT}`);
  console.log(`✅ Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
