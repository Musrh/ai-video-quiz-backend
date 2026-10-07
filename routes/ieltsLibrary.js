const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ielts = require('./ielts');

const helpers = ielts.helpers;

const router = express.Router();

const API = '/api/youtube/ielts/library';

// ============================================================
// CONFIGURATION
// ============================================================

// Dossier de sauvegarde. Sur Railway, il faut un "Volume" monté sur /data,
// sinon les données sont perdues à chaque redéploiement.
const DATA_DIR =
  process.env.IELTS_DATA_DIR ||
  (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));

const DATA_FILE = path.join(DATA_DIR, 'ielts-library.json');

const DEFAULT_SEARCH_COUNT = 3; // vidéos ajoutées à chaque clic "plus de vidéos"
const MAX_SEARCH_COUNT = 5;
const MAX_API_SEARCHES_PER_RUN = 4; // limite le quota YouTube (100 unités / recherche)
const MAX_ATTEMPTS = 2; // essais maximum pour une vidéo en erreur

// Une vidéo trouvée par la RECHERCHE n'est gardée que si (presque) toutes ses
// questions et ses réponses ont été lues. Sinon elle est écartée, et jamais
// réanalysée (pas de crédit gaspillé). Les vidéos ajoutées à la main par
// l'administrateur sont toujours gardées (marquées « à relire » si incomplètes).
const MIN_QUESTIONS = Number(process.env.IELTS_MIN_QUESTIONS || 36);
const MIN_ANSWERS = Number(process.env.IELTS_MIN_ANSWERS || 30);

// ============================================================
// SAUVEGARDE (fichier JSON)
// ============================================================

function defaultState() {
  return {
    videos: {}, // vidéos analysées (questions + réponses)
    failed: {}, // vidéos sans questions exploitables ou en erreur
    search: { queryIndex: 0, tokens: {} } // avancement de la recherche YouTube
  };
}

let state = defaultState();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const base = defaultState();

      state = {
        ...base,
        ...raw,
        search: { ...base.search, ...(raw.search || {}) }
      };
    }

    console.log(
      `📚 Bibliothèque IELTS : ${Object.keys(state.videos).length} vidéo(s) ` +
        `(fichier ${DATA_FILE})`
    );

    if (!process.env.IELTS_DATA_DIR && !fs.existsSync('/data')) {
      console.warn(
        '⚠️ Aucun volume /data : la bibliothèque sera perdue au prochain ' +
          'redéploiement. Ajoute un Volume Railway monté sur /data.'
      );
    }
  } catch (error) {
    console.error('❌ Lecture de la bibliothèque impossible :', error.message);
  }
}

let saving = Promise.resolve();

function saveState() {
  saving = saving
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });

      const tmp = `${DATA_FILE}.tmp`;

      await fsp.writeFile(tmp, JSON.stringify(state));
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch(error => {
      console.error('❌ Sauvegarde impossible :', error.message);
    });

  return saving;
}

loadState();

// ============================================================
// OUTILS
// ============================================================

function isKnown(videoId) {
  if (state.videos[videoId]) {
    return true;
  }

  const failed = state.failed[videoId];

  return Boolean(
    failed &&
      (failed.kind === 'no_questions' || failed.attempts >= MAX_ATTEMPTS)
  );
}

function markFailed(video, kind, message, diagnostics) {
  const previous = state.failed[video.videoId];

  state.failed[video.videoId] = {
    videoId: video.videoId,
    title: video.title || '',
    kind, // 'no_questions' | 'error'
    message: message || '',
    diagnostics: diagnostics || null,
    attempts: (previous ? previous.attempts : 0) + 1,
    at: new Date().toISOString()
  };
}

// Écarte une vidéo de la recherche si elle est trop incomplète
function searchQualityProblem(result) {
  const found = result && result.questions ? result.questions.length : 0;

  const answers = Math.max(
    result && result.answers ? Object.keys(result.answers).length : 0,
    result && result.questions
      ? result.questions.filter(question => question.answer).length
      : 0
  );

  if (found < MIN_QUESTIONS) {
    return `Seulement ${found} questions lues sur 40 (minimum ${MIN_QUESTIONS})`;
  }

  if (answers < MIN_ANSWERS) {
    return `Seulement ${answers} réponses lues (minimum ${MIN_ANSWERS})`;
  }

  return '';
}

// Au démarrage : retire les vidéos de la recherche déjà enregistrées mais trop incomplètes
function pruneWeakSearchVideos() {
  let removed = 0;

  Object.keys(state.videos).forEach(id => {
    const record = state.videos[id];

    if (record.source !== 'search') {
      return;
    }

    const answers = Object.keys(record.answers || {}).length;

    if (record.questionCount < MIN_QUESTIONS || answers < MIN_ANSWERS) {
      markFailed(
        { videoId: id, title: record.title },
        'no_questions',
        `Retirée : ${record.questionCount} questions et ${answers} réponses lues`
      );

      delete state.videos[id];
      removed++;
    }
  });

  if (removed > 0) {
    console.log(`🧹 ${removed} vidéo(s) de la recherche retirée(s) (trop incomplètes)`);
    saveState();
  }
}

pruneWeakSearchVideos();

function summarize(record) {
  return {
    videoId: record.videoId,
    url: record.url,
    title: record.title,
    channelTitle: record.channelTitle,
    thumbnail: record.thumbnail,
    durationSeconds: record.durationSeconds,
    status: record.status, // 'ok' | 'to_review'
    issues: record.issues,
    questionCount: record.questionCount,
    hasAnswers: Object.keys(record.answers || {}).length > 0,
    addedAt: record.addedAt,
    source: record.source
  };
}

