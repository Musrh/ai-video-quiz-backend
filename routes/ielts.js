const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const ffmpegPath = require('ffmpeg-static');
const youtubedl = require('youtube-dl-exec');
const { createWorker } = require('tesseract.js');

const router = express.Router();
const execFileAsync = promisify(execFile);

// ============================================================
// CONFIGURATION
// ============================================================

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';
const TRANSCRIPT_API_URL = 'https://www.youtubetranscript.dev/api/v2/transcribe';
const ANTHROPIC_URL =
  process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// OCR
// Les images sont prises sur TOUTE la durée de la vidéo : l'intervalle s'adapte
// à la durée (entre 3 et 20 secondes) au lieu d'une image toutes les 8 s qui
// s'arrêtait à 24 minutes. IELTS_OCR_INTERVAL force un intervalle fixe.
const OCR_FIXED_INTERVAL = Number(process.env.IELTS_OCR_INTERVAL || 0);
const OCR_TARGET_FRAMES = Number(process.env.IELTS_OCR_TARGET_FRAMES || 360);
const OCR_MIN_INTERVAL = 3;
const OCR_MAX_INTERVAL = 20;
const OCR_MAX_FRAMES = Number(process.env.IELTS_OCR_MAX_FRAMES || 480);
const OCR_FRAME_WIDTH = Number(process.env.IELTS_OCR_WIDTH || 1600);
const OCR_VIDEO_HEIGHT = Number(process.env.IELTS_VIDEO_HEIGHT || 720);

// Images quasi identiques (même page de questions affichée longtemps) :
// on n'en lit que 3 par page, ce qui accélère beaucoup l'analyse.
const OCR_SAME_THRESHOLD = 1.5; // différence moyenne (sur 255) sous laquelle deux images sont "identiques"
const OCR_MAX_PER_RUN = 3;

// Sondage avant l'analyse complète : si aucune page de questions n'apparaît
// dans ces images réparties sur la vidéo, on abandonne tout de suite (économie de crédit).
const OCR_PROBE_FRAMES = 20;

// ----- Lecture des pages par Claude (vision) -----
// L'OCR repère les pages ; Claude les lit comme une personne (deux colonnes,
// numéros dessinés, schémas, petits textes) puis corrige/complète l'OCR.
//   ANTHROPIC_API_KEY      : clé API (sans elle, seul l'OCR est utilisé)
//   IELTS_CLAUDE_MODE      : "rescue" (défaut : seulement si l'OCR est incomplet),
//                            "always" (toujours) ou "off"
//   IELTS_CLAUDE_MODEL     : modèle de lecture (défaut claude-sonnet-5-5)
//   IELTS_CLAUDE_CHECK_MODEL : modèle économique pour vérifier si la vidéo montre des questions
//   IELTS_CLAUDE_MAX_IMAGES  : nombre maximum d'images envoyées par vidéo (défaut 30)
const CLAUDE_MODE = String(process.env.IELTS_CLAUDE_MODE || 'rescue').toLowerCase();
const CLAUDE_READ_MODEL = process.env.IELTS_CLAUDE_MODEL || 'claude-sonnet-5-5';
const CLAUDE_CHECK_MODEL =
  process.env.IELTS_CLAUDE_CHECK_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_MAX_IMAGES = Number(process.env.IELTS_CLAUDE_MAX_IMAGES || 30);
const CLAUDE_BATCH_SIZE = Number(process.env.IELTS_CLAUDE_BATCH || 6);
const CLAUDE_CHECK_IMAGES = 6;

// Numérotation des questions IELTS Listening : 1 à 40
const MAX_QUESTION_NUMBER = 40;

// ============================================================
// RECHERCHE YOUTUBE IELTS
// ============================================================

const LISTENING_QUERIES = [
  'IELTS Listening test with questions',
  'IELTS Listening practice test questions',
  'IELTS Listening full test questions',
  'IELTS Listening practice Cambridge questions',
  'IELTS Listening test section 1 2 3 4',
  'IELTS Listening test answers questions',
  'IELTS Listening actual test questions',
  'IELTS Listening mock test questions'
];

const IELTS_TERMS = [
  'ielts',
  'ielts academic',
  'ielts general training',
  'ielts preparation',
  'ielts test',
  'ielts practice',
  'ielts listening',
  'ielts listening test',
  'ielts listening practice',
  'cambridge ielts'
];

const EXCLUDED_TERMS = [
  'shorts',
  'music video',
  'lyrics',
  'karaoke',
  'remix',
  'trailer',
  'teaser',
  'livestream',
  'live stream',
  'reaction',
  'movie',
  'film'
];

// ============================================================
// MARQUEURS IELTS
// ============================================================

const QUESTION_MARKERS = [
  'question',
  'questions',
  'choose the correct answer',
  'choose the correct',
  'complete the form',
  'complete the notes',
  'complete the table',
  'complete the sentence',
  'complete the summary',
  'write no more than',
  'answer questions',
  'questions 1',
  'questions 2',
  'questions 3',
  'questions 4',
  'questions 5',
  'questions 6',
  'questions 7',
  'questions 8',
  'questions 9',
  'questions 10'
];

// ============================================================
// OUTILS
// ============================================================

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function containsAny(text, terms) {
  const value = String(text || '').toLowerCase();
  return terms.some(term => value.includes(term.toLowerCase()));
}

function getVideoIdFromUrl(value) {
  if (!value) return null;

  const input = String(value).trim();

  // ID YouTube direct
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);

    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be')) {
      if (url.hostname.includes('youtu.be')) {
        return url.pathname.replace('/', '').substring(0, 11);
      }

      const id = url.searchParams.get('v');
      if (id) return id;

      const parts = url.pathname.split('/');
      const embedIndex = parts.indexOf('embed');

      if (embedIndex !== -1 && parts[embedIndex + 1]) {
        return parts[embedIndex + 1].substring(0, 11);
      }
    }
  } catch (_) {
    // ignore
  }

  return null;
}

function parseDuration(duration) {
  if (!duration) return 0;

  const match = String(duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  return hours * 3600 + minutes * 60 + seconds;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return (
      `${String(h).padStart(2, '0')}:` +
      `${String(m).padStart(2, '0')}:` +
      `${String(s).padStart(2, '0')}`
    );
  }

  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ============================================================
// YOUTUBE API
// ============================================================

async function searchYouTube(query) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY manquante');
  }

  const response = await axios.get(`${YOUTUBE_API_URL}/search`, {
    params: {
      key: process.env.YOUTUBE_API_KEY,
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: 50,
      videoDuration: 'medium',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      relevanceLanguage: 'en',
      regionCode: 'US'
    },
    timeout: 30000
  });

  return response.data.items || [];
}

async function getVideoDetails(videoIds) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY manquante');
  }

  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    return [];
  }

  const uniqueIds = [...new Set(videoIds)].filter(Boolean);

  const response = await axios.get(`${YOUTUBE_API_URL}/videos`, {
    params: {
      key: process.env.YOUTUBE_API_KEY,
      part: 'snippet,contentDetails,status,statistics',
      id: uniqueIds.join(',')
    },
    timeout: 30000
  });

  return response.data.items || [];
}

// ============================================================
// CONSTRUCTION VIDEO
// ============================================================

function buildVideoObject(item) {
  const snippet = item.snippet || {};
  const contentDetails = item.contentDetails || {};
  const status = item.status || {};
  const statistics = item.statistics || {};

  const durationSeconds = parseDuration(contentDetails.duration);

  const language =
    snippet.defaultLanguage ||
    snippet.defaultAudioLanguage ||
    '';

  return {
    videoId: item.id,
    title: snippet.title || '',
    description: snippet.description || '',
    channelTitle: snippet.channelTitle || '',
    publishedAt: snippet.publishedAt || null,
    duration: contentDetails.duration || null,
    durationSeconds,
    language: language || 'en',
    thumbnail:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      null,
    views: safeNumber(statistics.viewCount),
    likes: safeNumber(statistics.likeCount),
    privacyStatus: status.privacyStatus || null,
    embeddable: status.embeddable !== false,
    skill: 'listening'
  };
}

function calculateQuality(video) {
  let score = 0;

  const title = video.title.toLowerCase();
  const description = video.description.toLowerCase();

  if (title.includes('ielts listening')) {
    score += 35;
  } else if (title.includes('ielts')) {
    score += 20;
  }

  if (title.includes('test')) score += 20;
  if (title.includes('question')) score += 15;
  if (title.includes('answer')) score += 10;
  if (description.includes('listening')) score += 10;
  if (video.embeddable) score += 5;

  return Math.min(100, score);
}

// ============================================================
// FILTRAGE DES VIDEOS
// ============================================================

function processVideos(items) {
  const candidates = [];

  for (const item of items) {
    const video = buildVideoObject(item);

    const combined = `${video.title} ${video.description}`.toLowerCase();

    if (!containsAny(combined, IELTS_TERMS)) continue;
    if (containsAny(combined, EXCLUDED_TERMS)) continue;

    if (video.privacyStatus && video.privacyStatus !== 'public') continue;
    if (video.embeddable === false) continue;
    if (video.title.length < 8) continue;
    if (video.description.length < 20) continue;

    if (video.durationSeconds < 120 || video.durationSeconds > 3600) continue;

    video.quality = calculateQuality(video);
    candidates.push(video);
  }

  return candidates;
}

