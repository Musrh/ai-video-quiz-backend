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
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// OCR
const OCR_INTERVAL_SECONDS = Number(process.env.IELTS_OCR_INTERVAL || 8);
const OCR_MAX_FRAMES = Number(process.env.IELTS_OCR_MAX_FRAMES || 180);

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

    // Format tolérant, limité à 720p (suffisant pour l'OCR)
    format:
      'best[height<=720][ext=mp4]/bv*[height<=720]+ba/best[height<=720]/best',

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

async function extractFrames(videoPath, framesDir) {
  await fsp.mkdir(framesDir, { recursive: true });

  const outputPattern = path.join(framesDir, 'frame-%05d.jpg');

  console.log(`🎞️ Extraction des frames toutes les ${OCR_INTERVAL_SECONDS}s...`);

  await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',

      '-i',
      videoPath,

      '-vf',
      `fps=1/${OCR_INTERVAL_SECONDS},scale=1280:-2`,

      '-q:v',
      '3',

      '-frames:v',
      String(OCR_MAX_FRAMES),

      outputPattern
    ],
    {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const files = (await fsp.readdir(framesDir))
    .filter(file => file.endsWith('.jpg'))
    .sort();

  console.log(`🖼️ ${files.length} frames extraites`);

  return files.map((file, index) => ({
    file: path.join(framesDir, file),
    index,
    timestamp: index * OCR_INTERVAL_SECONDS
  }));
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
    // Filigrane / copyright des vidéos
    .replace(/copyright\s*:?[^\n]*/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function runOCR(frames) {
  if (!frames || frames.length === 0) {
    return [];
  }

  console.log(`🔎 OCR de ${frames.length} frames...`);

  const worker = await createWorker('eng');

  const results = [];

  try {
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      try {
        const result = await worker.recognize(frame.file);

        const text = cleanOcrText(result?.data?.text || '');

        if (text.length > 10) {
          const isQuestion = looksLikeQuestionText(text);

          if (isQuestion) {
            console.log(`📝 Question détectée vers ${formatTime(frame.timestamp)}`);
          }

          results.push({
            timestamp: frame.timestamp,
            timestampFormatted: formatTime(frame.timestamp),
            text,
            questionLike: isQuestion
          });
        }
      } catch (error) {
        console.warn(`⚠️ OCR frame ${i} échoué:`, error.message);
      }
    }

    return results;
  } finally {
    await worker.terminate();
  }
}

// ============================================================
// EXTRACTION DES QUESTIONS À PARTIR DE L'OCR
// ============================================================

// "Questions 18 - 20", "Questions 01 - 05"
const GROUP_HEADER_RE = /questions?\s*\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}/i;

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
  return line.replace(/[^A-Za-z]/g, '').length < 3 && !/\(\d{1,2}\)/.test(line);
}

function sectionFromNumber(number) {
  return Math.min(4, Math.max(1, Math.ceil(number / 10)));
}

function cleanQuestionText(text) {
  return String(text || '')
    .replace(/copyright\s*:?[^\n]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeOcrQuestion(number, text, result, instructions) {
  const question = {
    number,
    section: sectionFromNumber(number),
    text: cleanQuestionText(text),
    choices: [],
    startTime: result.timestamp,
    startTimeFormatted: result.timestampFormatted,
    source: 'video_ocr'
  };

  if (instructions) {
    question.instructions = instructions;
  }

  return question;
}

function isValidQuestionNumber(number) {
  return Number.isInteger(number) && number >= 1 && number <= MAX_QUESTION_NUMBER;
}

// Analyse le texte OCR d'UNE frame et renvoie les questions candidates
function parseFrameQuestions(result) {
  const lines = result.text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const found = [];

  let instructions = '';
  let lastWasInstruction = false;
  let current = null; // question numérotée pouvant recevoir des choix A/B/C

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
          instructions
        );

        found.push(lastQuestion);
      }

      const tail = line.slice(cursor).trim();

      if (
        tail &&
        lastQuestion &&
        tail.replace(/[^A-Za-z0-9]/g, '').length >= 2
      ) {
        lastQuestion.text = cleanQuestionText(`${lastQuestion.text} ${tail}`);
      }

      current = null;

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
        instructions
      );

      found.push(current);

      continue;
    }

    // ----- Choix : "A. trade fair" -----
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
        current.choices.length > 0 &&
        looseChoice[1] === String.fromCharCode(65 + current.choices.length)
      ) {
        current.choices.push({
          letter: looseChoice[1],
          text: looseChoice[2].trim()
        });

        continue;
      }

      // Suite de la question (avant les choix)
      if (current.choices.length === 0 && current.text.length < 500) {
        current.text = cleanQuestionText(`${current.text} ${line}`);
      }
    }
  }

  return found;
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

    // Choisir le groupe le plus fréquent (puis le plus complet)
    let bestGroup = null;
    let bestScore = -1;

    for (const items of groups.values()) {
      const maxChoices = Math.max(...items.map(item => item.choices.length));

      const score =
        items.length * 1000 +
        maxChoices * 50 +
        Math.min(items[0].text.length, 200);

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

    // Consigne manquante : prendre la première trouvée
    if (!chosen.instructions) {
      const withInstructions = candidates.find(item => item.instructions);

      if (withInstructions) {
        chosen.instructions = withInstructions.instructions;
      }
    }

    questions.push(chosen);
  }

  return questions.sort((a, b) => a.number - b.number);
}

function extractQuestionsFromOcr(ocrResults) {
  const found = [];

  for (const result of ocrResults) {
    if (!result.questionLike) {
      continue;
    }

    found.push(...parseFrameQuestions(result));
  }

  return consolidateQuestions(found);
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

async function analyzeVideoWithOCR(video) {
  const tempDir = await createTempDir();

  const videoPath = path.join(tempDir, 'video.mp4');
  const framesDir = path.join(tempDir, 'frames');

  try {
    console.log(`\n🔬 ANALYSE OCR IELTS: ${video.videoId}`);

    await downloadYoutubeVideo(video.videoId, videoPath);

    const frames = await extractFrames(videoPath, framesDir);

    const ocrResults = await runOCR(frames);

    const questionZones = buildOcrQuestionZones(ocrResults);

    const questions = extractQuestionsFromOcr(ocrResults);

    const validQuestions = questions.filter(
      question => question.text && question.text.length >= 4
    );

    if (validQuestions.length === 0) {
      console.log('❌ Aucune question IELTS détectée par OCR');

      return null;
    }

    console.log(`✅ ${validQuestions.length} question(s) détectée(s) par OCR`);

    return {
      ...video,

      verified: true,
      extractionMethod: 'video_ocr',
      questionCount: validQuestions.length,
      questions: validQuestions,
      questionZones,
      ocrMatches: buildUniqueOcrMatches(ocrResults)
    };
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

async function analyzeListeningVideo(video) {
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

  return await analyzeVideoWithOCR(video);
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

    const result = await analyzeListeningVideo(video);

    if (!result) {
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

    const result = await analyzeVideoWithOCR(video);

    if (!result) {
      return res.json({
        ok: false,
        videoId,
        title: video.title,
        error: 'Aucune question IELTS détectée par OCR'
      });
    }

    return res.json({
      ok: true,
      videoId,
      title: video.title,
      extractionMethod: result.extractionMethod,
      questionCount: result.questionCount,
      questions: result.questions,
      questionZones: result.questionZones,
      ocrMatches: result.ocrMatches
    });
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