// Transforme le résultat OCR en fiche sauvegardée (réponses séparées des questions)
function buildRecord(video, result, source) {
  const answers = {};

  const questions = result.questions.map(question => {
    const { answer, ...rest } = question;

    if (answer) {
      answers[question.number] = answer;
    }

    return rest;
  });

  const issues = [];

  if (result.missingNumbers && result.missingNumbers.length > 0) {
    issues.push(
      `Questions non retrouvées : ${result.missingNumbers.join(', ')}`
    );
  }

  const withoutAnswer = questions
    .filter(question => !answers[question.number])
    .map(question => question.number);

  if (withoutAnswer.length > 0) {
    issues.push(`Réponses manquantes : ${withoutAnswer.join(', ')}`);
  }

  const inferred = questions
    .filter(question => question.inferred)
    .map(question => question.number);

  if (inferred.length > 0) {
    issues.push(`Questions déduites, à vérifier : ${inferred.join(', ')}`);
  }

  return {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    title: video.title,
    channelTitle: video.channelTitle,
    thumbnail: video.thumbnail,
    durationSeconds: video.durationSeconds,
    publishedAt: video.publishedAt,
    status: issues.length === 0 ? 'ok' : 'to_review',
    issues,
    questionCount: questions.length,
    missingNumbers: result.missingNumbers || [],
    questions,
    answers,
    groups: result.groups || [],
    diagnostics: result.diagnostics || null,
    source,
    addedAt: new Date().toISOString()
  };
}

// ============================================================
// FILE D'ANALYSE : une vidéo à la fois
// ============================================================

const queue = [];
const queuedIds = new Set();

// Vidéos en cours d'analyse (non sauvegardées) : elles apparaissent tout de suite
// dans la liste, et la personne peut déjà les regarder en attendant le test.
const pending = new Map();

function setPending(video, pendingStatus, source, extra) {
  const previous = pending.get(video.videoId);

  pending.set(video.videoId, {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    title: video.title || video.videoId,
    channelTitle: video.channelTitle || '',
    thumbnail: video.thumbnail || null,
    durationSeconds: video.durationSeconds || 0,
    status: pendingStatus, // 'queued' | 'analyzing' | 'failed'
    issues: [],
    questionCount: 0,
    hasAnswers: false,
    addedAt: previous ? previous.addedAt : new Date().toISOString(),
    source,
    ...(extra || {})
  });
}

function friendlyError(message) {
  const text = String(message || '');

  if (/sign in to confirm|not a bot/i.test(text)) {
    return 'YouTube bloque le téléchargement (cookies à renouveler).';
  }

  if (/YOUTUBE_API_KEY/i.test(text)) {
    return 'Clé YouTube manquante sur le serveur.';
  }

  return 'Analyse impossible pour cette vidéo.';
}

let working = false;

const status = {
  mode: null, // 'search' | 'analyze'
  message: '',
  current: null,
  search: null, // { target, analyzed }
  lastMessage: '',
  lastError: '',
  lastFinishedAt: null
};

function statusSnapshot() {
  return {
    running: working || queue.length > 0,
    searchActive: searchIsActive(),
    mode: status.mode,
    message: status.message,
    current: status.current,
    search: status.search,
    queueLength: queue.length,
    libraryCount: Object.keys(state.videos).length,
    lastMessage: status.lastMessage,
    lastError: status.lastError,
    lastFinishedAt: status.lastFinishedAt
  };
}

async function analyzeAndStore(video, source) {
  status.current = { videoId: video.videoId, title: video.title };
  status.message = `Analyse de « ${video.title} »… (quelques minutes)`;

  setPending(video, 'analyzing', source);

  try {
    // Lecture de la vidéo par OCR (questions + corrigé)
    const result = await helpers.analyzeVideoWithOCR(video, {});

    if (!result || !result.questions || result.questions.length === 0) {
      const onScreen = result && result.rejected === 'no_questions_on_screen';

      markFailed(
        video,
        'no_questions',
        onScreen
          ? 'Aucune page de questions à l’écran'
          : 'Aucune question détectée',
        result && result.diagnostics
      );

      if (source === 'manual') {
        setPending(video, 'failed', source, {
          error: onScreen
            ? 'Aucune page de questions n’apparaît à l’écran dans cette vidéo.'
            : 'Aucune question exploitable dans cette vidéo.'
        });
      } else {
        pending.delete(video.videoId);
      }

      await saveState();

      return false;
    }

    // Recherche automatique : on ne garde que les vidéos (presque) complètes
    const problem = source === 'search' ? searchQualityProblem(result) : '';

    if (problem) {
      markFailed(video, 'no_questions', problem, result.diagnostics);
      pending.delete(video.videoId);

      await saveState();

      console.log(`🚫 Vidéo écartée ${video.videoId} : ${problem}`);

      return false;
    }

    state.videos[video.videoId] = buildRecord(video, result, source);
    delete state.failed[video.videoId];
    pending.delete(video.videoId);

    await saveState();

    console.log(
      `💾 Vidéo enregistrée : ${video.videoId} ` +
        `(${state.videos[video.videoId].questionCount} questions, ` +
        `${state.videos[video.videoId].status})`
    );

    return true;
  } catch (error) {
    console.error(`❌ Analyse ${video.videoId} :`, error.message);

    markFailed(video, 'error', error.message.slice(0, 300));
    status.lastError = `Échec pour « ${video.title || video.videoId} »`;

    if (source === 'manual') {
      setPending(video, 'failed', source, { error: friendlyError(error.message) });
    } else {
      pending.delete(video.videoId);
    }

    await saveState();

    return false;
  } finally {
    status.current = null;
  }
}