// ============================================================
// TRANSCRIPTION
// ============================================================

async function getTranscript(videoId) {
  if (!process.env.YOUTUBE_TRANSCRIPT_API_KEY) {
    return {
      text: '',
      segments: [],
      status: 'missing_api_key',
      language: 'en',
      source: 'none',
      videoId
    };
  }

  try {
    const response = await axios.post(
      TRANSCRIPT_API_URL,
      {
        video: videoId,
        language: 'en',
        source: 'auto',
        format: {
          timestamp: true,
          paragraphs: true,
          words: false
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.YOUTUBE_TRANSCRIPT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const data = response.data || {};

    const rawSegments = Array.isArray(data.segments) ? data.segments : [];

    let text = data.text || data.transcript || '';

    if (!text && rawSegments.length > 0) {
      text = rawSegments
        .map(item => item.text || item.content || '')
        .join(' ');
    }

    const segments = rawSegments
      .map(item => {
        const start = Number(item.start ?? item.startTime ?? item.offset ?? 0);
        const end = Number(item.end ?? item.endTime ?? start);

        return {
          text: normalizeText(item.text || item.content || ''),
          start,
          end,
          startFormatted: formatTime(start),
          endFormatted: formatTime(end)
        };
      })
      .filter(item => item.text);

    return {
      text: normalizeText(text),
      segments,
      status: data.status || 'completed',
      language: data.language || 'en',
      source: data.source || 'transcript',
      videoId
    };
  } catch (error) {
    console.error('⚠️ Transcript error:', error.response?.data || error.message);

    return {
      text: '',
      segments: [],
      status: 'error',
      language: 'en',
      source: 'error',
      videoId,
      error: error.message
    };
  }
}

// ============================================================
// DETECTION QUESTIONS DANS TRANSCRIPT
// ============================================================

function hasQuestionMarkers(text) {
  const value = String(text || '').toLowerCase();

  const markers = QUESTION_MARKERS.filter(marker => value.includes(marker));

  return {
    found: markers.length > 0,
    markers
  };
}

function findQuestionSegments(segments) {
  const zones = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const text = segment.text || '';

    if (
      /^\s*(question\s*)?\d{1,2}[\.\):\-]/i.test(text) ||
      /questions?\s+\d{1,2}/i.test(text)
    ) {
      zones.push({
        start: segment.start,
        end: segment.end,
        text
      });
    }
  }

  return zones;
}

// ============================================================
// OCR : TELECHARGEMENT VIDEO
// ============================================================

async function createTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'ielts-'));
}

async function downloadYoutubeVideo(videoId, outputPath) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const options = {
    noPlaylist: true,

    // Image seule (le son est inutile pour lire les questions), en haute qualité.
    // L'ancien format "best[ext=mp4]" ne donnait en pratique que du 360p, trop
    // flou pour les petits textes. IELTS_VIDEO_FORMAT permet de revenir en arrière.
    format:
      process.env.IELTS_VIDEO_FORMAT ||
      `bv*[height<=${OCR_VIDEO_HEIGHT}][ext=mp4]/bv*[height<=${OCR_VIDEO_HEIGHT}]/` +
      `best[height<=${OCR_VIDEO_HEIGHT}][ext=mp4]/best[height<=${OCR_VIDEO_HEIGHT}]/best`,

    output: outputPath,
    mergeOutputFormat: 'mp4',

    // ffmpeg embarqué (ffmpeg-static) pour fusionner vidéo + audio si besoin
    ffmpegLocation: ffmpegPath,

    // Résolution des défis JavaScript de YouTube
    // (nécessite Node 20+ : voir "engines" dans package.json)
    jsRuntimes: 'node',
    remoteComponents: 'ejs:github',

    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    quiet: true,
    retries: 3
  };

  // ----------------------------------------------------------
  // Cookies optionnelles
  // ----------------------------------------------------------

  if (process.env.YOUTUBE_COOKIES_BASE64) {
    try {
      const cookieFile = path.join(path.dirname(outputPath), 'cookies.txt');

      await fsp.writeFile(
        cookieFile,
        Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64')
      );

      options.cookies = cookieFile;

      console.log('🍪 Cookies YouTube temporaires utilisés');
    } catch (error) {
      console.warn('⚠️ Impossible de créer cookies.txt:', error.message);
    }
  }

  console.log(`⬇️ Téléchargement vidéo ${videoId}...`);

  try {
    await youtubedl(url, options);

    if (!fs.existsSync(outputPath)) {
      throw new Error('yt-dlp terminé mais le fichier vidéo est introuvable');
    }

    const stat = await fsp.stat(outputPath);

    if (stat.size < 10000) {
      throw new Error('Fichier vidéo téléchargé invalide ou vide');
    }

    console.log(`✅ Vidéo téléchargée: ${Math.round(stat.size / 1024 / 1024)} MB`);

    return outputPath;
  } catch (error) {
    console.error('❌ Erreur téléchargement:', error.stderr || error.message);

    throw new Error(
      `Téléchargement YouTube impossible: ${error.stderr || error.message}`
    );
  }
}

// ============================================================
// OCR : EXTRACTION DES FRAMES
// ============================================================

const SIGNATURE_WIDTH = 64;
const SIGNATURE_HEIGHT = 36;

// Durée réelle de la vidéo téléchargée (lue dans les messages de ffmpeg)
async function probeDuration(videoPath) {
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024
    });
  } catch (error) {
    const match = String(error.stderr || '').match(
      /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
    );

    if (match) {
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }

  return 0;
}

function chooseInterval(durationSeconds) {
  if (OCR_FIXED_INTERVAL > 0) {
    return OCR_FIXED_INTERVAL;
  }

  const duration = durationSeconds > 0 ? durationSeconds : 1800;

  return Math.min(
    OCR_MAX_INTERVAL,
    Math.max(OCR_MIN_INTERVAL, Math.ceil(duration / OCR_TARGET_FRAMES))
  );
}

// Une seule lecture de la vidéo produit à la fois les images (JPEG) et une
// "signature" minuscule de chacune (64x36 en gris) pour repérer les doublons.
async function extractFrames(videoPath, framesDir, interval) {
  await fsp.mkdir(framesDir, { recursive: true });

  const outputPattern = path.join(framesDir, 'frame-%05d.jpg');

  console.log(`🎞️ Extraction d'une image toutes les ${interval}s...`);

  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',

      '-i',
      videoPath,

      '-filter_complex',
      `[0:v]fps=1/${interval},split=2[a][b];` +
        `[a]scale=${OCR_FRAME_WIDTH}:-2:flags=lanczos[o1];` +
        `[b]scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT}:flags=area,format=gray[o2]`,

      '-map',
      '[o1]',
      '-q:v',
      '3',
      '-frames:v',
      String(OCR_MAX_FRAMES),
      outputPattern,

      '-map',
      '[o2]',
      '-frames:v',
      String(OCR_MAX_FRAMES),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1'
    ],
    {
      encoding: 'buffer',
      timeout: 20 * 60 * 1000,
      maxBuffer:
        SIGNATURE_WIDTH * SIGNATURE_HEIGHT * OCR_MAX_FRAMES + 5 * 1024 * 1024
    }
  );

  const files = (await fsp.readdir(framesDir))
    .filter(file => file.endsWith('.jpg'))
    .sort();

  const frameBytes = SIGNATURE_WIDTH * SIGNATURE_HEIGHT;
  const signatures = [];

  for (let i = 0; i + frameBytes <= stdout.length; i += frameBytes) {
    signatures.push(stdout.subarray(i, i + frameBytes));
  }

  console.log(`🖼️ ${files.length} images extraites`);

  const frames = files.map((file, index) => ({
    file: path.join(framesDir, file),
    index,
    timestamp: index * interval
  }));

  return { frames, signatures };
}

function frameDifference(a, b) {
  const n = Math.min(a.length, b.length);

  if (n === 0) {
    return 255;
  }

  let sum = 0;

  for (let i = 0; i < n; i++) {
    sum += Math.abs(a[i] - b[i]);
  }

  return sum / n;
}

// Groupes d'images identiques qui se suivent (même page affichée longtemps) :
// [[première, dernière], ...]. Sans signatures, chaque image est son propre groupe.
function findRuns(frames, signatures) {
  if (!signatures || signatures.length < frames.length) {
    return frames.map((_, index) => [index, index]);
  }

  const runs = [];
  let start = 0;

  for (let i = 1; i <= frames.length; i++) {
    let same = false;

    if (i < frames.length) {
      same =
        frameDifference(signatures[i - 1], signatures[i]) < OCR_SAME_THRESHOLD &&
        frameDifference(signatures[start], signatures[i]) < OCR_SAME_THRESHOLD * 3;
    }

    if (!same) {
      runs.push([start, i - 1]);
      start = i;
    }
  }

  return runs;
}

// N'en garde que 3 par groupe : début, milieu, fin.
function selectFramesForOcr(frames, signatures) {
  if (!signatures || signatures.length < frames.length) {
    return frames.slice();
  }

  const chosen = [];

  for (const [first, last] of findRuns(frames, signatures)) {
    const length = last - first + 1;

    const indexes =
      length <= OCR_MAX_PER_RUN
        ? Array.from({ length }, (_, k) => first + k)
        : [first, Math.round((first + last) / 2), last];

    indexes.forEach(index => chosen.push(frames[index]));
  }

  return chosen;
}

