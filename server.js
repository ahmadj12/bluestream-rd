// ====== البحث بكل الطرق ======
async function findTorrent(title, year, type, season = null, episode = null) {
  // تنظيف العنوان من المسافات الزائدة
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const titleNoYear = cleanTitle.replace(/\s*\(\d{4}\)\s*/g, '').trim();
  const titleLower = cleanTitle.toLowerCase();

  // بناء استعلامات متعددة بالذكاء
  const queries = [];

  if (type === 'movie') {
    // أفلام: اسم + سنة (الأنجح)
    if (year) queries.push(`${cleanTitle} ${year}`);
    queries.push(cleanTitle);
    queries.push(`${titleNoYear} ${year}`);
    
    // أسماء إنجليزية محتملة (Matrix, Inception, etc)
    const englishGuess = guessEnglishTitle(cleanTitle);
    if (englishGuess && englishGuess !== cleanTitle) {
      queries.push(`${englishGuess} ${year}`);
      queries.push(englishGuess);
    }
  } else if (type === 'tv') {
    // مسلسل: اسم + موسم + حلقة (الأنجح)
    if (season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      queries.push(`${cleanTitle} S${s}E${e}`);
      queries.push(`${cleanTitle} ${season}x${episode}`);
      queries.push(`${titleNoYear} S${s}E${e}`);
    }
    if (year) queries.push(`${cleanTitle} ${year}`);
    queries.push(cleanTitle);
  }

  console.log(`🔍 Will try ${queries.length} queries for: "${cleanTitle}"`);

  // تجربة كل الاستعلامات
  const allTorrents = [];
  for (const q of queries) {
    console.log(`   → Searching: "${q}"`);
    const results = await searchRD(q);
    if (results && results.length > 0) {
      allTorrents.push(...results);
      console.log(`      Found ${results.length} results`);
    }
  }

  // إزالة التكرار
  const uniqueTorrents = Array.from(
    new Map(allTorrents.map(t => [t.id || t.hash, t])).values()
  );

  console.log(`📊 Total unique torrents: ${uniqueTorrents.length}`);

  if (uniqueTorrents.length === 0) return null;

  // ترتيب حسب الجودة (الأعلى أولاً)
  uniqueTorrents.sort((a, b) => {
    const qualityA = getQualityScore(a.filename);
    const qualityB = getQualityScore(b.filename);
    return qualityB - qualityA;
  });

  // تجربة كل torrent من الأعلى للأقل جودة
  for (const torrent of uniqueTorrents) {
    const filename = (torrent.filename || '').toLowerCase();
    const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

    // تحقق من تطابق الاسم (على الأقل 60% من الكلمات)
    const matchCount = titleWords.filter(word => filename.includes(word)).length;
    const matchRatio = matchCount / titleWords.length;

    if (matchRatio >= 0.6) {
      const file = pickBestFile(torrent);
      if (file) {
        console.log(`✅ Best match: ${torrent.filename} (${Math.round(matchRatio * 100)}% match)`);
        return { torrent, file, magnet: torrent.magnet };
      }
    }
  }

  // لو ما لقينا تطابق جيد، خذ الأول
  const firstTorrent = uniqueTorrents[0];
  const firstFile = pickBestFile(firstTorrent);
  if (firstFile) {
    console.log(`⚠️ Fallback to first result: ${firstTorrent.filename}`);
    return { torrent: firstTorrent, file: firstFile, magnet: firstTorrent.magnet };
  }

  return null;
}

// دالة تقييم الجودة (الأعلى = الأفضل)
function getQualityScore(filename) {
  const f = filename.toLowerCase();
  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) return 400;
  if (f.includes('1080p') || f.includes('fullhd') || f.includes('fhd')) return 300;
  if (f.includes('720p') || f.includes('hd')) return 200;
  if (f.includes('480p')) return 100;
  return 50;
}

// قاموس بسيط للعناوين العربية → الإنجليزية (لتسهيل البحث)
function guessEnglishTitle(arabicTitle) {
  const dictionary = {
    'الماتريكس': 'The Matrix',
    'البداية': 'Inception',
    'بين النجوم': 'Interstellar',
    'الخلاص': 'The Avengers',
    'العمق': 'Avatar',
    'الأسود': 'Black Panther',
    'العنكبوت': 'Spider-Man',
    'البطل': 'Hero',
    'السريع': 'Fast',
    'العصابات': 'Gangster',
    'الفارس': 'The Dark Knight',
    'الحصان': 'Horse',
    'الزمن': 'Time',
    'الحرب': 'War',
  };

  for (const [ar, en] of Object.entries(dictionary)) {
    if (arabicTitle.includes(ar)) return en;
  }
  return null;
}
