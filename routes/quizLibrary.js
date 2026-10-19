// ============================================================
// BIBLIOTHÈQUE DE QUIZ VALIDÉS
// ============================================================
// Objectif : économiser les appels API (YouTube, transcription, Claude).
//
// - Chaque quiz généré en direct est gardé « à valider » (les questions sont déjà payées).
// - L'administrateur le teste puis l'approuve ou le refuse dans /admin.
// - Un quiz approuvé est ensuite servi à tous les élèves SANS aucun appel API.
// - Chaque élève ne revoit jamais une vidéo qu'il a déjà vue (voir « seen » dans rewards.js).
//
// Fichier de sauvegarde : quiz-library.json, dans le Volume (comme les soldes).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR =
  process.env.REWARDS_DATA_DIR ||
  process.env.IELTS_DATA_DIR ||
  (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));

const DATA_FILE = path.join(DATA_DIR, 'quiz-library.json');

// Nombre maximum de quiz « à valider » gardés (évite que le fichier grossisse sans fin)
const MAX_PENDING = Number(process.env.QUIZ_LIBRARY_MAX_PENDING || 500);

const LANGUAGES = ['fr', 'en', 'ar'];

let state = { videos: {}, served: 0 };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

      state = { videos: raw.videos || {}, served: raw.served || 0 };
    }

    const counts = countByStatus();

    console.log(
      `🎞️ Bibliothèque de quiz : ${counts.approved} approuvé(s), ${counts.pending} à valider, ` +
        `${counts.rejected} refusé(s) (fichier ${DATA_FILE})`
    );
  } catch (error) {
    console.error('❌ Lecture de la bibliothèque de quiz impossible :', error.message);
  }
}

let saving = Promise.resolve();

function saveNow() {
  saving = saving
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });

      const tmp = `${DATA_FILE}.tmp`;

      await fsp.writeFile(tmp, JSON.stringify(state));
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch(error => {
      console.error('❌ Sauvegarde de la bibliothèque de quiz impossible :', error.message);
    });

  return saving;
}

// Les compteurs d'usage ne méritent pas une écriture à chaque quiz : on les regroupe
let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 3000);

  if (saveTimer.unref) saveTimer.unref();
}

load();

// ------------------------------------------------------------
// Outils
// ------------------------------------------------------------

function makeId(language, videoId) {
  return `${language}:${videoId}`;
}

function countByStatus() {
  const counts = { approved: 0, pending: 0, rejected: 0 };

  Object.values(state.videos).forEach(record => {
    if (counts[record.status] !== undefined) counts[record.status] += 1;
  });

  return counts;
}

function formatDuration(iso) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));

  if (!match) return '';

  const hours = Number(match[1] || 0) * 24 + Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const pad = number => String(number).padStart(2, '0');

  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function validQuestions(list) {
  return (
    Array.isArray(list) &&
    list.length >= 1 &&
    list.every(
      item =>
        item &&
        typeof item.question === 'string' &&
        item.question.trim() &&
        Array.isArray(item.choices) &&
        item.choices.length === 4 &&
        item.choices.every(choice => typeof choice === 'string' && choice.trim()) &&
        Number.isInteger(Number(item.correctAnswer)) &&
        Number(item.correctAnswer) >= 0 &&
        Number(item.correctAnswer) <= 3
    )
  );
}

// ------------------------------------------------------------
// Utilisation par le quiz
// ------------------------------------------------------------

// Quiz approuvé pour cette vidéo et cette langue (ou null)
function findApproved(videoId, language) {
  const record = state.videos[makeId(language, videoId)];

  return record && record.status === 'approved' ? record : null;
}

// Garde un quiz fraîchement généré, « à valider ». Ne remplace jamais un quiz existant.
function capture({ videoId, language, category, video, questions }) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || '')) || !LANGUAGES.includes(language)) {
    return null;
  }

  if (!validQuestions(questions)) return null;

  const id = makeId(language, videoId);
  const existing = state.videos[id];
  const cleanCategory = String(category || '').trim().slice(0, 60);

  if (existing) {
    // Même vidéo trouvée pour un autre thème : on retient le thème en plus
    if (cleanCategory && !existing.categories.includes(cleanCategory)) {
      existing.categories.push(cleanCategory);
      saveSoon();
    }

    return existing;
  }

  if (countByStatus().pending >= MAX_PENDING) return null;

  const meta = video && typeof video === 'object' ? video : {};

  state.videos[id] = {
    id,
    videoId,
    language,
    categories: cleanCategory ? [cleanCategory] : [],
    title: String(meta.title || '').slice(0, 200),
    channelTitle: String(meta.channelTitle || '').slice(0, 120),
    duration: meta.duration || null,
    questions: JSON.parse(JSON.stringify(questions)),
    status: 'pending',
    source: 'live',
    createdAt: new Date().toISOString(),
    served: 0
  };

  saveNow();

  return state.videos[id];
}

// Une vidéo approuvée que cet élève n'a pas encore vue (au hasard)
function pickUnseen({ language, category, seen }) {
  const wanted = String(category || '').trim();

  const candidates = Object.values(state.videos).filter(
    record =>
      record.status === 'approved' &&
      record.language === language &&
      !seen.has(record.videoId) &&
      (!wanted || record.categories.includes(wanted))
  );

  if (!candidates.length) return { record: null, remaining: 0 };

  return {
    record: candidates[Math.floor(Math.random() * candidates.length)],
    remaining: candidates.length
  };
}

function toVideo(record) {
  return {
    videoId: record.videoId,
    title: record.title,
    channelTitle: record.channelTitle,
    durationFormatted: formatDuration(record.duration),
    captionAvailable: true,
    fromLibrary: true
  };
}

function markServed(id) {
  const record = state.videos[id];

  if (!record) return;

  record.served = (record.served || 0) + 1;
  record.lastServedAt = new Date().toISOString();
  state.served += 1;

  saveSoon();
}

// ------------------------------------------------------------
// Administration
// ------------------------------------------------------------

function stats() {
  return { ...countByStatus(), served: state.served };
}

function list(status) {
  return Object.values(state.videos)
    .filter(record => record.status === status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 200);
}

// action : approve | reject | reopen | delete
function decide(id, action, note) {
  const record = state.videos[id];

  if (!record) return { ok: false, error: 'Quiz introuvable.' };

  if (action === 'delete') {
    delete state.videos[id];
  } else if (action === 'approve') {
    record.status = 'approved';
    record.approvedAt = new Date().toISOString();
  } else if (action === 'reject') {
    record.status = 'rejected';
    record.rejectedAt = new Date().toISOString();
  } else if (action === 'reopen') {
    record.status = 'pending';
  } else {
    return { ok: false, error: 'Action invalide.' };
  }

  if (note && state.videos[id]) {
    record.note = String(note).slice(0, 200);
  }

  saveNow();

  return { ok: true };
}

module.exports = {
  findApproved,
  capture,
  pickUnseen,
  toVideo,
  markServed,
  stats,
  list,
  decide,
  formatDuration
};