function evenlySpaced(list, count) {
  if (list.length <= count) {
    return list.slice();
  }

  const picked = [];

  for (let i = 0; i < count; i++) {
    picked.push(list[Math.floor((i * list.length) / count)]);
  }

  return picked;
}

// ============================================================
// OCR : ANALYSE D'UNE FRAME
// ============================================================

function looksLikeQuestionText(text) {
  const value = String(text || '').toLowerCase();

  if (!value || value.length < 15) {
    return false;
  }

  const patterns = [
    /\bquestion\s*\d+/i,
    /\bquestions\s*\d+/i,
    /\b\d{1,2}[\.\)]\s+\w+/i,
    /\(\d{1,2}\)/, // questions à compléter : "(1)", "(2)"...
    /choose the correct/i,
    /complete the/i,
    /write no more than/i,
    /answer questions/i,
    /\b[a-d][\.\)]\s+\w+/i
  ];

  return patterns.some(pattern => pattern.test(value));
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    // Filigrane / copyright et bandeaux des vidéos
    .replace(/copyright\s*:?[^\n]*/gi, '')
    .replace(/read\s+carefully/gi, '')
    .replace(/subscribe\s+for\s+more\s+videos/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Signal fort : une vraie page de questions IELTS (et pas un texte quelconque)
function hasStrongQuestionSignal(text) {
  const value = String(text || '');

  return (
    /\(\d{1,2}\)/.test(value) ||
    /questions?\s*\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}/i.test(value) ||
    /write\s+no\s+more\s+than/i.test(value) ||
    /choose\s+the\s+correct/i.test(value) ||
    /complete\s+the\s+(?:form|notes|table|sentences?|summary|flow)/i.test(value)
  );
}

async function ocrOneFrame(worker, frame) {
  try {
    const result = await worker.recognize(frame.file);

    const text = cleanOcrText(result?.data?.text || '');

    if (text.length <= 10) {
      return null;
    }

    const isQuestion = looksLikeQuestionText(text);

    if (isQuestion) {
      console.log(`📝 Question détectée vers ${formatTime(frame.timestamp)}`);
    }

    return {
      timestamp: frame.timestamp,
      timestampFormatted: formatTime(frame.timestamp),
      text,
      questionLike: isQuestion
    };
  } catch (error) {
    console.warn(`⚠️ OCR image ${frame.index} échoué:`, error.message);

    return null;
  }
}

// Lit les images avec un lecteur déjà créé ; le cache évite de relire une image
async function runOCR(frames, worker, cache = new Map()) {
  const results = [];

  for (const frame of frames) {
    if (!cache.has(frame.index)) {
      cache.set(frame.index, await ocrOneFrame(worker, frame));
    }

    const result = cache.get(frame.index);

    if (result) {
      results.push(result);
    }
  }

  return results;
}

// ============================================================
// EXTRACTION DES QUESTIONS À PARTIR DE L'OCR
// ============================================================

// "Questions 18 - 20", "Questions 01 - 05"
const GROUP_HEADER_RE = /questions?\s*\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}/i;
const GROUP_RANGE_RE = /questions?\s*(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})/i;

function isGroupHeader(line) {
  return GROUP_HEADER_RE.test(line);
}

function isInstructionLine(line) {
  return (
    /^(choose|complete|answer\s+the\s+questions?|label|match|circle)\b/i.test(line) ||
    /write\s+no\s+more\s+than/i.test(line)
  );
}

// Ligne quasi vide ou faite de caractères parasites
function isNoiseLine(line) {
  // Un choix très court comme "A) 7.15" n'est pas du bruit
  if (/^\(?[A-E]\s*[\.\)]/.test(line)) {
    return false;
  }

  return (
    line.replace(/[^A-Za-z]/g, '').length < 3 &&
    !/\(\d{1,2}\)/.test(line)
  );
}

function sectionFromNumber(number) {
  return Math.min(4, Math.max(1, Math.ceil(number / 10)));
}

// Pointillés "........" des champs à remplir, mal lus par l'OCR
// (ex. "....cccccoevecccnuruccsinrnnnnns", "cceeeeecncnnenen..")
function isLeaderGarbage(token) {
  const letters = token.replace(/[^A-Za-z]/g, '');

  if (/\.{3,}/.test(token)) {
    return true;
  }

  return (
    letters.length >= 7 &&
    /(.)\1{2,}/i.test(letters) &&
    /^[cenimrsuvoa]+$/i.test(letters)
  );
}