// Une page de résultats YouTube (avec jeton pour la page suivante)
async function searchYouTubePage(query, pageToken) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY manquante');
  }

  const response = await axios.get(`${helpers.YOUTUBE_API_URL}/search`, {
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
      regionCode: 'US',
      ...(pageToken ? { pageToken } : {})
    },
    timeout: 30000
  });

  return {
    items: response.data.items || [],
    nextPageToken: response.data.nextPageToken || null
  };
}

// Prochaine recherche à lancer (on fait tourner les requêtes, page après page)
function pickQuery() {
  const queries = helpers.LISTENING_QUERIES;

  for (let i = 0; i < queries.length; i++) {
    const index = (state.search.queryIndex + i) % queries.length;
    const query = queries[index];

    if (state.search.tokens[query] !== 'done') {
      return { query, index, token: state.search.tokens[query] || undefined };
    }
  }

  return null;
}

async function runSearch(count) {
  let analyzed = 0;
  let apiSearches = 0;
  let resetDone = false;

  status.search = { target: count, analyzed: 0 };

  while (analyzed < count && apiSearches < MAX_API_SEARCHES_PER_RUN) {
    let pick = pickQuery();

    if (!pick) {
      // Toutes les pages ont été parcourues : on recommence un tour
      if (resetDone) {
        break;
      }

      resetDone = true;
      state.search = { queryIndex: 0, tokens: {} };
      pick = pickQuery();

      if (!pick) {
        break;
      }
    }

    status.message = `Recherche de nouvelles vidéos : « ${pick.query} »…`;

    const { items, nextPageToken } = await searchYouTubePage(
      pick.query,
      pick.token
    );

    apiSearches++;

    state.search.tokens[pick.query] = nextPageToken || 'done';
    state.search.queryIndex = (pick.index + 1) % helpers.LISTENING_QUERIES.length;

    await saveState();

    const ids = items
      .map(item => item.id && item.id.videoId)
      .filter(Boolean)
      .filter(id => !isKnown(id) && !queuedIds.has(id));

    if (ids.length === 0) {
      continue;
    }

    const details = await helpers.getVideoDetails(ids);

    const candidates = helpers
      .processVideos(details)
      .sort((a, b) => b.quality - a.quality);

    for (const video of candidates) {
      if (analyzed >= count) {
        break;
      }

      if (isKnown(video.videoId)) {
        continue;
      }

      const ok = await analyzeAndStore(video, 'search');

      if (ok) {
        analyzed++;
        status.search.analyzed = analyzed;
      }
    }
  }

  status.lastMessage =
    analyzed > 0
      ? `${analyzed} nouvelle(s) vidéo(s) ajoutée(s).`
      : 'Aucune nouvelle vidéo exploitable trouvée pour le moment.';
}

async function runAnalyze(task) {
  const videoId = task.videoId;

  if (state.videos[videoId] && !task.force) {
    return;
  }

  let video = task.video;

  if (!video) {
    status.message = 'Récupération des informations de la vidéo…';

    const details = await helpers.getVideoDetails([videoId]);

    if (!details || details.length === 0) {
      setPending({ videoId, title: '' }, 'failed', 'manual', {
        error: 'Vidéo YouTube introuvable.'
      });
      status.lastError = 'Vidéo YouTube introuvable';

      return;
    }

    video = helpers.buildVideoObject(details[0]);
  }

  const ok = await analyzeAndStore(video, 'manual');

  status.lastMessage = ok
    ? `« ${video.title} » ajoutée.`
    : `Aucune question exploitable dans « ${video.title} ».`;
}

async function runWorker() {
  if (working) {
    return;
  }

  working = true;

  try {
    while (queue.length > 0) {
      const task = queue.shift();

      status.mode = task.type;
      status.lastError = '';

      try {
        if (task.type === 'search') {
          await runSearch(task.count);
        } else {
          await runAnalyze(task);
        }
      } catch (error) {
        console.error('❌ Tâche en échec :', error.message);

        status.lastError = error.message;
      } finally {
        if (task.videoId) {
          queuedIds.delete(task.videoId);
        }
      }
    }
  } finally {
    working = false;
    status.mode = null;
    status.message = '';
    status.current = null;
    status.search = null;
    status.lastFinishedAt = new Date().toISOString();
  }
}

function enqueue(task) {
  queue.push(task);

  if (task.videoId) {
    queuedIds.add(task.videoId);
  }

  runWorker();
}

function searchIsActive() {
  return (
    status.mode === 'search' || queue.some(task => task.type === 'search')
  );
}

// ============================================================
// ACCÈS ADMINISTRATEUR (variable IELTS_ADMIN_KEY)
// ============================================================
// Seul l'administrateur peut lancer des recherches, ajouter ou supprimer une
// vidéo (ce sont ces actions qui consomment du crédit). Les autres personnes
// voient uniquement les vidéos déjà enregistrées.
// Tant que IELTS_ADMIN_KEY n'est pas définie, ces actions sont bloquées pour tous.

const failedAdminAttempts = new Map();
const MAX_ADMIN_ATTEMPTS = 10;
const ADMIN_LOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.get('x-forwarded-for') || req.ip || '')
    .split(',')[0]
    .trim();
}