function cleanQuestionText(text) {
  return String(text || '')
    .replace(/copyright\s*:?[^\n]*/gi, '')
    .replace(/read\s+carefully/gi, '')
    .replace(/@/g, 'a') // "@nd" -> "and"
    .split(/\s+/)
    .filter(token => token && !isLeaderGarbage(token))
    .join(' ')
    .replace(/[\s©+*¢ª&#~^_—–-]+$/, '') // symboles parasites en fin de texte
    .trim();
}

function makeOcrQuestion(number, text, result, extras = {}) {
  const question = {
    number,
    section: sectionFromNumber(number),
    text: cleanQuestionText(text),
    choices: [],
    startTime: result.timestamp,
    startTimeFormatted: result.timestampFormatted,
    source: 'video_ocr'
  };

  if (extras.instructions) {
    question.instructions = extras.instructions;
  }

  if (extras.options && extras.options.length > 0) {
    question.options = extras.options;
  }

  if (extras.context) {
    question.context = extras.context;
  }

  return question;
}

function isValidQuestionNumber(number) {
  return Number.isInteger(number) && number >= 1 && number <= MAX_QUESTION_NUMBER;
}

// ----- Questions dont le numéro est illisible (cases numérotées en image) -----

const COMMON_TAIL_WORDS = new Set([
  'for', 'and', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'or',
  'are', 'is', 'was', 'will', 'with', 'from', 'that', 'this'
]);

const SHORT_WORDS = new Set([
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'is', 'it', 'as',
  'no', 'be', 'we', 'he', 'so', 'if', 'my', 'up', 'do', 'i', 'us', 'me', 'am'
]);

// Un "mot" plausible (et non un symbole, des pointillés ou du bruit OCR)
function isWordToken(token) {
  if (isLeaderGarbage(token)) {
    return false;
  }

  if (/^[?.,;:!]+$/.test(token)) {
    return true;
  }

  // Nombres, heures, montants : 1695, £450, 7.30, 17th
  if (/^[£$€]?\d[\d.,:/-]*[%a-z]{0,3}$/i.test(token)) {
    return true;
  }

  const bare = token.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, '');
  const letters = bare.replace(/[^A-Za-z]/g, '');

  if (!letters || letters.length !== bare.replace(/['’-]/g, '').length) {
    return false;
  }

  if (letters.length <= 2) {
    return SHORT_WORDS.has(bare.toLowerCase());
  }

  const lower = letters.replace(/[^a-z]/g, '').length;

  return lower / letters.length >= 0.5;
}

// Texte après "(n)" : ne garde que les vrais mots
// ("Anthropology pr —" -> "Anthropology", "i TUR" -> "")
function cleanTail(rawTail) {
  const tokens = String(rawTail || '')
    .replace(/@/g, 'a') // "@nd" -> "and"
    .split(/\s+/)
    .filter(Boolean)
    .filter(isWordToken);

  if (!tokens.some(token => /[A-Za-z0-9]/.test(token))) {
    return '';
  }

  if (tokens.length === 1) {
    const only = tokens[0];

    // Un seul mot minuscule court et rare : presque toujours du bruit ("occa")
    if (
      /^[a-z]{3,6}[.,]?$/.test(only) &&
      !COMMON_TAIL_WORDS.has(only.replace(/[.,]$/, ''))
    ) {
      return '';
    }

    // Une ou deux lettres seules
    if (/^[A-Za-z]{1,2}[.,]?$/.test(only)) {
      return '';
    }
  }

  return tokens.join(' ');
}

// "Occupation H = ) RE" -> "Occupation" ; "Phone number Hl |)" -> "Phone number"
function labelFromLine(line) {
  if (line.length > 80) {
    return null;
  }

  const letters = line.replace(/[^A-Za-z]/g, '');
  const upper = line.replace(/[^A-Z]/g, '');

  if (letters.length < 4) {
    return null;
  }

  // Titres en majuscules (ex. "COURSE DETAILS")
  if (upper.length / letters.length > 0.5) {
    return null;
  }

  if (/read carefully|subscribe|like\b|respect/i.test(line)) {
    return null;
  }

  const tokens = line.split(/\s+/);
  const words = [];

  for (const token of tokens) {
    if (/^[A-Z]?[a-z]{3,}$/.test(token)) {
      words.push(token);
    } else {
      break;
    }
  }

  if (words.length === 0 || !/^[A-Z]/.test(words[0])) {
    return null;
  }

  // Une vraie étiquette de formulaire est suivie du reste illisible de la case
  // numérotée ("Occupation H = ) RE") ; une phrase normale ne l'est pas.
  const rest = tokens.slice(words.length);

  if (rest.length === 0 || !rest.some(token => !isWordToken(token))) {
    return null;
  }

  return words.join(' ');
}

// Une ligne "Occupation ..." sans numéro lisible, située entre (2) et (4),
// est forcément la question 3 : on ne le fait que pour les numéros manquants.
function inferMissingFromLabels(items, hint, result, found) {
  let i = 0;
  let prevNumber = null;
  let prevQuestion = null;

  while (i < items.length) {
    const item = items[i];

    if (item.number !== undefined) {
      prevNumber = item.number;
      prevQuestion = item.question;
      i++;
      continue;
    }

    const run = [];
    let j = i;

    while (j < items.length && items[j].label !== undefined) {
      run.push(items[j]);
      j++;
    }

    const next = j < items.length ? items[j] : null;
    const nextNumber = next ? next.number : null;
    const count = run.length;

    let start = null;

    if (prevNumber !== null && nextNumber !== null) {
      if (nextNumber - prevNumber - 1 === count) {
        start = prevNumber + 1;
      }
    } else if (nextNumber !== null) {
      start = nextNumber - count;
    } else if (prevNumber !== null) {
      start = prevNumber + 1;
    }

    if (
      start !== null &&
      start >= 1 &&
      start + count - 1 <= MAX_QUESTION_NUMBER
    ) {
      let allMissing = true;

      for (let k = 0; k < count; k++) {
        if (!hint.has(start + k)) {
          allMissing = false;
        }
      }

      if (allMissing) {
        const neighbor = prevQuestion || (next && next.question) || {};

        run.forEach((entry, k) => {
          const number = start + k;

          const question = makeOcrQuestion(
            number,
            `${entry.label} (${number})`,
            result,
            {
              instructions: neighbor.instructions,
              context: neighbor.context
            }
          );

          question.inferred = true;

          found.push(question);
        });
      }
    }

    i = j;
  }
}

// Analyse le texte OCR d'UNE frame et renvoie les questions candidates
function parseFrameQuestions(result, missingHint = null) {
  const lines = result.text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const found = [];
  const items = []; // questions et étiquettes, dans l'ordre de lecture

  const recordLabel = line => {
    const label = labelFromLine(line);

    if (label) {
      items.push({ label });
    }
  };

  let instructions = '';
  let lastWasInstruction = false;
  let current = null; // question pouvant recevoir des choix A/B/C
  let allowContinuation = true; // false pour les questions "(n)" : pas de suite de texte

  let inGroup = false; // un en-tête "Questions X - Y" a été vu dans cette frame
  let groupHasQuestion = false;
  let groupOptions = []; // boîte de réponses : (A) Susan (B) Ahmed ...
  let groupContext = []; // titre / phrase d'introduction du groupe

  const extras = () => ({
    instructions,
    options: groupOptions,
    context: groupContext.join(' ').slice(0, 300)
  });

  for (const line of lines) {
    const wasInstruction = lastWasInstruction;
    lastWasInstruction = false;

    if (isNoiseLine(line)) {
      continue;
    }

    // ----- En-tête de groupe : "Questions 18 - 20 Complete the..." -----
    if (isGroupHeader(line)) {
      const rest = line.replace(GROUP_HEADER_RE, '').trim();

      instructions = isInstructionLine(rest) ? rest : '';
      lastWasInstruction = Boolean(instructions);

      current = null;
      inGroup = true;
      groupHasQuestion = false;
      groupOptions = [];
      groupContext = [];

      continue;
    }

    // ----- Consigne : "Complete the form below." -----
    if (isInstructionLine(line)) {
      instructions =
        wasInstruction && instructions ? `${instructions} ${line}` : line;

      lastWasInstruction = true;
      current = null;

      continue;
    }

    // ----- Boîte de réponses : "(A) Susan (B) Ahmed (C) Gary" -----
    const optionMatches = [
      ...line.matchAll(/\(([A-E])\)\s*([^()]+?)(?=\s*\([A-E]\)|$)/g)
    ];

    if (optionMatches.length >= 2) {
      groupOptions = optionMatches.map(match => ({
        letter: match[1],
        text: match[2].trim()
      }));

      current = null;

      continue;
    }

    // ----- Une option par ligne : "(A) This will focus on how..." -----
    const singleOption = line.match(/^\(([A-H])\)\s*(.{3,})$/);

    if (singleOption) {
      const letter = singleOption[1];

      groupOptions = groupOptions
        .filter(option => option.letter !== letter)
        .concat({ letter, text: cleanQuestionText(singleOption[2]) })
        .sort((a, b) => a.letter.localeCompare(b.letter));

      continue;
    }

    // ----- Questions à compléter : "Last name: (1)" -----
    const markers = [...line.matchAll(/\((\d{1,2})\)/g)].filter(m =>
      isValidQuestionNumber(Number(m[1]))
    );

    if (markers.length > 0) {
      let cursor = 0;
      let lastQuestion = null;

      for (const marker of markers) {
        const end = marker.index + marker[0].length;
        const segment = line.slice(cursor, end).trim();

        cursor = end;

        lastQuestion = makeOcrQuestion(
          Number(marker[1]),
          segment,
          result,
          extras()
        );

        found.push(lastQuestion);
        items.push({ number: lastQuestion.number, question: lastQuestion });
      }

      groupHasQuestion = true;

      // Texte après le dernier "(n)" : seuls les vrais mots sont gardés
      // (évite les pointillés et caractères parasites type "i TUR")
      const cleanedTail = cleanTail(line.slice(cursor));

      if (cleanedTail && lastQuestion) {
        lastQuestion.text = cleanQuestionText(
          `${lastQuestion.text} ${cleanedTail}`
        );
      }

      // Les questions "(11) What is ... ?" peuvent être suivies de choix A/B/C
      current = lastQuestion;
      allowContinuation = false;

      continue;
    }

    // ----- Questions numérotées : "11. The next event..." -----
    const numberMatch = line.match(
      /^(?:question\s*)?(\d{1,2})\s*[\.\):\-]\s*(.+)$/i
    );

    if (
      numberMatch &&
      isValidQuestionNumber(Number(numberMatch[1])) &&
      /[A-Za-z]{2,}/.test(numberMatch[2])
    ) {
      current = makeOcrQuestion(
        Number(numberMatch[1]),
        numberMatch[2],
        result,
        extras()
      );

      found.push(current);
      items.push({ number: current.number, question: current });

      groupHasQuestion = true;
      allowContinuation = true;

      continue;
    }

    // ----- Choix : "A) trade fair" -----
    if (current) {
      const choiceMatch = line.match(/^([A-D])\s*[\.\):\-]\s*(.+)$/i);

      if (choiceMatch) {
        current.choices.push({
          letter: choiceMatch[1].toUpperCase(),
          text: choiceMatch[2].trim()
        });

        continue;
      }

      // Choix sans ponctuation ("B wedding"), seulement si c'est la lettre attendue
      const looseChoice = line.match(/^([A-D])\s+(.{2,})$/);

      if (
        looseChoice &&
        looseChoice[1] === String.fromCharCode(65 + current.choices.length) &&
        (current.choices.length > 0 || /\?\s*$/.test(current.text))
      ) {
        current.choices.push({
          letter: looseChoice[1],
          text: looseChoice[2].trim()
        });

        continue;
      }

      // Suite de la question (avant les choix)
      if (
        allowContinuation &&
        current.choices.length === 0 &&
        current.text.length < 500
      ) {
        current.text = cleanQuestionText(`${current.text} ${line}`);

        continue;
      }

      recordLabel(line);

      continue;
    }

    // ----- Titre / introduction du groupe (avant la première question) -----
    if (
      inGroup &&
      !groupHasQuestion &&
      line.replace(/[^A-Za-z]/g, '').length >= 4 &&
      line.length < 200
    ) {
      groupContext.push(line);
    }

    recordLabel(line);
  }

  if (missingHint && missingHint.size > 0) {
    inferMissingFromLabels(items, missingHint, result, found);
  }

  return found;
}

// ----- Frames de corrigé (liste des réponses affichée en fin de vidéo) -----

// Compte les éléments "12." / "12)" (hors "(12)" et décimaux comme 7.15)
function analyzeNumberedItems(text) {
  const numbers = new Set();
  const re = /(?<![\(\d])(\d{1,2})\s*[\.\)](?!\d)/g;

  let totalLength = 0;
  let count = 0;

  for (const line of String(text || '').split('\n')) {
    const matches = [...line.matchAll(re)];

    matches.forEach((match, index) => {
      const number = Number(match[1]);

      if (!isValidQuestionNumber(number)) {
        return;
      }

      const from = match.index + match[0].length;
      const to =
        index + 1 < matches.length ? matches[index + 1].index : line.length;

      numbers.add(number);
      totalLength += line.slice(from, to).trim().length;
      count++;
    });
  }

  return {
    distinct: numbers.size,
    averageLength: count > 0 ? totalLength / count : 0
  };
}

// Beaucoup de numéros + textes très courts + fin de vidéo = liste de réponses
function isAnswerKeyFrame(result, maxTimestamp) {
  const { distinct, averageLength } = analyzeNumberedItems(result.text);

  if (distinct < 8 || averageLength >= 25) {
    return false;
  }

  return result.timestamp >= maxTimestamp * 0.6;
}

function collectAnswerFrames(ocrResults, maxTimestamp, limit = 3) {
  const seen = new Set();
  const frames = [];

  for (const result of ocrResults) {
    if (!isAnswerKeyFrame(result, maxTimestamp)) {
      continue;
    }

    const key = result.text.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    frames.push({
      timestamp: result.timestamp,
      timestampFormatted: result.timestampFormatted,
      text: result.text
    });

    if (frames.length >= limit) {
      break;
    }
  }

  return frames;
}

// Lit la liste des réponses affichée en fin de vidéo (2 colonnes : 1-20 et 21-40)
function parseAnswerKey(answerFrames) {
  const votes = new Map();

  const cleanAnswer = text =>
    String(text || '')
      .replace(/^[\s\W_]+|[\s\W_]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const vote = (number, answer) => {
    const value = cleanAnswer(answer);

    if (!value || value.length > 60) {
      return;
    }

    // Écarte le bruit OCR : "2", "n 3"... (on garde "A", "25", "sis", etc.)
    const alnum = value.replace(/[^A-Za-z0-9]/g, '');

    if (
      alnum.length < 3 &&
      !/^[A-E]$/.test(value) &&
      !/^\d{2}$/.test(value)
    ) {
      return;
    }

    if (!votes.has(number)) {
      votes.set(number, new Map());
    }

    const counts = votes.get(number);

    counts.set(value, (counts.get(value) || 0) + 1);
  };

  for (const frame of answerFrames) {
    const lines = frame.text
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (const line of lines) {
      for (let n = 1; n <= 20; n++) {
        // Colonne de droite : "... 22. what though"
        const rightMatch = line.match(
          new RegExp(`(?:^|\\s)${n + 20}\\s*[\\.,]\\s*(.+)$`)
        );

        let leftPart = line;

        if (rightMatch) {
          vote(n + 20, rightMatch[1]);
          leftPart = line.slice(0, rightMatch.index);
        }

        // Colonne de gauche : "2. 25" ou "3 accountant"
        const leftMatch = leftPart.match(
          new RegExp(`^\\W*${n}\\s*[\\.,]?\\s+(.+)$`)
        );

        if (leftMatch) {
          vote(n, leftMatch[1]);
        }
      }
    }
  }

  const answers = {};

  for (const [number, counts] of votes) {
    let best = null;
    let bestScore = -1;

    for (const [value, count] of counts) {
      const score =
        count * 10 +
        (/^[A-E]$/.test(value) ? 5 : 0) +
        Math.min(value.length, 20) / 100;

      if (score > bestScore) {
        bestScore = score;
        best = value;
      }
    }

    if (best) {
      answers[number] = best;
    }
  }

  return answers;
}

// Garde UNE seule version par numéro de question (la plus fiable)
function consolidateQuestions(found) {
  const byNumber = new Map();

  for (const question of found) {
    if (!question.text || question.text.length < 4) {
      continue;
    }

    if (!byNumber.has(question.number)) {
      byNumber.set(question.number, []);
    }

    byNumber.get(question.number).push(question);
  }

  const questions = [];

  for (const [, candidates] of byNumber) {
    // Regrouper les versions identiques (même texte lu sur plusieurs frames)
    const groups = new Map();

    for (const candidate of candidates) {
      const key = candidate.text.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      groups.get(key).push(candidate);
    }

    // Choisir le groupe le plus fréquent (puis le plus complet,
    // puis la lecture la plus ancienne en cas d'égalité)
    let bestGroup = null;
    let bestScore = -Infinity;

    for (const items of groups.values()) {
      const maxChoices = Math.max(...items.map(item => item.choices.length));
      const minTime = Math.min(...items.map(item => item.startTime));

      const score = items.length * 1000 + maxChoices * 50 - minTime / 10000;

      if (score > bestScore) {
        bestScore = score;
        bestGroup = items;
      }
    }

    const chosen = {
      ...bestGroup.reduce((a, b) =>
        b.choices.length > a.choices.length ? b : a
      )
    };

    chosen.startTime = Math.min(...bestGroup.map(item => item.startTime));
    chosen.startTimeFormatted = formatTime(chosen.startTime);

    // Choix manquants : les récupérer sur une autre lecture de la même question
    if (chosen.choices.length === 0) {
      const withChoices = candidates.reduce((a, b) =>
        b.choices.length > a.choices.length ? b : a
      );

      if (withChoices.choices.length > 0) {
        chosen.choices = withChoices.choices;
      }
    }

    // Consigne, boîte de réponses, introduction : première valeur trouvée
    for (const field of ['instructions', 'options', 'context']) {
      if (!chosen[field]) {
        const source = candidates.find(item => item[field]);

        if (source) {
          chosen[field] = source[field];
        }
      }
    }

    questions.push(chosen);
  }

  return questions.sort((a, b) => a.number - b.number);
}

function extractQuestionsFromOcr(ocrResults, maxTimestamp = 0) {
  const found = [];

  for (const result of ocrResults) {
    if (!result.questionLike) {
      continue;
    }

    // Les listes de réponses ne sont pas des questions
    if (isAnswerKeyFrame(result, maxTimestamp)) {
      continue;
    }

    found.push(...parseFrameQuestions(result));
  }

  const firstPass = consolidateQuestions(found);

  // Numéros non retrouvés : 2e passe qui les déduit des lignes sans numéro lisible
  const missing = new Set();

  for (let n = 1; n <= MAX_QUESTION_NUMBER; n++) {
    if (!firstPass.some(question => question.number === n)) {
      missing.add(n);
    }
  }

  if (missing.size === 0) {
    return firstPass;
  }

  const inferred = [];

  for (const result of ocrResults) {
    if (!result.questionLike) {
      continue;
    }

    if (isAnswerKeyFrame(result, maxTimestamp)) {
      continue;
    }

    inferred.push(
      ...parseFrameQuestions(result, missing).filter(question => question.inferred)
    );
  }

  return consolidateQuestions(found.concat(inferred));
}

// ============================================================
// GROUPES DE QUESTIONS (texte complet : schémas, tableaux, flow charts)
// ============================================================

// Découpe une frame en segments, un par en-tête "Questions X - Y"
function splitFrameGroups(result) {
  const lines = result.text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && !isNoiseLine(line));

  const segments = [];

  let current = null;

  for (const line of lines) {
    const match = line.match(GROUP_RANGE_RE);

    if (match) {
      const from = Number(match[1]);
      const to = Number(match[2]);

      if (isValidQuestionNumber(from) && isValidQuestionNumber(to) && from <= to) {
        current = {
          from,
          to,
          lines: [line],
          timestamp: result.timestamp
        };

        segments.push(current);

        continue;
      }
    }

    if (current) {
      current.lines.push(line);
    }
  }

  return segments.map(segment => ({
    ...segment,
    text: segment.lines.join('\n')
  }));
}

// Vidéos sans en-têtes "Questions X - Y" : une "page" par ensemble de numéros
function buildFallbackGroups(ocrResults, maxTimestamp) {
  const candidates = [];

  for (const result of ocrResults) {
    if (!result.questionLike || isAnswerKeyFrame(result, maxTimestamp)) {
      continue;
    }

    const numbers = new Set();

    for (const match of result.text.matchAll(/\((\d{1,2})\)/g)) {
      const n = Number(match[1]);

      if (isValidQuestionNumber(n)) {
        numbers.add(n);
      }
    }

    if (numbers.size > 0) {
      candidates.push({ numbers, result });
    }
  }

  // Les frames les plus complètes d'abord ; on ignore celles qui n'apportent rien
  candidates.sort(
    (a, b) =>
      b.numbers.size - a.numbers.size ||
      a.result.timestamp - b.result.timestamp
  );

  const covered = new Set();
  const groups = [];

  for (const candidate of candidates) {
    const fresh = [...candidate.numbers].filter(n => !covered.has(n));

    if (fresh.length === 0) {
      continue;
    }

    candidate.numbers.forEach(n => covered.add(n));

    const list = [...candidate.numbers].sort((a, b) => a - b);

    groups.push({
      from: list[0],
      to: list[list.length - 1],
      section: sectionFromNumber(list[0]),
      startTime: candidate.result.timestamp,
      startTimeFormatted: candidate.result.timestampFormatted,
      text: candidate.result.text
    });
  }

  return groups.sort((a, b) => a.from - b.from);
}

// Pour chaque groupe (ex. "Questions 21 - 25"), garde la meilleure lecture OCR
function buildQuestionGroups(ocrResults, maxTimestamp = 0) {
  const best = new Map();
  const firstTimes = new Map();

  for (const result of ocrResults) {
    if (!result.questionLike) {
      continue;
    }

    if (isAnswerKeyFrame(result, maxTimestamp)) {
      continue;
    }

    for (const segment of splitFrameGroups(result)) {
      const key = `${segment.from}-${segment.to}`;

      if (
        !firstTimes.has(key) ||
        segment.timestamp < firstTimes.get(key)
      ) {
        firstTimes.set(key, segment.timestamp);
      }

      // Nombre de numéros de questions du groupe retrouvés dans ce texte
      const numbers = new Set();

      for (const match of segment.text.matchAll(
        /\((\d{1,2})\)|^\s*(\d{1,2})[\.\)]/gm
      )) {
        const n = Number(match[1] || match[2]);

        if (n >= segment.from && n <= segment.to) {
          numbers.add(n);
        }
      }

      const candidate = { ...segment, score: numbers.size };
      const previous = best.get(key);

      if (!previous || candidate.score > previous.score) {
        best.set(key, candidate);
      }
    }
  }

  if (best.size === 0) {
    return buildFallbackGroups(ocrResults, maxTimestamp);
  }

  return [...best.entries()]
    .map(([key, group]) => ({
      from: group.from,
      to: group.to,
      section: sectionFromNumber(group.from),
      startTime: firstTimes.get(key),
      startTimeFormatted: formatTime(firstTimes.get(key)),
      text: group.text
    }))
    .sort((a, b) => a.from - b.from);
}

// ============================================================
// REGROUPEMENT DES FRAMES OCR
// ============================================================

function buildOcrQuestionZones(ocrResults) {
  const zones = [];

  let current = null;

  const addText = (zone, text) => {
    const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (!zone.seen.has(key)) {
      zone.seen.add(key);
      zone.texts.push(text);
    }
  };

  const closeZone = zone => {
    delete zone.seen;
    zones.push(zone);
  };

  for (const result of ocrResults) {
    if (!result.questionLike) {
      if (current) {
        current.endTime = result.timestamp;
        current.endTimeFormatted = formatTime(result.timestamp);

        closeZone(current);

        current = null;
      }

      continue;
    }

    if (!current) {
      current = {
        startTime: result.timestamp,
        startTimeFormatted: result.timestampFormatted,
        endTime: result.timestamp,
        endTimeFormatted: result.timestampFormatted,
        texts: [],
        seen: new Set()
      };
    }

    current.endTime = result.timestamp;
    current.endTimeFormatted = result.timestampFormatted;

    // Un même texte lu sur plusieurs frames n'est gardé qu'une fois
    addText(current, result.text);
  }

  if (current) {
    closeZone(current);
  }

  return zones;
}

// Textes OCR "question" sans doublons (on garde la 1re apparition)
function buildUniqueOcrMatches(ocrResults) {
  const seen = new Set();
  const matches = [];

  for (const item of ocrResults) {
    if (!item.questionLike) {
      continue;
    }

    const key = item.text.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    matches.push({
      timestamp: item.timestamp,
      timestampFormatted: item.timestampFormatted,
      text: item.text
    });
  }

  return matches;
}