function keyMatches(given) {
  const secret = process.env.IELTS_ADMIN_KEY || '';

  if (!secret || !given) {
    return false;
  }

  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// La clé est envoyée dans l'en-tête "x-admin-key" (ou "?key=" pour les
// anciennes adresses de test, utilisables depuis un navigateur).
function providedKey(req, allowQuery) {
  return req.get('x-admin-key') || (allowQuery ? req.query.key : '') || '';
}

function isAdminRequest(req, allowQuery = false) {
  return keyMatches(providedKey(req, allowQuery));
}

function adminGuard(allowQuery = false) {
  return (req, res, next) => {
    if (!process.env.IELTS_ADMIN_KEY) {
      return res.status(403).json({
        ok: false,
        error:
          'Action réservée à l’administrateur : la variable IELTS_ADMIN_KEY ' +
          'n’est pas définie sur le serveur.'
      });
    }

    const ip = clientIp(req);
    const now = Date.now();
    const record = failedAdminAttempts.get(ip);

    if (record && record.count >= MAX_ADMIN_ATTEMPTS && now < record.resetAt) {
      return res.status(429).json({
        ok: false,
        error: 'Trop de tentatives. Réessaie dans quelques minutes.'
      });
    }

    if (isAdminRequest(req, allowQuery)) {
      failedAdminAttempts.delete(ip);

      return next();
    }

    if (providedKey(req, allowQuery)) {
      const current =
        record && now < record.resetAt
          ? record
          : { count: 0, resetAt: now + ADMIN_LOCK_MS };

      current.count++;
      failedAdminAttempts.set(ip, current);
    }

    return res.status(401).json({
      ok: false,
      error: 'Accès réservé à l’administrateur'
    });
  };
}

const requireAdmin = adminGuard(false);

// ============================================================
// ROUTES
// ============================================================

// Liste des vidéos sauvegardées.
// L'administrateur voit aussi les vidéos en cours d'analyse et l'état de la file.
router.get(API, (req, res) => {
  const admin = isAdminRequest(req);

  const saved = Object.values(state.videos)
    .filter(record => !(admin && pending.has(record.videoId)))
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
    .map(summarize);

  const inProgress = admin
    ? [...pending.values()].sort((a, b) =>
        String(b.addedAt).localeCompare(String(a.addedAt))
      )
    : [];

  res.json({
    ok: true,
    admin,
    count: Object.keys(state.videos).length,
    videos: [...inProgress, ...saved],
    status: admin
      ? statusSnapshot()
      : { running: false, libraryCount: Object.keys(state.videos).length }
  });
});

// Vérifie le mot de passe administrateur (utilisé par la page)
router.get(`${API}/admin-check`, requireAdmin, (req, res) => {
  res.json({ ok: true, admin: true });
});

// État de la file d'analyse (administrateur uniquement pour les détails)
router.get(`${API}/status`, (req, res) => {
  if (!isAdminRequest(req)) {
    return res.json({
      ok: true,
      running: false,
      libraryCount: Object.keys(state.videos).length
    });
  }

  return res.json({ ok: true, ...statusSnapshot() });
});

// Ajouter une vidéo précise (lien ou identifiant) :
// elle apparaît tout de suite dans la liste, l'analyse se fait en arrière-plan.
router.post(`${API}/analyze`, requireAdmin, async (req, res) => {
  const videoId = helpers.getVideoIdFromUrl(
    (req.body && (req.body.videoId || req.body.url)) || ''
  );

  if (!videoId) {
    return res.status(400).json({
      ok: false,
      error: 'Lien ou identifiant YouTube invalide'
    });
  }

  const force = Boolean(req.body && req.body.force);

  if (state.videos[videoId] && !force) {
    return res.json({
      ok: true,
      status: 'exists',
      video: summarize(state.videos[videoId])
    });
  }

  if (queuedIds.has(videoId) || (status.current && status.current.videoId === videoId)) {
    return res.json({
      ok: true,
      status: 'already_queued',
      video: pending.get(videoId) || null
    });
  }

  try {
    const details = await helpers.getVideoDetails([videoId]);

    if (!details || details.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Vidéo YouTube introuvable'
      });
    }

    const video = helpers.buildVideoObject(details[0]);

    setPending(video, 'queued', 'manual');

    enqueue({ type: 'analyze', videoId, force, video });

    return res.json({
      ok: true,
      status: 'queued',
      video: pending.get(videoId)
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: friendlyError(error.message)
    });
  }
});

// "Afficher plus de vidéos" : nouvelle recherche, analyse une par une
router.post(`${API}/search-more`, requireAdmin, (req, res) => {
  if (searchIsActive()) {
    return res.json({ ok: true, status: 'already_running' });
  }

  const requested = Number(req.body && req.body.count);

  const count = Math.min(
    MAX_SEARCH_COUNT,
    Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SEARCH_COUNT)
  );

  enqueue({ type: 'search', count });

  return res.json({ ok: true, status: 'started', count });
});

// Questions d'une vidéo (sans les réponses)
router.get(`${API}/:videoId`, (req, res) => {
  const record = state.videos[req.params.videoId];

  if (!record) {
    return res.status(404).json({ ok: false, error: 'Vidéo introuvable' });
  }

  return res.json({
    ok: true,
    video: {
      ...summarize(record),
      questions: record.questions,
      groups: record.groups
    }
  });
});

// Réponses d'une vidéo (bouton "Afficher les réponses")
router.get(`${API}/:videoId/answers`, (req, res) => {
  const record = state.videos[req.params.videoId];

  if (!record) {
    return res.status(404).json({ ok: false, error: 'Vidéo introuvable' });
  }

  return res.json({ ok: true, answers: record.answers || {} });
});

// Supprimer une vidéo (pour pouvoir la refaire)
router.delete(`${API}/:videoId`, requireAdmin, (req, res) => {
  const id = req.params.videoId;

  // Une carte "échec" ou "en cours" se ferme sans supprimer la vidéo déjà enregistrée
  if (pending.has(id)) {
    pending.delete(id);

    return res.json({ ok: true });
  }

  const had = state.videos[id];

  delete state.videos[id];

  if (had) {
    // On s'en souvient : la recherche ne la proposera plus
    markFailed(
      { videoId: id, title: had.title },
      'no_questions',
      'Supprimée par l’administrateur'
    );
  } else {
    delete state.failed[id];
  }

  saveState();

  res.json({ ok: true });
});

// ============================================================
// PAGE WEB : liste des vidéos, vidéo, test, réponses
// ============================================================

const PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IELTS Listening</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1c1f26; --muted:#6a7080; --line:#dfe3ea; --accent:#2457d6; --ok:#1c8a4a; --warn:#b26a00; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161b; --card:#1d2027; --text:#eceef3; --muted:#9aa1b2; --line:#2c303a; --accent:#6c93ff; --ok:#4cc27f; --warn:#e2a03f; --bad:#ef6a5b; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header, main { max-width:720px; margin:0 auto; padding:16px; }
  h1 { margin:8px 0 4px; font-size:1.5rem; }
  .muted { color:var(--muted); font-size:.9rem; }
  button { font:inherit; border:0; border-radius:10px; padding:12px 16px; background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  button.wide { width:100%; margin-top:8px; }
  input[type=text], input[type=password], select { font:inherit; width:100%; padding:10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); }
  .add { display:flex; gap:8px; margin:12px 0; }
  .add input { flex:1; }
  .status { padding:10px 12px; border-radius:10px; background:var(--card); border:1px solid var(--line); margin:12px 0; font-size:.95rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; margin:14px 0; overflow:hidden; }
  .thumb { width:100%; display:block; aspect-ratio:16/9; object-fit:cover; background:var(--line); }
  .cardbody { padding:12px 14px 14px; }
  .cardbody h3 { margin:0 0 6px; font-size:1.02rem; line-height:1.3; }
  .badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:.78rem; border:1px solid currentColor; }
  .badge.ok { color:var(--ok); } .badge.review { color:var(--warn); }
  .issues { color:var(--warn); font-size:.85rem; margin:6px 0 0; padding-left:18px; }
  .player { position:relative; width:100%; aspect-ratio:16/9; margin-top:10px; border-radius:10px; overflow:hidden; background:#000; }
  .player iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .test { margin-top:14px; border-top:1px solid var(--line); padding-top:12px; }
  .head { margin:16px 0 6px; padding:8px 10px; border-left:4px solid var(--accent); background:var(--bg); border-radius:6px; font-size:.92rem; }
  .head b { display:block; }
  .opts { margin:6px 0 0; padding-left:18px; }
  .q { padding:10px 0; border-bottom:1px solid var(--line); }
  .qtext { margin:0 0 6px; line-height:1.4; }
  .choice { display:flex; align-items:flex-start; gap:8px; padding:6px 0; }
  .choice input { margin-top:4px; }
  .answer { margin-top:6px; font-size:.92rem; font-weight:600; }
  .answer.right { color:var(--ok); } .answer.wrong { color:var(--bad); } .answer.plain { color:var(--accent); }
  .score { font-weight:700; margin:12px 0; }
  .empty { text-align:center; color:var(--muted); padding:30px 10px; }
  .badge.wait { color:var(--accent); } .badge.bad { color:var(--bad); }
  .notice { padding:10px 12px; border-radius:10px; margin:8px 0; font-size:.95rem; border:1px solid var(--line); background:var(--card); }
  .notice.info { border-color:var(--accent); }
  .notice.ok { border-color:var(--ok); color:var(--ok); }
  .notice.warn { border-color:var(--warn); color:var(--warn); }
  .card.flash { outline:3px solid var(--accent); transition:outline-color .3s; }
  .row { display:flex; gap:8px; margin-top:8px; }
  .foot { margin-top:28px; padding-top:12px; border-top:1px solid var(--line); text-align:center; }
  button.link { background:transparent; color:var(--muted); padding:6px 8px; font-size:.85rem; text-decoration:underline; }
  .foot .row { max-width:420px; margin:8px auto 0; }
  .row button { flex:1; }
</style>
</head>
<body>
<header>
  <h1>IELTS Listening</h1>
  <div class="muted" id="sub">Tests enregistrés</div>
</header>
<main>
  <div id="adminTop" hidden>
    <div class="add">
      <input type="text" id="addInput" placeholder="Lien ou identifiant YouTube">
      <button id="addBtn">Ajouter</button>
    </div>
    <div class="notice" id="notice" hidden></div>
    <div class="status" id="statusBar" hidden></div>
  </div>
  <div id="list"></div>
  <div id="adminMore" hidden>
    <button class="wide" id="moreBtn">Afficher plus de vidéos</button>
  </div>
  <div class="foot">
    <button class="link" id="adminLink">Espace administrateur</button>
    <div class="row" id="loginBox" hidden>
      <input type="password" id="adminPass" placeholder="Mot de passe administrateur" autocomplete="current-password">
      <button id="loginBtn">Valider</button>
    </div>
    <div class="muted" id="loginMsg"></div>
  </div>
</main>
<script>
(function () {
  // Mot de passe administrateur : gardé dans le navigateur de l'administrateur uniquement
  var KEY = null;
  try { KEY = localStorage.getItem('ieltsAdminKey'); } catch (e) {}
  var isAdminUI = false;
  var BASE = '/api/youtube/ielts/library';

  var listEl = document.getElementById('list');
  var statusBar = document.getElementById('statusBar');
  var moreBtn = document.getElementById('moreBtn');
  var addBtn = document.getElementById('addBtn');
  var addInput = document.getElementById('addInput');
  var subEl = document.getElementById('sub');
  var noticeEl = document.getElementById('notice');
  var adminTop = document.getElementById('adminTop');
  var adminMore = document.getElementById('adminMore');
  var adminLink = document.getElementById('adminLink');
  var loginBox = document.getElementById('loginBox');
  var adminPass = document.getElementById('adminPass');
  var loginBtn = document.getElementById('loginBtn');
  var loginMsg = document.getElementById('loginMsg');
  var noticeTimer = null;

  var pollTimer = null;
  var cards = {};
  var emptyEl = null;

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (KEY) options.headers['x-admin-key'] = KEY;
    if (options.body && typeof options.body !== 'string') {
      options.body = JSON.stringify(options.body);
      options.headers['Content-Type'] = 'application/json';
    }
    return fetch(BASE + path, options).then(function (r) { return r.json(); });
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // ---------- Messages à la personne (ajout d'une vidéo) ----------
  function showNotice(text, kind, seconds) {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (!text) { noticeEl.hidden = true; return; }
    noticeEl.hidden = false;
    noticeEl.className = 'notice ' + (kind || 'info');
    noticeEl.textContent = text;
    if (seconds) noticeTimer = setTimeout(function () { noticeEl.hidden = true; }, seconds * 1000);
  }

  // Fait défiler jusqu'à la carte et la fait clignoter un instant
  function highlight(videoId) {
    var c = cards[videoId];
    if (!c) return;
    if (c.node.scrollIntoView) c.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.node.classList.add('flash');
    setTimeout(function () { c.node.classList.remove('flash'); }, 2500);
  }

  // ---------- Statut ----------
  function showStatus(text) {
    if (!text) { statusBar.hidden = true; return; }
    statusBar.hidden = false;
    statusBar.textContent = text;
  }

  function updateStatus(s) {
    moreBtn.disabled = !!s.searchActive;
    if (s.running) {
      var text = s.message || 'Traitement en cours…';
      if (s.search) text += '  (' + s.search.analyzed + '/' + s.search.target + ' ajoutées)';
      if (s.queueLength > 1) text += '  — ' + (s.queueLength - 1) + ' en attente';
      showStatus(text);
    } else if (s.lastError) {
      showStatus('⚠️ ' + s.lastError + (s.lastMessage ? ' — ' + s.lastMessage : ''));
    } else {
      showStatus(s.lastMessage || '');
    }
  }

  function schedulePoll() {
    if (!pollTimer) pollTimer = setInterval(refreshAll, 4000);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Affiche ou masque tout ce qui est réservé à l'administrateur
  function setAdminUI(on) {
    isAdminUI = on;
    adminTop.hidden = !on;
    adminMore.hidden = !on;
    adminLink.textContent = on ? 'Se déconnecter (administrateur)' : 'Espace administrateur';
    if (emptyEl) {
      emptyEl.textContent = on
        ? 'Aucune vidéo pour le moment. Appuie sur « Afficher plus de vidéos » ou ajoute un lien.'
        : 'Aucune vidéo disponible pour le moment.';
    }
  }

  function resetCards() {
    Object.keys(cards).forEach(function (id) { cards[id].node.remove(); });
    cards = {};
  }

  function forgetKey() {
    KEY = null;
    try { localStorage.removeItem('ieltsAdminKey'); } catch (e) {}
  }

  function refreshAll() {
    return api('').then(function (data) {
      // Mot de passe enregistré mais refusé par le serveur : on l'oublie
      if (KEY && !data.admin) forgetKey();
      setAdminUI(!!data.admin);

      subEl.textContent = data.count + ' test(s) enregistré(s)';
      reconcile(data.videos);

      if (data.admin) {
        updateStatus(data.status);
        if (data.status.running) schedulePoll(); else stopPoll();
      } else {
        stopPoll();
      }
    }).catch(function () { if (isAdminUI) schedulePoll(); });
  }

  // ---------- Liste des vidéos ----------
  function isReady(v) { return v.status === 'ok' || v.status === 'to_review'; }

  function badgeInfo(v) {
    if (v.status === 'ok') return { cls: 'ok', text: 'vérifié' };
    if (v.status === 'to_review') return { cls: 'review', text: 'à relire' };
    if (v.status === 'analyzing') return { cls: 'wait', text: 'analyse en cours…' };
    if (v.status === 'queued') return { cls: 'wait', text: 'en attente' };
    return { cls: 'bad', text: 'échec' };
  }

  // Met à jour la liste sans toucher aux cartes déjà affichées
  // (le lecteur vidéo ouvert ne doit pas être rechargé).
  function reconcile(videos) {
    var present = {};
    videos.forEach(function (v) { present[v.videoId] = true; });

    Object.keys(cards).forEach(function (id) {
      if (!present[id]) { cards[id].node.remove(); delete cards[id]; }
    });

    videos.slice().reverse().forEach(function (v) {
      if (cards[v.videoId]) {
        updateCard(cards[v.videoId], v);
      } else {
        var c = createCard(v);
        cards[v.videoId] = c;
        listEl.prepend(c.node);
      }
    });

    emptyEl.hidden = videos.length > 0;
  }

  function createCard(v) {
    var c = { v: v, playerShown: false, testStarted: false, startState: '', actionKey: '' };

    c.node = el('div', { class: 'card' });
    if (v.thumbnail) c.node.appendChild(el('img', { class: 'thumb', src: v.thumbnail, alt: '', loading: 'lazy' }));

    var body = el('div', { class: 'cardbody' });
    c.title = el('h3', { text: v.title || v.videoId });
    c.countText = document.createTextNode('');
    c.badge = el('span', { class: 'badge' });
    c.meta = el('div', { class: 'muted' }, [c.countText, c.badge]);
    c.issues = el('ul', { class: 'issues' });
    c.msg = el('div', { class: 'muted' });
    c.actions = el('div', { class: 'row' });
    c.area = el('div');
    c.startBox = el('div');

    c.showBtn = el('button', { class: 'wide', text: 'Afficher la vidéo' });
    c.showBtn.addEventListener('click', function () {
      c.showBtn.remove();
      c.playerShown = true;
      c.area.appendChild(el('div', { class: 'player' }, [
        el('iframe', {
          src: 'https://www.youtube.com/embed/' + v.videoId,
          allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
          allowfullscreen: ''
        })
      ]));
      c.area.appendChild(c.startBox);
      renderStart(c);
    });

    [c.title, c.meta, c.issues, c.msg, c.actions, c.showBtn, c.area].forEach(function (n) { body.appendChild(n); });
    c.node.appendChild(body);

    updateCard(c, v);
    return c;
  }

  function updateCard(c, v) {
    c.v = v;
    c.title.textContent = v.title || v.videoId;
    c.countText.nodeValue = isReady(v) ? (v.questionCount + ' questions  ') : '';

    var b = badgeInfo(v);
    c.badge.className = 'badge ' + b.cls;
    c.badge.textContent = b.text;

    c.issues.innerHTML = '';
    if (isAdminUI) (v.issues || []).forEach(function (i) { c.issues.appendChild(el('li', { text: i })); });

    if (v.status === 'analyzing') c.msg.textContent = 'Analyse en cours : tu peux déjà regarder la vidéo, le test sera prêt dans quelques minutes.';
    else if (v.status === 'queued') c.msg.textContent = 'En attente d’analyse : tu peux déjà regarder la vidéo.';
    else if (v.status === 'failed') c.msg.textContent = '⚠️ ' + (v.error || 'Analyse impossible pour cette vidéo.');
    else c.msg.textContent = '';

    // Boutons "Réessayer" / "Fermer" : reconstruits seulement si l'état change
    var key = isAdminUI ? (v.status === 'failed' ? 'failed' : (isReady(v) ? 'ready' : '')) : '';
    if (key !== c.actionKey) {
      c.actionKey = key;
      c.actions.innerHTML = '';
      if (key === 'ready') {
        var del = el('button', { class: 'secondary', text: 'Supprimer' });
        del.addEventListener('click', function () {
          if (!confirm('Supprimer cette vidéo de la bibliothèque ?')) return;
          api('/' + encodeURIComponent(v.videoId), { method: 'DELETE' }).then(refreshAll);
        });
        c.actions.appendChild(del);
      }
      if (key === 'failed') {
        var retry = el('button', { class: 'secondary', text: 'Réessayer' });
        retry.addEventListener('click', function () {
          api('/analyze', { method: 'POST', body: { videoId: v.videoId, force: true } }).then(function () { refreshAll(); schedulePoll(); });
        });
        var close = el('button', { class: 'secondary', text: 'Fermer' });
        close.addEventListener('click', function () {
          api('/' + encodeURIComponent(v.videoId), { method: 'DELETE' }).then(refreshAll);
        });
        c.actions.appendChild(retry);
        c.actions.appendChild(close);
      }
    }

    renderStart(c);
  }

  // Bouton du test : désactivé pendant l'analyse, actif dès que le test est prêt
  function renderStart(c) {
    if (!c.playerShown || c.testStarted) return;
    var state = isReady(c.v) ? 'ready' : (c.v.status === 'failed' ? 'none' : 'wait');
    if (state === c.startState) return;
    c.startState = state;
    c.startBox.innerHTML = '';
    if (state === 'ready') {
      var btn = el('button', { class: 'wide secondary', text: 'Commencer le test' });
      btn.addEventListener('click', function () {
        c.testStarted = true;
        c.startBox.innerHTML = '';
        loadTest(c.area, c.v);
      });
      c.startBox.appendChild(btn);
    } else if (state === 'wait') {
      var wait = el('button', { class: 'wide secondary', text: 'Test en préparation…' });
      wait.disabled = true;
      c.startBox.appendChild(wait);
    }
  }

  // ---------- Test ----------
  function cleanText(q) {
    var t = q.text || '';
    if (/^\(\d{1,2}\)\s*/.test(t)) return t.replace(/^\(\d{1,2}\)\s*/, '');
    return t.replace(/\(\d{1,2}\)/g, '________');
  }

  function loadTest(area, v) {
    var box = el('div', { class: 'test' }, [el('div', { class: 'muted', text: 'Chargement des questions…' })]);
    area.appendChild(box);

    api('/' + encodeURIComponent(v.videoId)).then(function (data) {
      box.innerHTML = '';
      if (!data.ok) { box.textContent = data.error || 'Erreur'; return; }

      var inputs = {};
      var answerEls = {};
      var lastHead = null;
      var lastOptions = null;

      data.video.questions.forEach(function (q) {
        var headKey = (q.instructions || '') + '|' + (q.context || '');
        if (headKey !== lastHead && (q.instructions || q.context)) {
          var head = el('div', { class: 'head' });
          if (q.instructions) head.appendChild(el('b', { text: q.instructions }));
          if (q.context) head.appendChild(el('span', { text: q.context }));
          box.appendChild(head);
        }
        lastHead = headKey;

        var optKey = JSON.stringify(q.options || []);
        if (q.options && q.options.length && optKey !== lastOptions) {
          var ul = el('ul', { class: 'opts' });
          q.options.forEach(function (o) { ul.appendChild(el('li', { text: o.letter + ' — ' + o.text })); });
          box.appendChild(ul);
        }
        lastOptions = optKey;

        var block = el('div', { class: 'q' });
        block.appendChild(el('p', { class: 'qtext', text: q.number + '. ' + cleanText(q) }));

        var name = 'q' + v.videoId + '_' + q.number;
        if (q.choices && q.choices.length) {
          q.choices.forEach(function (c) {
            var radio = el('input', { type: 'radio', name: name, value: c.letter });
            block.appendChild(el('label', { class: 'choice' }, [radio, el('span', { text: c.letter + '. ' + c.text })]));
          });
          inputs[q.number] = function () {
            var checked = block.querySelector('input[name="' + name + '"]:checked');
            return checked ? checked.value : '';
          };
        } else if (q.options && q.options.length) {
          var select = el('select');
          select.appendChild(el('option', { value: '', text: '— choisir —' }));
          q.options.forEach(function (o) { select.appendChild(el('option', { value: o.letter, text: o.letter + ' — ' + o.text })); });
          block.appendChild(select);
          inputs[q.number] = function () { return select.value; };
        } else {
          var input = el('input', { type: 'text', placeholder: 'Ta réponse', autocomplete: 'off', autocapitalize: 'off' });
          block.appendChild(input);
          inputs[q.number] = function () { return input.value; };
        }

        var ans = el('div', { class: 'answer', hidden: '' });
        block.appendChild(ans);
        answerEls[q.number] = ans;
        box.appendChild(block);
      });

      var scoreEl = el('div', { class: 'score', hidden: '' });
      var shown = false;
      var answers = null;

      var btn = el('button', { class: 'wide', text: 'Afficher les réponses' });
      btn.addEventListener('click', function () {
        if (shown) {
          Object.keys(answerEls).forEach(function (n) { answerEls[n].hidden = true; });
          scoreEl.hidden = true;
          btn.textContent = 'Afficher les réponses';
          shown = false;
          return;
        }
        var render = function () {
          var good = 0, total = 0;
          Object.keys(answerEls).forEach(function (n) {
            var correct = answers[n];
            var node = answerEls[n];
            node.hidden = false;
            if (!correct) { node.className = 'answer plain'; node.textContent = 'Réponse non disponible'; return; }
            total++;
            var mine = inputs[n]();
            if (mine && norm(mine) === norm(correct)) {
              good++;
              node.className = 'answer right';
              node.textContent = '✓ ' + correct;
            } else if (mine) {
              node.className = 'answer wrong';
              node.textContent = '✗ Réponse : ' + correct;
            } else {
              node.className = 'answer plain';
              node.textContent = 'Réponse : ' + correct;
            }
          });
          scoreEl.hidden = false;
          scoreEl.textContent = 'Score : ' + good + ' / ' + total;
          btn.textContent = 'Masquer les réponses';
          shown = true;
        };
        if (answers) { render(); return; }
        api('/' + encodeURIComponent(v.videoId) + '/answers').then(function (r) {
          answers = r.answers || {};
          render();
        });
      });

      box.appendChild(scoreEl);
      box.appendChild(btn);
    });
  }

  // ---------- Boutons ----------
  moreBtn.addEventListener('click', function () {
    moreBtn.disabled = true;
    api('/search-more', { method: 'POST', body: { count: 3 } }).then(function (r) {
      if (r.ok === false) showStatus('⚠️ ' + (r.error || 'Erreur'));
      refreshAll();
      schedulePoll();
    });
  });

  addBtn.addEventListener('click', function () {
    var value = addInput.value.trim();
    if (!value) { showNotice('Colle un lien ou un identifiant YouTube.', 'warn', 6); return; }

    addBtn.disabled = true;
    addInput.disabled = true;
    showNotice('🔎 Recherche de la vidéo…', 'info');

    api('/analyze', { method: 'POST', body: { videoId: value } }).then(function (r) {
      var id = r.video && r.video.videoId;
      var title = r.video && r.video.title ? ' « ' + r.video.title + ' »' : '';

      if (r.ok === false) {
        showNotice('⚠️ ' + (r.error || 'Erreur'), 'warn', 10);
        return;
      }

      if (r.status === 'exists') {
        addInput.value = '';
        showNotice('✅ Vidéo existante :' + title + '. Elle est déjà dans la liste.', 'ok', 10);
      } else if (r.status === 'already_queued') {
        addInput.value = '';
        showNotice('⏳ Cette vidéo est déjà en cours d’analyse.', 'info', 10);
      } else {
        addInput.value = '';
        showNotice('Vidéo trouvée :' + title + '. Analyse lancée : tu peux déjà la regarder, le test sera prêt dans quelques minutes.', 'ok', 12);
      }

      schedulePoll();
      return refreshAll().then(function () { if (id) highlight(id); });
    }).catch(function () {
      showNotice('⚠️ Connexion impossible, réessaie dans un instant.', 'warn', 10);
    }).then(function () {
      addBtn.disabled = false;
      addInput.disabled = false;
    });
  });

  addInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addBtn.click();
  });

  adminLink.addEventListener('click', function () {
    if (isAdminUI) {
      forgetKey();
      resetCards();
      loginMsg.textContent = '';
      refreshAll();
    } else {
      loginBox.hidden = !loginBox.hidden;
      loginMsg.textContent = '';
      if (!loginBox.hidden) adminPass.focus();
    }
  });

  function login() {
    var value = adminPass.value;
    if (!value) return;
    loginMsg.textContent = 'Vérification…';
    fetch(BASE + '/admin-check', { headers: { 'x-admin-key': value } })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) {
          KEY = value;
          try { localStorage.setItem('ieltsAdminKey', value); } catch (e) {}
          adminPass.value = '';
          loginBox.hidden = true;
          loginMsg.textContent = '';
          resetCards();
          refreshAll();
        } else {
          loginMsg.textContent = r.error || 'Mot de passe incorrect.';
        }
      })
      .catch(function () { loginMsg.textContent = 'Connexion impossible, réessaie.'; });
  }

  loginBtn.addEventListener('click', login);
  adminPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

  emptyEl = el('div', { class: 'empty', text: 'Aucune vidéo pour le moment. Appuie sur « Afficher plus de vidéos » ou ajoute un lien.' });
  listEl.parentNode.insertBefore(emptyEl, listEl);

  refreshAll();
})();
</script>
</body>
</html>`;

router.get('/ielts-app', (req, res) => {
  res.type('html').send(PAGE);
});

module.exports = router;

// Utilisé par server.js pour protéger les anciennes adresses de recherche et de test
module.exports.adminGuard = adminGuard;