// ============================================================
// ANALYSE OCR D'UNE VIDEO
// ============================================================

// ============================================================
// LECTURE DES PAGES PAR CLAUDE (VISION)
// ============================================================

function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && CLAUDE_MODE !== 'off';
}

function newClaudeUsage() {
  return { models: [], requests: 0, images: 0, inputTokens: 0, outputTokens: 0 };
}

const CLAUDE_READ_SYSTEM = [
  'You read screenshots taken from YouTube videos of IELTS Listening practice tests (40 questions numbered 1 to 40, in 4 sections).',
  'Each image is labelled "Image N". For each image decide what it shows and transcribe it exactly as printed:',
  '- "questions": a page of test questions;',
  '- "answers": the answer key (list of correct answers);',
  '- "other": anything else (title card, presenter, ads, transcript...).',
  '',
  'Rules:',
  '- Transcribe only what is clearly legible. Never guess and never invent. If a question or an answer is cut off or unreadable, leave it out.',
  '- Keep the printed wording and spelling, even if it looks wrong. Ignore watermarks, timers, subtitles, logos and banners such as "Read Carefully" or "Subscribe".',
  '- "number" is the printed question number (1 to 40).',
  '- Sentence, note, table or form completion: put the printed line in "text" and write the blank as (n), n being the question number, for example "Last name: (1)".',
  '- Multiple choice: "text" is the question without its number, and "choices" lists every option as {"letter":"A","text":"..."}.',
  '- Matching or "choose from the box": put the shared options in "options" (same format as choices) on EVERY question of the group, and the item in "text".',
  '- "instructions": the printed instruction of the group (for example "Complete the notes below. Write NO MORE THAN TWO WORDS."). "context": the title or introduction line of the group. Use an empty string when absent.',
  '- Diagrams, maps and flow charts: describe each blank in "text" using the printed labels around it.',
  '- Answer pages: list every printed number with its answer text, in "answers".',
  '',
  'Reply with ONE JSON object and nothing else, in this shape:',
  '{"pages":[{"image":1,"kind":"questions","questions":[{"number":1,"text":"Last name: (1)","choices":[],"options":[],"instructions":"","context":""}],"answers":[]},{"image":2,"kind":"answers","questions":[],"answers":[{"number":1,"answer":"Wright"}]}]}'
].join('\n');

const CLAUDE_CHECK_SYSTEM = [
  'You look at screenshots taken from a YouTube video.',
  'Decide whether at least one image shows a page of IELTS Listening test questions or an answer key (numbered questions with blanks or choices, or a list of numbered answers).',
  'Reply with ONE JSON object and nothing else: {"questionPages": true} or {"questionPages": false}.'
].join('\n');

async function callClaude({ model, system, content, maxTokens }, usage) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(
        ANTHROPIC_URL,
        {
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }]
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          timeout: 180000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );

      const data = response.data || {};

      usage.requests++;

      if (!usage.models.includes(model)) {
        usage.models.push(model);
      }

      if (data.usage) {
        usage.inputTokens += data.usage.input_tokens || 0;
        usage.outputTokens += data.usage.output_tokens || 0;
      }

      return (data.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    } catch (error) {
      lastError = error;

      const status = error.response && error.response.status;

      // Surcharge ou erreur passagère : on réessaie ; sinon (clé invalide...) on arrête
      if (status === 429 || status === 529 || (status >= 500 && status < 600) || !status) {
        await new Promise(resolve => setTimeout(resolve, attempt * 2500));
        continue;
      }

      break;
    }
  }

  const detail =
    (lastError.response && lastError.response.data && lastError.response.data.error &&
      lastError.response.data.error.message) ||
    lastError.message;

  throw new Error(`Claude : ${String(detail).slice(0, 200)}`);
}

function parseJsonObject(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');

  if (start === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function imageBlocks(frames, usage) {
  const content = [];

  for (let i = 0; i < frames.length; i++) {
    const data = (await fsp.readFile(frames[i].file)).toString('base64');

    content.push({ type: 'text', text: `Image ${i + 1}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data }
    });

    usage.images++;
  }

  return content;
}

// Quelques images réparties sur la vidéo : y a-t-il des pages de questions ?
async function claudeScreenCheck(frames, usage) {
  if (frames.length === 0) {
    return false;
  }

  const content = await imageBlocks(frames, usage);

  content.push({ type: 'text', text: 'Do these images show IELTS Listening question pages or an answer key? JSON only.' });

  const text = await callClaude(
    { model: CLAUDE_CHECK_MODEL, system: CLAUDE_CHECK_SYSTEM, content, maxTokens: 100 },
    usage
  );

  const parsed = parseJsonObject(text);

  return Boolean(parsed && parsed.questionPages === true);
}

// Choix des images à envoyer : le milieu de chaque page affichée.
//   "blind"   : l'OCR ne lit rien -> pages réparties sur toute la vidéo
//   "wide"    : l'OCR a raté beaucoup de questions -> pages repérées par l'OCR d'abord,
//               puis les autres pages (l'OCR peut être aveugle aux petits textes)
//   "flagged" : l'OCR a lu presque tout -> seulement les pages repérées (pour les corriger)
function chooseClaudeFrames(frames, runs, cache, maxTimestamp, mode) {
  const all = runs.map(([first, last]) => ({
    length: last - first + 1,
    frame: frames[Math.round((first + last) / 2)]
  }));

  const stable = all.filter(item => item.length >= 2);
  const pool = stable.length > 0 ? stable : all;

  let picked;

  if (mode === 'blind') {
    picked = evenlySpaced(pool.map(item => item.frame), CLAUDE_MAX_IMAGES);
  } else {
    const scored = pool.map(item => {
      const result = cache.get(item.frame.index);

      let score = 1;

      if (result) {
        if (hasStrongQuestionSignal(result.text) || isAnswerKeyFrame(result, maxTimestamp)) {
          score = 3;
        } else if (result.questionLike) {
          score = 2;
        }
      }

      return { ...item, score };
    });

    const relevant = scored.filter(item => item.score >= 2);

    const candidates =
      mode === 'wide' || relevant.length === 0 ? scored : relevant;

    picked = candidates
      .sort((a, b) => b.score - a.score || b.length - a.length)
      .slice(0, CLAUDE_MAX_IMAGES)
      .map(item => item.frame);
  }

  return picked.sort((a, b) => a.timestamp - b.timestamp);
}

// Lit les images par lots ; renvoie la liste des pages reconnues par Claude
async function claudeReadPages(frames, usage, progress) {
  const pages = [];

  for (let i = 0; i < frames.length; i += CLAUDE_BATCH_SIZE) {
    const batch = frames.slice(i, i + CLAUDE_BATCH_SIZE);

    progress(
      `lecture des pages par Claude (${Math.min(i + batch.length, frames.length)}/${frames.length})…`
    );

    const content = await imageBlocks(batch, usage);

    content.push({
      type: 'text',
      text: `Transcribe these ${batch.length} image(s) following the rules. JSON only.`
    });

    let parsed = null;

    // Une seconde tentative si la réponse n'est pas du JSON valide
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      const text = await callClaude(
        { model: CLAUDE_READ_MODEL, system: CLAUDE_READ_SYSTEM, content, maxTokens: 12000 },
        usage
      );

      parsed = parseJsonObject(text);
    }

    if (!parsed || !Array.isArray(parsed.pages)) {
      continue;
    }

    for (const page of parsed.pages) {
      const frame = batch[Number(page.image) - 1];

      if (frame) {
        pages.push({ ...page, timestamp: frame.timestamp });
      }
    }
  }

  return pages;
}

function plainText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLetterList(list) {
  return (Array.isArray(list) ? list : [])
    .map(item => ({
      letter: plainText(item && item.letter).toUpperCase(),
      text: plainText(item && item.text)
    }))
    .filter(item => /^[A-H]$/.test(item.letter) && item.text);
}

// Fusionne la lecture de Claude et celle de l'OCR : pour chaque numéro on garde
// Claude s'il a lu la question, sinon l'OCR.
function mergeWithClaude(ocrQuestions, ocrAnswers, pages) {
  const candidates = new Map(); // numéro -> meilleure lecture de Claude
  const answerVotes = new Map(); // numéro -> réponse -> nombre de pages

  for (const page of pages) {
    for (const item of Array.isArray(page.questions) ? page.questions : []) {
      const number = Number(item && item.number);
      const text = plainText(item && item.text);

      if (!isValidQuestionNumber(number) || text.length < 2) {
        continue;
      }

      const choices = cleanLetterList(item.choices);
      const options = cleanLetterList(item.options);

      const score = choices.length * 50 + options.length * 10 + Math.min(text.length, 300) / 10;

      const existing = candidates.get(number);

      if (!existing || score > existing.score) {
        candidates.set(number, {
          score,
          firstTime: existing ? Math.min(existing.firstTime, page.timestamp) : page.timestamp,
          number,
          text,
          choices,
          options,
          instructions: plainText(item.instructions),
          context: plainText(item.context)
        });
      } else {
        existing.firstTime = Math.min(existing.firstTime, page.timestamp);
      }
    }

    for (const item of Array.isArray(page.answers) ? page.answers : []) {
      const number = Number(item && item.number);
      const answer = plainText(item && item.answer);

      if (!isValidQuestionNumber(number) || !answer || answer.length > 80) {
        continue;
      }

      if (!answerVotes.has(number)) {
        answerVotes.set(number, new Map());
      }

      const votes = answerVotes.get(number);

      votes.set(answer, (votes.get(answer) || 0) + 1);
    }
  }

  const answers = { ...ocrAnswers };
  let claudeAnswers = 0;

  for (const [number, votes] of answerVotes) {
    let best = null;
    let bestCount = 0;

    for (const [answer, count] of votes) {
      if (count > bestCount) {
        best = answer;
        bestCount = count;
      }
    }

    if (best) {
      answers[number] = best;
      claudeAnswers++;
    }
  }

  const ocrByNumber = new Map(ocrQuestions.map(question => [question.number, question]));

  const questions = [];

  for (let number = 1; number <= MAX_QUESTION_NUMBER; number++) {
    const fromClaude = candidates.get(number);
    const fromOcr = ocrByNumber.get(number);

    if (fromClaude) {
      const question = {
        number,
        section: sectionFromNumber(number),
        text: fromClaude.text,
        choices: fromClaude.choices,
        startTime: fromClaude.firstTime,
        startTimeFormatted: formatTime(fromClaude.firstTime),
        source: 'claude_vision'
      };

      // Question à compléter ou ouverte (sans choix) : on garde un emplacement de réponse "(n)"
      if (question.choices.length === 0 && !/\(\d{1,2}\)/.test(question.text)) {
        question.text = `${question.text} (${number})`;
      }

      if (fromClaude.options.length > 0) question.options = fromClaude.options;
      if (fromClaude.instructions) question.instructions = fromClaude.instructions;
      if (fromClaude.context) question.context = fromClaude.context;

      questions.push(question);
    } else if (fromOcr) {
      questions.push({ ...fromOcr });
    }
  }

  for (const question of questions) {
    if (answers[question.number]) {
      question.answer = answers[question.number];
    } else {
      delete question.answer;
    }
  }

  return {
    questions,
    answers,
    claudeQuestions: candidates.size,
    claudeAnswers
  };
}

// Résultat "vide" qui explique pourquoi la vidéo n'a pas pu être lue
function emptyOcrResult(video, reason, diagnostics) {
  return {
    ...video,

    verified: false,
    extractionMethod: 'video_ocr',
    questionCount: 0,
    questions: [],
    missingNumbers: Array.from({ length: MAX_QUESTION_NUMBER }, (_, i) => i + 1),
    answers: {},
    groups: [],
    rejected: reason,
    diagnostics
  };
}

async function analyzeVideoWithOCR(video, options = {}) {
  const debug = Boolean(options.debug);

  const progress =
    typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const tempDir = await createTempDir();

  const videoPath = path.join(tempDir, 'video.mp4');
  const framesDir = path.join(tempDir, 'frames');

  try {
    console.log(`\n🔬 ANALYSE OCR IELTS: ${video.videoId}`);

    progress('téléchargement de la vidéo…');

    await downloadYoutubeVideo(video.videoId, videoPath);

    progress('extraction des images…');

    // Images prises sur toute la durée réelle de la vidéo
    const duration = (await probeDuration(videoPath)) || video.durationSeconds || 0;
    const interval = chooseInterval(duration);

    const { frames, signatures } = await extractFrames(videoPath, framesDir, interval);

    const runs = findRuns(frames, signatures);
    const chosen = selectFramesForOcr(frames, signatures);

    const maxTimestamp =
      frames.length > 0 ? frames[frames.length - 1].timestamp : 0;

    const diagnostics = {
      durationSeconds: Math.round(duration),
      intervalSeconds: interval,
      framesSampled: frames.length,
      framesRead: chosen.length,
      coveredSeconds: maxTimestamp,
      probeHits: 0,
      framesWithQuestions: 0
    };

    console.log(
      `🔎 ${chosen.length} image(s) à lire sur ${frames.length} ` +
        `(les images identiques sont ignorées)`
    );

    const usage = newClaudeUsage();

    const cache = new Map();
    const worker = await createWorker('eng');

    let ocrResults;
    let blindOcr = false; // l'OCR ne voit rien mais Claude voit des questions

    try {
      progress('lecture des images (OCR)…');

      // 1) Sondage : quelques images réparties sur toute la vidéo
      const probe = await runOCR(evenlySpaced(chosen, OCR_PROBE_FRAMES), worker, cache);

      diagnostics.probeHits = probe.filter(item =>
        hasStrongQuestionSignal(item.text)
      ).length;

      if (diagnostics.probeHits === 0) {
        // L'OCR ne voit aucune page de questions : si Claude est disponible,
        // il vérifie sur quelques images (l'OCR est parfois aveugle aux petits textes).
        let claudeSees = false;

        if (claudeEnabled()) {
          try {
            progress('vérification par Claude…');

            claudeSees = await claudeScreenCheck(
              evenlySpaced(
                runs
                  .filter(([first, last]) => last - first + 1 >= 2)
                  .map(([first, last]) => frames[Math.round((first + last) / 2)]),
                CLAUDE_CHECK_IMAGES
              ),
              usage
            );
          } catch (error) {
            console.warn('⚠️ Vérification Claude impossible :', error.message);
            diagnostics.claude = { ...usage, error: error.message.slice(0, 200) };
          }
        }

        if (!claudeSees) {
          console.log('❌ Aucune page de questions repérée : vidéo abandonnée');

          if (usage.requests > 0) {
            diagnostics.claude = { ...usage };
          }

          return emptyOcrResult(video, 'no_questions_on_screen', diagnostics);
        }

        console.log('👁️ Claude voit des pages de questions que l’OCR ne lit pas');

        blindOcr = true;
        ocrResults = probe;
      } else {
        // 2) Lecture complète
        ocrResults = await runOCR(chosen, worker, cache);
      }
    } finally {
      await worker.terminate();
    }

    diagnostics.framesWithQuestions = ocrResults.filter(
      item => item.questionLike
    ).length;

    const ocrQuestions = extractQuestionsFromOcr(ocrResults, maxTimestamp);

    const groups = buildQuestionGroups(ocrResults, maxTimestamp);

    const answerFrames = collectAnswerFrames(ocrResults, maxTimestamp, 12);

    const ocrAnswers = parseAnswerKey(answerFrames);

    let validQuestions = ocrQuestions.filter(
      question => question.text && question.text.length >= 4
    );

    for (const question of validQuestions) {
      if (ocrAnswers[question.number]) {
        question.answer = ocrAnswers[question.number];
      }
    }

    let answers = ocrAnswers;

    // ----- Lecture par Claude : seulement si l'OCR est incomplet (ou mode "always") -----
    const incomplete =
      validQuestions.length < MAX_QUESTION_NUMBER ||
      Object.keys(ocrAnswers).length < MAX_QUESTION_NUMBER;

    if (claudeEnabled() && (blindOcr || CLAUDE_MODE === 'always' || incomplete)) {
      try {
        const targets = chooseClaudeFrames(
          frames,
          runs,
          cache,
          maxTimestamp,
          blindOcr
            ? 'blind'
            : validQuestions.length < MAX_QUESTION_NUMBER - 4
              ? 'wide'
              : 'flagged'
        );

        console.log(`🤖 Lecture par Claude : ${targets.length} image(s)`);

        const pages = await claudeReadPages(targets, usage, progress);

        const merged = mergeWithClaude(validQuestions, ocrAnswers, pages);

        validQuestions = merged.questions;
        answers = merged.answers;

        diagnostics.claude = {
          ...usage,
          questionsRead: merged.claudeQuestions,
          answersRead: merged.claudeAnswers
        };

        console.log(
          `🤖 Claude : ${merged.claudeQuestions} question(s), ${merged.claudeAnswers} réponse(s) ` +
            `(${usage.inputTokens} + ${usage.outputTokens} tokens)`
        );
      } catch (error) {
        // L'OCR reste le secours : on garde son résultat
        console.warn('⚠️ Lecture par Claude impossible :', error.message);

        diagnostics.claude = { ...usage, error: error.message.slice(0, 200) };
      }
    }

    if (validQuestions.length === 0) {
      console.log('❌ Aucune question IELTS détectée');

      return emptyOcrResult(video, 'no_questions_detected', diagnostics);
    }

    console.log(`✅ ${validQuestions.length} question(s) détectée(s)`);

    // Numéros de 1 à 40 non retrouvés
    const foundNumbers = new Set(validQuestions.map(question => question.number));

    const missingNumbers = [];

    for (let n = 1; n <= MAX_QUESTION_NUMBER; n++) {
      if (!foundNumbers.has(n)) {
        missingNumbers.push(n);
      }
    }

    const usedClaude = validQuestions.some(question => question.source === 'claude_vision');

    const response = {
      ...video,

      verified: true,
      extractionMethod: usedClaude ? 'claude_vision' : 'video_ocr',
      questionCount: validQuestions.length,
      questions: validQuestions,
      missingNumbers,
      answers,
      groups,
      diagnostics,
      answerFrames: answerFrames.slice(0, 2)
    };

    // Données brutes volumineuses : seulement en mode debug (?debug=1)
    if (debug) {
      response.questionZones = buildOcrQuestionZones(ocrResults);
      response.ocrMatches = buildUniqueOcrMatches(ocrResults);
    }

    return response;
  } finally {
    // Nettoyage systématique
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });

      console.log('🧹 Fichiers temporaires supprimés');
    } catch (cleanupError) {
      console.warn('⚠️ Nettoyage impossible:', cleanupError.message);
    }
  }
}

// ============================================================
// ANALYSE TRANSCRIPT + OCR
// ============================================================

async function analyzeListeningVideo(video, options = {}) {
  // ----------------------------------------------------------
  // 1. Essai transcript
  // ----------------------------------------------------------

  const transcript = await getTranscript(video.videoId);

  const transcriptText = normalizeText(transcript.text);

  console.log(
    `🎧 Transcript ${video.videoId}: ${transcriptText.length} caractères`
  );

  if (transcriptText.length >= 50 && transcript.segments.length > 0) {
    const markerInfo = hasQuestionMarkers(transcriptText);

    const questionZones = findQuestionSegments(transcript.segments);

    if (markerInfo.found && questionZones.length > 0) {
      console.log('✅ Questions détectées dans le transcript');

      return {
        ...video,

        verified: true,
        extractionMethod: 'transcript',
        questionCount: questionZones.length,

        questions: questionZones.map((zone, index) => ({
          number: index + 1,
          text: zone.text,
          choices: [],
          startTime: zone.start,
          endTime: zone.end,
          startTimeFormatted: formatTime(zone.start),
          endTimeFormatted: formatTime(zone.end),
          source: 'transcript'
        })),

        questionZones,
        transcript: transcriptText
      };
    }
  }

  // ----------------------------------------------------------
  // 2. Transcript inutilisable -> OCR
  // ----------------------------------------------------------

  console.log('📺 Transcript inutilisable ou sans questions.');
  console.log('🔎 Passage à l’analyse OCR de la vidéo...');

  return await analyzeVideoWithOCR(video, options);
}

// ============================================================
// GET /api/youtube/ielts
// ============================================================

router.get('/ielts', async (req, res) => {
  try {
    const maxResults = Math.min(Number(req.query.limit || 5), 10);

    console.log('\n========================================');
    console.log('🔎 RECHERCHE IELTS LISTENING');
    console.log('========================================');

    const allItems = [];

    for (const query of LISTENING_QUERIES) {
      try {
        console.log(`🔍 ${query}`);

        const items = await searchYouTube(query);

        allItems.push(...items);
      } catch (error) {
        console.warn(`⚠️ Recherche échouée "${query}":`, error.message);
      }
    }

    // Déduplication
    const uniqueMap = new Map();

    for (const item of allItems) {
      if (item.id?.videoId) {
        uniqueMap.set(item.id.videoId, item);
      }
    }

    const uniqueItems = [...uniqueMap.values()];

    const details = await getVideoDetails(
      uniqueItems.map(item => item.id.videoId)
    );

    let candidates = processVideos(details);

    candidates = candidates.sort((a, b) => b.quality - a.quality);

    // ------------------------------------------------------
    // Vérification réelle
    // ------------------------------------------------------

    const verifiedVideos = [];

    for (const video of candidates) {
      if (verifiedVideos.length >= maxResults) {
        break;
      }

      try {
        const analyzed = await analyzeListeningVideo(video);

        if (analyzed && analyzed.questions && analyzed.questions.length > 0) {
          verifiedVideos.push(analyzed);
        }
      } catch (error) {
        console.warn(`⚠️ Vidéo ${video.videoId} rejetée:`, error.message);
      }
    }

    return res.json({
      ok: true,
      skill: 'listening',
      count: verifiedVideos.length,
      videos: verifiedVideos
    });
  } catch (error) {
    console.error('❌ ERREUR /ielts:', error.response?.data || error.message);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Erreur serveur'
    });
  }
});

// ============================================================
// TEST DIRECT D'UNE VIDEO
// ============================================================

router.get('/ielts/test-video', async (req, res) => {
  try {
    const videoId = getVideoIdFromUrl(req.query.videoId);

    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error: 'videoId ou URL YouTube invalide'
      });
    }

    console.log(`\n🎯 TEST DIRECT VIDEO: ${videoId}`);

    const details = await getVideoDetails([videoId]);

    if (!details || details.length === 0) {
      return res.status(404).json({
        ok: false,
        videoId,
        error: 'Vidéo YouTube introuvable'
      });
    }

    const video = buildVideoObject(details[0]);

    video.quality = 100;

    const result = await analyzeListeningVideo(video, {
      debug: req.query.debug === '1'
    });

    if (!result || !result.questions || result.questions.length === 0) {
      return res.json({
        ok: false,
        videoId,
        title: video.title,
        error:
          'La vidéo ne contient pas de questions IELTS Listening exploitables'
      });
    }

    return res.json({
      ok: true,
      video: result
    });
  } catch (error) {
    console.error('\n❌ ERREUR TEST IELTS:', error.response?.data || error.message);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Erreur serveur'
    });
  }
});

// ============================================================
// TEST TRANSCRIPT UNIQUEMENT
// ============================================================

router.get('/ielts/test-transcript', async (req, res) => {
  try {
    const videoId = getVideoIdFromUrl(req.query.videoId);

    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error: 'videoId ou URL YouTube invalide'
      });
    }

    const transcript = await getTranscript(videoId);

    const markerInfo = hasQuestionMarkers(transcript.text);

    const questionZones = findQuestionSegments(transcript.segments);

    return res.json({
      ok: true,
      videoId,
      status: transcript.status,
      language: transcript.language,
      textLength: transcript.text.length,
      segmentCount: transcript.segments.length,
      questionMarkers: markerInfo,
      questionZones,
      transcript: transcript.text,
      segments: transcript.segments
    });
  } catch (error) {
    console.error('❌ ERREUR TEST TRANSCRIPT:', error.message);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Erreur serveur'
    });
  }
});

// ============================================================
// TEST OCR UNIQUEMENT
// ============================================================

router.get('/ielts/test-ocr', async (req, res) => {
  try {
    const videoId = getVideoIdFromUrl(req.query.videoId);

    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error: 'videoId ou URL YouTube invalide'
      });
    }

    const details = await getVideoDetails([videoId]);

    if (!details || details.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Vidéo YouTube introuvable'
      });
    }

    const video = buildVideoObject(details[0]);

    const result = await analyzeVideoWithOCR(video, {
      debug: req.query.debug === '1'
    });

    if (!result || !result.questions || result.questions.length === 0) {
      return res.json({
        ok: false,
        videoId,
        title: video.title,
        error: 'Aucune question IELTS détectée par OCR',
        reason: result ? result.rejected : undefined,
        diagnostics: result ? result.diagnostics : undefined
      });
    }

    const body = {
      ok: true,
      videoId,
      title: video.title,
      extractionMethod: result.extractionMethod,
      questionCount: result.questionCount,
      questions: result.questions,
      missingNumbers: result.missingNumbers,
      answers: result.answers,
      groups: result.groups,
      diagnostics: result.diagnostics,
      answerFrames: result.answerFrames
    };

    // ?debug=1 : ajoute les textes OCR bruts
    if (req.query.debug === '1') {
      body.questionZones = result.questionZones;
      body.ocrMatches = result.ocrMatches;
    }

    return res.json(body);
  } catch (error) {
    console.error('❌ ERREUR TEST OCR:', error.message);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Erreur OCR'
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;

// Fonctions réutilisées par la bibliothèque (routes/ieltsLibrary.js)
module.exports.helpers = {
  YOUTUBE_API_URL,
  LISTENING_QUERIES,
  getVideoDetails,
  buildVideoObject,
  processVideos,
  getVideoIdFromUrl,
  analyzeVideoWithOCR
};
