/* =========================================================
   Récompenses AI Video Quiz — tout est décidé par le SERVEUR

   - L'identité de l'élève vient de son jeton Firebase (vérifié ici avec les
     clés publiques de Google : aucune clé privée n'est nécessaire).
   - Le serveur garde les bonnes réponses, corrige le quiz et crédite les points.
     Le navigateur ne peut rien écrire : il ne fait que lire son solde.
   - Limite de vidéos par jour par adresse e-mail vérifiée, comptée ici.
   - Un point par vidéo et par élève, une seule tentative rémunérée.
   - Retrait = demande que l'administrateur valide et paie lui-même.
   ========================================================= */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { adminGuard } = require('./ieltsLibrary');

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

// Identifiant du projet Firebase (public, visible dans firebaseConfig de index.html)
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'recettes-2c62a';

const CERTS_URL =
  process.env.FIREBASE_CERTS_URL ||
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Ancien stockage des points : Firestore (document de l'élève, lu avec SON jeton).
// Adapte ces valeurs si ta collection / ton champ ont un autre nom.
const LEGACY_COLLECTION = process.env.LEGACY_POINTS_COLLECTION || 'users';
const LEGACY_DATABASE_ID = process.env.LEGACY_DATABASE_ID || '(default)';
const LEGACY_FIELDS = (process.env.LEGACY_POINTS_FIELDS || 'totalPoints,points,score,totalScore')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

// E-mails (code de retrait Western Union / Wafacash) — service Resend (https://resend.com)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || ''; // ex : AI Video Quiz <retraits@ton-domaine.com>

// PayPal Payouts (paiement automatique, facultatif)
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const MAIL_ENABLED = Boolean(RESEND_API_KEY && MAIL_FROM);
const PAYPAL_ENABLED = Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);

// Fuseau horaire qui définit le "jour" de la limite quotidienne
const TIME_ZONE = process.env.REWARDS_TIMEZONE || 'UTC';

const DATA_DIR =
  process.env.REWARDS_DATA_DIR ||
  process.env.IELTS_DATA_DIR ||
  (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));

const DATA_FILE = path.join(DATA_DIR, 'rewards.json');
const AUDIT_FILE = path.join(DATA_DIR, 'rewards-audit.jsonl');

// Règles du quiz (identiques à celles de la page)
const QUIZ_QUESTION_COUNT = 10;
const QUIZ_PASS_THRESHOLD = 8; // 8 bonnes réponses sur 10 = 1 point
const QUIZ_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_OPEN_QUIZZES = 5000;

// Valeurs par défaut, modifiables depuis le panneau administrateur
const DEFAULT_CONFIG = {
  pointValueCents: 10, // 1 point = 0,10 $
  minWithdrawalCents: 1000, // minimum de retrait : 10 $
  dailyVideoLimit: 10, // vidéos jouées par jour et par élève
  withdrawalsEnabled: true // interrupteur général des retraits
};

// ============================================================
// SAUVEGARDE (fichier JSON + journal des opérations)
// ============================================================

let state = {
  config: { ...DEFAULT_CONFIG },
  users: {}, // uid -> { email, points, lockedPoints, withdrawnPoints, plays, days, createdAt }
  withdrawals: [],
  nextWithdrawalId: 1
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

      state = {
        config: { ...DEFAULT_CONFIG, ...(raw.config || {}) },
        users: raw.users || {},
        withdrawals: raw.withdrawals || [],
        nextWithdrawalId: raw.nextWithdrawalId || 1
      };
    }

    console.log(
      `💰 Récompenses : ${Object.keys(state.users).length} élève(s), ` +
        `${state.withdrawals.length} demande(s) de retrait (fichier ${DATA_FILE})`
    );
  } catch (error) {
    console.error('❌ Lecture des récompenses impossible :', error.message);
  }
}

let writing = Promise.resolve();

function saveState() {
  const snapshot = JSON.stringify(state);

  writing = writing
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });

      const tmp = `${DATA_FILE}.tmp`;

      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch(error => console.error('❌ Sauvegarde des récompenses impossible :', error.message));

  return writing;
}

// Journal : une ligne par opération (points crédités, retraits, réglages)
function audit(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';

  writing = writing
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.appendFile(AUDIT_FILE, line);
    })
    .catch(error => console.error('❌ Journal des récompenses impossible :', error.message));
}

loadState();

// ============================================================
// OUTILS
// ============================================================

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getUser(uid, email) {
  if (!state.users[uid]) {
    state.users[uid] = {
      email: email || '',
      points: 0,
      lockedPoints: 0,
      withdrawnPoints: 0,
      plays: {},
      days: {},
      createdAt: new Date().toISOString()
    };
  }

  const user = state.users[uid];

  if (email) {
    user.email = email;
  }

  return user;
}

function availablePoints(user) {
  return Math.max(0, user.points - user.lockedPoints - user.withdrawnPoints);
}

function pendingWithdrawal(uid) {
  return state.withdrawals.find(item => item.uid === uid && item.status === 'pending');
}

function todayCount(user) {
  const day = user.days[dayKey()];

  return day ? day.videos.length : 0;
}

function publicConfig() {
  const { pointValueCents, minWithdrawalCents, dailyVideoLimit, withdrawalsEnabled } = state.config;

  return { pointValueCents, minWithdrawalCents, dailyVideoLimit, withdrawalsEnabled };
}

// Tout ce que la page a besoin de savoir sur l'élève
function summarize(uid, user) {
  const available = availablePoints(user);
  const balanceCents = available * state.config.pointValueCents;
  const pending = pendingWithdrawal(uid);

  const mine = state.withdrawals
    .filter(item => item.uid === uid)
    .slice(-5)
    .reverse()
    .map(item => ({
      id: item.id,
      amountCents: item.amountCents,
      points: item.points,
      status: item.status,
      method: item.payout ? item.payout.method : null,
      network: item.payout && item.payout.network ? item.payout.network : null,
      codeSent: Boolean(item.codeSentAt),
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt || null
    }));

  return {
    ok: true,
    user: {
      email: user.email,
      points: available, // points disponibles (ceux affichés à l'élève)
      earnedPoints: user.points,
      lockedPoints: user.lockedPoints,
      withdrawnPoints: user.withdrawnPoints,
      balanceCents,
      withdrawals: mine
    },
    config: publicConfig(),
    legacy: { status: user.legacyStatus || null, message: user.legacyMessage || '' },
    today: { used: todayCount(user), limit: state.config.dailyVideoLimit },
    canWithdraw:
      state.config.withdrawalsEnabled &&
      !pending &&
      balanceCents >= state.config.minWithdrawalCents
  };
}

// ============================================================
// IDENTITÉ : vérification du jeton Firebase (sans clé privée)
// ============================================================

let certCache = { certs: null, expires: 0 };

async function getCerts(force) {
  if (!force && certCache.certs && Date.now() < certCache.expires) {
    return certCache.certs;
  }

  const response = await axios.get(CERTS_URL, { timeout: 10000 });

  const match = String(response.headers['cache-control'] || '').match(/max-age=(\d+)/);
  const ttl = match ? Number(match[1]) * 1000 : 60 * 60 * 1000;

  certCache = {
    certs: response.data,
    expires: Date.now() + Math.min(ttl, 6 * 60 * 60 * 1000)
  };

  return certCache.certs;
}

function fromBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyIdToken(token) {
  const parts = String(token || '').split('.');

  if (parts.length !== 3) {
    throw new Error('format');
  }

  const header = JSON.parse(fromBase64Url(parts[0]).toString('utf8'));
  const payload = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('algorithme');
  }

  let certs = await getCerts(false);
  let pem = certs[header.kid];

  if (!pem) {
    certs = await getCerts(true); // clés renouvelées par Google
    pem = certs[header.kid];
  }

  if (!pem) {
    throw new Error('clé inconnue');
  }

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey(pem),
    fromBase64Url(parts[2])
  );

  if (!valid) {
    throw new Error('signature');
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    payload.aud !== PROJECT_ID ||
    payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    payload.sub.length > 128 ||
    !(payload.exp > now) ||
    payload.iat > now + 300 ||
    payload.auth_time > now + 300
  ) {
    throw new Error('contenu');
  }

  return {
    uid: payload.sub,
    email: payload.email || '',
    emailVerified: payload.email_verified === true
  };
}

async function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ ok: false, code: 'auth', error: 'Connexion requise.' });
  }

  try {
    const user = await verifyIdToken(token);

    if (!user.email || !user.emailVerified) {
      return res.status(403).json({
        ok: false,
        code: 'email_not_verified',
        error: 'Adresse e-mail non vérifiée.'
      });
    }

    req.rewardUser = user;
    req.rewardToken = token;

    return next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      code: 'auth',
      error: 'Session invalide, reconnecte-toi.'
    });
  }
}

// ============================================================
// MIGRATION : reprise des points déjà cumulés dans Firebase (Firestore)
// ============================================================
// Pour un compte qui existait avant la mise à jour, le serveur lit une seule
// fois son ancien cumul dans Firestore (avec le jeton de l'élève, donc avec
// les règles de sécurité normales) et l'ajoute à son solde. Si la lecture
// échoue (réseau, règles), rien n'est marqué : on réessaiera à la prochaine
// connexion.

const migrations = new Map(); // uid -> promesse en cours (évite un double crédit)

function readFirestoreNumber(field) {
  if (!field || typeof field !== 'object') return null;

  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return Number(field.doubleValue);
  if (field.stringValue !== undefined && field.stringValue.trim() !== '') {
    return Number(field.stringValue);
  }

  return null;
}

async function fetchLegacyPoints(uid, token) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/databases/${encodeURIComponent(LEGACY_DATABASE_ID)}/documents/` +
    `${encodeURIComponent(LEGACY_COLLECTION)}/${encodeURIComponent(uid)}`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
    validateStatus: () => true
  });

  if (response.status === 404) {
    return { found: false, points: 0 };
  }

  if (response.status !== 200) {
    const detail =
      response.data && response.data.error && response.data.error.message
        ? response.data.error.message
        : '';

    throw new Error(`Firestore HTTP ${response.status}${detail ? ' – ' + detail : ''}`);
  }

  const fields = (response.data && response.data.fields) || {};

  for (const name of LEGACY_FIELDS) {
    const value = readFirestoreNumber(fields[name]);

    if (Number.isFinite(value) && value >= 0) {
      return { found: true, points: Math.floor(value), field: name };
    }
  }

  return { found: true, points: 0, fieldNames: Object.keys(fields) };
}

function setLegacyStatus(user, status, message) {
  user.legacyStatus = status;
  user.legacyMessage = message;
}

async function migrateLegacyPoints(req, res, next) {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);

  // Comptes migrés par l'ancienne version avec 0 point : on refait une lecture, une seule fois
  if (user.legacyMigrated && !user.legacyVersion) {
    if ((user.legacyPoints || 0) > 0) {
      user.legacyVersion = 2;
      saveState();
    } else {
      user.legacyMigrated = false;
    }
  }

  if (user.legacyMigrated) {
    return next();
  }

  try {
    if (!migrations.has(uid)) {
      migrations.set(
        uid,
        fetchLegacyPoints(uid, req.rewardToken).finally(() => migrations.delete(uid))
      );
    }

    const legacy = await migrations.get(uid);

    // Un autre appel simultané a pu terminer la migration entre-temps
    if (!user.legacyMigrated) {
      const finalize = () => {
        user.points += legacy.points;
        user.legacyPoints = legacy.points;
        user.legacyMigrated = true;
        user.legacyVersion = 2;
        user.legacyMigratedAt = new Date().toISOString();
      };

      if (legacy.found && legacy.field) {
        finalize();
        setLegacyStatus(user, 'ok', `${legacy.points} points repris depuis ${LEGACY_COLLECTION}/${legacy.field}`);
      } else {
        // Document ou champ introuvable : on réessaie 3 fois avant de conclure « 0 point »
        user.legacyAttempts = (user.legacyAttempts || 0) + 1;

        setLegacyStatus(
          user,
          legacy.found ? 'nofield' : 'notfound',
          legacy.found
            ? `Aucun champ de points trouvé (champs vus : ${(legacy.fieldNames || []).join(', ') || 'aucun'})`
            : `Document ${LEGACY_COLLECTION}/${uid} introuvable (base « ${LEGACY_DATABASE_ID} »)`
        );

        if (user.legacyAttempts >= 3) {
          finalize();
        }
      }

      audit({
        type: 'legacy_import',
        uid,
        email: user.email,
        points: legacy.points,
        field: legacy.field || null,
        found: legacy.found,
        status: user.legacyStatus
      });

      saveState();
    }
  } catch (error) {
    // On ne bloque pas l'élève et on ne marque rien : nouvel essai à la prochaine requête
    console.error(`⚠️ Reprise des anciens points impossible (${uid}) :`, error.message);
    setLegacyStatus(user, 'error', error.message);
    saveState();
  }

  return next();
}

// ============================================================
// QUIZ : le serveur garde les bonnes réponses
// ============================================================

const quizzes = new Map(); // quizId -> { uid, videoId, questions, key, createdAt, used }

const ANSWER_FIELDS = [
  'correctAnswer',
  'answer',
  'correct',
  'correctIndex',
  'correctChoice',
  'solution',
  'explanation'
];

function purgeQuizzes() {
  const now = Date.now();

  for (const [id, quiz] of quizzes) {
    if (now - quiz.createdAt > QUIZ_TTL_MS) {
      quizzes.delete(id);
    }
  }

  // Garde-fou mémoire : on retire les plus anciens
  while (quizzes.size > MAX_OPEN_QUIZZES) {
    quizzes.delete(quizzes.keys().next().value);
  }
}

function normalizeVideoId(value) {
  const id = String(value || '').trim();

  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
}

function limitError(user) {
  return {
    ok: false,
    code: 'daily_limit',
    error: `Limite atteinte : ${state.config.dailyVideoLimit} vidéos par jour. Reviens demain !`,
    limit: state.config.dailyVideoLimit,
    used: todayCount(user)
  };
}

// Se place devant /api/youtube/questions : vérifie l'élève, applique la limite du jour,
// puis retire les bonnes réponses de la réponse envoyée au navigateur.
const quizGate = [
  requireUser,

  (req, res, next) => {
    const videoId = normalizeVideoId((req.body && req.body.videoId) || req.query.videoId);

    if (!videoId) {
      return res.status(400).json({ ok: false, error: 'Identifiant de vidéo invalide.' });
    }

    const uid = req.rewardUser.uid;
    const user = getUser(uid, req.rewardUser.email);

    const alreadyToday = () => {
      const day = user.days[dayKey()];

      return Boolean(day && day.videos.includes(videoId));
    };

    // Contrôle AVANT de générer les questions (évite un appel payant inutile)
    if (!alreadyToday() && todayCount(user) >= state.config.dailyVideoLimit) {
      return res.status(429).json(limitError(user));
    }

    const sendJson = res.json.bind(res);

    res.json = body => {
      if (
        !(body && body.ok === true && Array.isArray(body.questions) && body.questions.length > 0)
      ) {
        return sendJson(body);
      }

      // Nouveau contrôle : une autre partie a pu être lancée entre-temps
      if (!alreadyToday() && todayCount(user) >= state.config.dailyVideoLimit) {
        res.status(429);

        return sendJson(limitError(user));
      }

      const questions = body.questions.slice(0, QUIZ_QUESTION_COUNT);

      const today = dayKey();

      if (!user.days[today]) {
        user.days[today] = { videos: [] };
      }

      if (!user.days[today].videos.includes(videoId)) {
        user.days[today].videos.push(videoId);
      }

      // On ne garde que les 40 derniers jours
      Object.keys(user.days)
        .sort()
        .slice(0, -40)
        .forEach(key => delete user.days[key]);

      saveState();

      purgeQuizzes();

      const quizId = crypto.randomBytes(16).toString('hex');

      quizzes.set(quizId, {
        uid,
        videoId,
        questions,
        key: questions.map(question => question.correctAnswer),
        createdAt: Date.now(),
        used: false
      });

      const hidden = questions.map(question => {
        const copy = { ...question };

        ANSWER_FIELDS.forEach(field => delete copy[field]);

        return copy;
      });

      return sendJson({
        ...body,
        questions: hidden,
        quizId,
        rewardEligible: !user.plays[videoId],
        daily: { used: todayCount(user), limit: state.config.dailyVideoLimit }
      });
    };

    return next();
  }
];

// ============================================================
// MOYENS DE RETRAIT : validation des coordonnées, e-mails, PayPal
// ============================================================

const PAYOUT_METHODS = {
  card: 'Carte bancaire (Stripe)',
  paypal: 'PayPal',
  cash: 'Western Union / Wafacash'
};

const CASH_NETWORKS = {
  western_union: 'Western Union',
  wafacash: 'Wafacash'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanText(value, min, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  return text.length >= min && text.length <= max ? text : null;
}

function payoutError(code, error) {
  return { error: { code, error } };
}

// Vérifie les coordonnées envoyées par l'élève selon le moyen choisi
function buildPayout(body, user) {
  const method = String((body && body.method) || '');

  if (!PAYOUT_METHODS[method]) {
    return payoutError('payout_method', 'Choisis un moyen de paiement.');
  }

  const fullName = cleanText(body.fullName, 2, 80);
  const country = cleanText(body.country, 2, 60);

  if (!fullName || !country) {
    return payoutError('payout_info', 'Indique ton nom complet et ton pays.');
  }

  const payout = { method, fullName, country };

  if (method === 'paypal') {
    const email = cleanText(body.paypalEmail, 5, 120);

    if (!email || !EMAIL_RE.test(email)) {
      return payoutError('payout_info', 'Indique l’e-mail de ton compte PayPal.');
    }

    payout.paypalEmail = email.toLowerCase();
  }

  if (method === 'card') {
    const email = cleanText(body.contactEmail, 5, 120) || user.email;

    if (!email || !EMAIL_RE.test(email)) {
      return payoutError('payout_info', 'Indique une adresse e-mail de contact valide.');
    }

    payout.contactEmail = email.toLowerCase();
  }

  if (method === 'cash') {
    const network = String(body.network || '');
    const phone = cleanText(body.phone, 6, 25);
    const city = cleanText(body.city, 2, 60);

    if (!CASH_NETWORKS[network]) {
      return payoutError('payout_info', 'Choisis Western Union ou Wafacash.');
    }

    if (!phone || !/^[+0-9 ()-]{6,25}$/.test(phone) || !city) {
      return payoutError('payout_info', 'Indique ton téléphone (avec indicatif) et ta ville.');
    }

    if (!user.email || !EMAIL_RE.test(user.email)) {
      return payoutError('payout_info', 'Ton compte n’a pas d’adresse e-mail valide.');
    }

    payout.network = network;
    payout.phone = phone;
    payout.city = city;
    payout.deliveryEmail = user.email; // le code de retrait part vers l'e-mail vérifié du compte
  }

  const parts = [PAYOUT_METHODS[method], fullName, country];

  if (payout.paypalEmail) parts.push(payout.paypalEmail);
  if (payout.contactEmail) parts.push(payout.contactEmail);
  if (payout.network) parts.push(CASH_NETWORKS[payout.network], payout.city, payout.phone);

  return { payout, summary: parts.join(' · ') };
}

async function sendMail(to, subject, text) {
  if (!MAIL_ENABLED) {
    throw new Error('Envoi d’e-mails non configuré (RESEND_API_KEY et MAIL_FROM).');
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: MAIL_FROM, to: [to], subject, text },
      { headers: { Authorization: `Bearer ${RESEND_API_KEY}` }, timeout: 15000 }
    );
  } catch (error) {
    const detail =
      (error.response && error.response.data && error.response.data.message) || error.message;

    throw new Error(`E-mail non envoyé : ${detail}`);
  }
}

// Paiement PayPal automatique (identifiant de lot fixe = pas de double paiement)
async function paypalPayout(withdrawal) {
  try {
    const auth = await axios.post(`${PAYPAL_BASE}/v1/oauth2/token`, 'grant_type=client_credentials', {
      auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const reference = `withdrawal-${withdrawal.id}`;

    const response = await axios.post(
      `${PAYPAL_BASE}/v1/payments/payouts`,
      {
        sender_batch_header: {
          sender_batch_id: reference,
          email_subject: 'Tes gains AI Video Quiz',
          email_message: 'Voici le paiement de tes points AI Video Quiz.'
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: withdrawal.payout.paypalEmail,
            amount: { value: (withdrawal.amountCents / 100).toFixed(2), currency: 'USD' },
            note: 'AI Video Quiz',
            sender_item_id: reference
          }
        ]
      },
      { headers: { Authorization: `Bearer ${auth.data.access_token}` }, timeout: 20000 }
    );

    return response.data.batch_header.payout_batch_id;
  } catch (error) {
    const detail =
      (error.response && error.response.data && (error.response.data.message || error.response.data.error_description)) ||
      error.message;

    throw new Error(`PayPal : ${detail}`);
  }
}

function cashCodeEmail(withdrawal, code) {
  const payout = withdrawal.payout;
  const amount = (withdrawal.amountCents / 100).toFixed(2);

  return [
    `Bonjour ${payout.fullName},`,
    '',
    `Ta demande de retrait n°${withdrawal.id} (${amount} $) a été payée.`,
    '',
    `Réseau : ${CASH_NETWORKS[payout.network]}`,
    `Code de retrait : ${code}`,
    `Montant : ${amount} $ USD`,
    `Bénéficiaire : ${payout.fullName} (${payout.city}, ${payout.country})`,
    '',
    `Présente-toi dans une agence ${CASH_NETWORKS[payout.network]} avec une pièce d’identité au nom de ${payout.fullName}.`,
    'Ne communique ce code à personne d’autre.',
    '',
    'AI Video Quiz'
  ].join('\n');
}

// ============================================================
// ROUTES DE L'ÉLÈVE
// ============================================================

router.get('/api/rewards/me', requireUser, migrateLegacyPoints, (req, res) => {
  const user = getUser(req.rewardUser.uid, req.rewardUser.email);

  saveState();

  res.json(summarize(req.rewardUser.uid, user));
});

// Correction du quiz et crédit du point : uniquement ici
router.post('/api/rewards/submit', requireUser, migrateLegacyPoints, (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);

  const quiz = quizzes.get(String((req.body && req.body.quizId) || ''));

  if (!quiz || Date.now() - quiz.createdAt > QUIZ_TTL_MS) {
    return res.status(410).json({
      ok: false,
      code: 'quiz_expired',
      error: 'Ce quiz a expiré. Relance-le.'
    });
  }

  if (quiz.uid !== uid) {
    return res.status(403).json({ ok: false, error: 'Ce quiz ne t’appartient pas.' });
  }

  if (quiz.used) {
    return res.status(409).json({
      ok: false,
      code: 'already_submitted',
      error: 'Ce quiz a déjà été validé.'
    });
  }

  const answers = req.body && req.body.answers;

  if (
    !Array.isArray(answers) ||
    answers.length !== quiz.key.length ||
    !answers.every(item => Number.isInteger(item) && item >= 0 && item <= 3)
  ) {
    return res.status(400).json({ ok: false, error: 'Réponses invalides.' });
  }

  // Un quiz ne peut être validé qu'une fois
  quiz.used = true;

  const total = quiz.key.length;
  const correct = answers.filter((item, index) => item === quiz.key[index]).length;
  const needed = total >= QUIZ_QUESTION_COUNT ? QUIZ_PASS_THRESHOLD : total;
  const passed = correct >= needed;

  let awarded = false;
  let reason = '';

  if (user.plays[quiz.videoId]) {
    reason = 'already_played'; // une seule tentative rémunérée par vidéo
  } else {
    user.plays[quiz.videoId] = {
      at: new Date().toISOString(),
      correct,
      total,
      awarded: passed
    };

    if (passed) {
      user.points += 1;
      awarded = true;

      audit({ type: 'point', uid, email: user.email, videoId: quiz.videoId, correct, total });
    }
  }

  saveState();

  return res.json({
    ...summarize(uid, user),
    correct,
    total,
    needed,
    passed,
    awarded,
    reason,
    correctAnswers: quiz.key
  });
});

// Demande de retrait
router.post('/api/rewards/withdraw', requireUser, migrateLegacyPoints, (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);

  if (!state.config.withdrawalsEnabled) {
    return res.status(403).json({
      ok: false,
      code: 'withdrawals_disabled',
      error: 'Les retraits sont temporairement désactivés.'
    });
  }

  if (pendingWithdrawal(uid)) {
    return res.status(409).json({
      ok: false,
      code: 'pending',
      error: 'Une demande de retrait est déjà en cours de traitement.'
    });
  }

  const points = availablePoints(user);
  const amountCents = points * state.config.pointValueCents;

  if (amountCents < state.config.minWithdrawalCents) {
    return res.status(400).json({
      ok: false,
      code: 'below_minimum',
      error: 'Le montant minimum de retrait n’est pas atteint.'
    });
  }

  const built = buildPayout(req.body || {}, user);

  if (built.error) {
    return res.status(400).json({ ok: false, ...built.error });
  }

  const payoutInfo = built.summary;

  const withdrawal = {
    id: state.nextWithdrawalId++,
    uid,
    email: user.email,
    points,
    amountCents,
    payoutInfo,
    payout: built.payout,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  user.lockedPoints += points;
  state.withdrawals.push(withdrawal);

  audit({ type: 'withdrawal_requested', id: withdrawal.id, uid, email: user.email, points, amountCents });

  saveState();

  return res.json(summarize(uid, user));
});

// ============================================================
// ROUTES DE L'ADMINISTRATEUR
// ============================================================

const requireAdmin = adminGuard(false);

router.get('/api/rewards/admin/overview', requireAdmin, (req, res) => {
  const users = Object.values(state.users);
  const value = state.config.pointValueCents;

  const owedPoints = users.reduce(
    (sum, user) => sum + availablePoints(user) + user.lockedPoints,
    0
  );

  const pending = state.withdrawals.filter(item => item.status === 'pending');

  res.json({
    ok: true,
    config: publicConfig(),
    timeZone: TIME_ZONE,
    capabilities: { mail: MAIL_ENABLED, paypalAuto: PAYPAL_ENABLED },
    stats: {
      users: users.length,
      usersWithPoints: users.filter(user => user.points > 0).length,
      pointsEarned: users.reduce((sum, user) => sum + user.points, 0),
      owedCents: owedPoints * value,
      pendingCount: pending.length,
      pendingCents: pending.reduce((sum, item) => sum + item.amountCents, 0),
      paidCents: state.withdrawals
        .filter(item => item.status === 'paid')
        .reduce((sum, item) => sum + item.amountCents, 0)
    },
    withdrawals: state.withdrawals.slice(-200).reverse()
  });
});

router.post('/api/rewards/admin/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const next = { ...state.config };

  const integer = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max;

  if (body.withdrawalsEnabled !== undefined) {
    if (typeof body.withdrawalsEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Valeur invalide pour les retraits.' });
    }

    next.withdrawalsEnabled = body.withdrawalsEnabled;
  }

  if (body.pointValueCents !== undefined) {
    if (!integer(body.pointValueCents, 1, 1000)) {
      return res.status(400).json({ ok: false, error: 'Valeur du point invalide.' });
    }

    next.pointValueCents = body.pointValueCents;
  }

  if (body.minWithdrawalCents !== undefined) {
    if (!integer(body.minWithdrawalCents, 100, 1000000)) {
      return res.status(400).json({ ok: false, error: 'Minimum de retrait invalide.' });
    }

    next.minWithdrawalCents = body.minWithdrawalCents;
  }

  if (body.dailyVideoLimit !== undefined) {
    if (!integer(body.dailyVideoLimit, 1, 1000)) {
      return res.status(400).json({ ok: false, error: 'Limite par jour invalide.' });
    }

    next.dailyVideoLimit = body.dailyVideoLimit;
  }

  audit({ type: 'config', before: state.config, after: next });

  state.config = next;

  saveState();

  return res.json({ ok: true, config: publicConfig() });
});

// Relance la reprise des points Firebase d'un compte : l'import se refait à sa prochaine connexion
router.post('/api/rewards/admin/legacy-reset', requireAdmin, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const entry = Object.entries(state.users).find(([, item]) => String(item.email).toLowerCase() === email);

  if (!email || !entry) {
    return res.status(404).json({ ok: false, error: 'Aucun compte avec cet e-mail (il doit s’être connecté au moins une fois).' });
  }

  const [uid, user] = entry;

  // On retire seulement ce qui avait été importé : les points gagnés depuis restent
  user.points = Math.max(0, user.points - (user.legacyPoints || 0));
  user.legacyPoints = 0;
  user.legacyMigrated = false;
  user.legacyVersion = undefined;
  user.legacyAttempts = 0;
  setLegacyStatus(user, null, '');

  audit({ type: 'legacy_reset', uid, email: user.email });
  saveState();

  return res.json({ ok: true });
});

const resolving = new Set(); // demandes en cours de traitement (évite un double paiement)

router.post('/api/rewards/admin/withdrawals/:id', requireAdmin, async (req, res) => {
  const withdrawal = state.withdrawals.find(item => item.id === Number(req.params.id));

  if (!withdrawal) {
    return res.status(404).json({ ok: false, error: 'Demande introuvable.' });
  }

  if (withdrawal.status !== 'pending') {
    return res.status(409).json({ ok: false, error: 'Cette demande est déjà traitée.' });
  }

  const body = req.body || {};
  const action = body.action;

  if (action !== 'paid' && action !== 'rejected') {
    return res.status(400).json({ ok: false, error: 'Action invalide.' });
  }

  if (resolving.has(withdrawal.id)) {
    return res.status(409).json({ ok: false, error: 'Cette demande est en cours de traitement.' });
  }

  resolving.add(withdrawal.id);

  try {
    const payout = withdrawal.payout || {};

    if (action === 'paid') {
      if (payout.method === 'cash') {
        // Le code de retrait est envoyé à l'élève ; sans e-mail réussi, la demande reste en attente
        const code = String(body.code || '').trim();

        if (!/^[A-Za-z0-9 -]{4,40}$/.test(code)) {
          return res.status(400).json({ ok: false, error: 'Code de retrait invalide (4 à 40 caractères).' });
        }

        try {
          await sendMail(
            payout.deliveryEmail,
            `Ton code de retrait ${CASH_NETWORKS[payout.network]}`,
            cashCodeEmail(withdrawal, code)
          );
        } catch (error) {
          return res.status(502).json({ ok: false, error: error.message });
        }

        withdrawal.cashCode = code;
        withdrawal.codeSentAt = new Date().toISOString();
      } else if (payout.method === 'paypal' && body.auto === true) {
        if (!PAYPAL_ENABLED) {
          return res.status(400).json({ ok: false, error: 'PayPal automatique non configuré.' });
        }

        try {
          withdrawal.paypalBatchId = await paypalPayout(withdrawal);
        } catch (error) {
          return res.status(502).json({ ok: false, error: error.message });
        }
      }
    }

    const user = state.users[withdrawal.uid];

    if (user) {
      user.lockedPoints = Math.max(0, user.lockedPoints - withdrawal.points);

      if (action === 'paid') {
        user.withdrawnPoints += withdrawal.points;
      }
    }

    withdrawal.status = action;
    withdrawal.resolvedAt = new Date().toISOString();
    withdrawal.note = String(body.note || '').slice(0, 200);

    audit({
      type: `withdrawal_${action}`,
      id: withdrawal.id,
      uid: withdrawal.uid,
      amountCents: withdrawal.amountCents,
      method: payout.method || null,
      paypalBatchId: withdrawal.paypalBatchId || null,
      codeSent: Boolean(withdrawal.codeSentAt)
    });

    saveState();

    return res.json({ ok: true, withdrawal });
  } finally {
    resolving.delete(withdrawal.id);
  }
});

// ============================================================
// PAGE : PANNEAU ADMINISTRATEUR
// ============================================================

const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Panneau administrateur</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1c1f26; --muted:#6a7080; --line:#dfe3ea; --accent:#2457d6; --ok:#1c8a4a; --warn:#b26a00; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161b; --card:#1d2027; --text:#eceef3; --muted:#9aa1b2; --line:#2c303a; --accent:#6c93ff; --ok:#4cc27f; --warn:#e2a03f; --bad:#ef6a5b; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:760px; margin:0 auto; padding:16px; }
  h1 { font-size:1.5rem; margin:8px 0 4px; } h2 { font-size:1.1rem; margin:0 0 10px; }
  .muted { color:var(--muted); font-size:.9rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin:14px 0; }
  button { font:inherit; border:0; border-radius:10px; padding:11px 15px; background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button.danger { background:var(--bad); }
  button:disabled { opacity:.5; }
  input { font:inherit; width:100%; padding:10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  label { display:block; margin:10px 0 4px; font-size:.9rem; color:var(--muted); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .row > * { flex:1; min-width:120px; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  .stat { padding:10px; border:1px solid var(--line); border-radius:10px; }
  .stat b { display:block; font-size:1.2rem; }
  .switch { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .badge { padding:3px 10px; border-radius:99px; border:1px solid currentColor; font-size:.8rem; }
  .on { color:var(--ok); } .off { color:var(--bad); }
  .req { border-top:1px solid var(--line); padding:10px 0; font-size:.93rem; line-height:1.5; }
  .req .actions { display:flex; gap:8px; margin-top:8px; } .req .actions button { flex:1; }
  .msg { padding:9px 12px; border-radius:10px; margin:10px 0; border:1px solid var(--line); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Panneau administrateur</h1>
  <div class="muted">Récompenses et retraits · <a href="/ielts-app">Bibliothèque IELTS</a></div>

  <section id="loginBox">
    <h2>Connexion</h2>
    <input type="password" id="pass" placeholder="Mot de passe administrateur" autocomplete="current-password">
    <div class="row" style="margin-top:8px"><button id="loginBtn">Valider</button></div>
    <div class="muted" id="loginMsg" style="margin-top:8px"></div>
  </section>

  <div id="panel" hidden>
    <div class="msg" id="msg" hidden></div>

    <section>
      <div class="switch">
        <div><h2 style="margin:0">Retraits</h2><div class="muted" id="switchText"></div></div>
        <button id="toggleBtn"></button>
      </div>
    </section>

    <section>
      <h2>Réglages</h2>
      <label for="pointValue">Valeur d'un point (en dollars)</label>
      <input id="pointValue" type="number" step="0.01" min="0.01" max="10">
      <label for="minWithdrawal">Minimum de retrait (en dollars)</label>
      <input id="minWithdrawal" type="number" step="1" min="1" max="10000">
      <label for="dailyLimit">Vidéos jouées par jour et par élève</label>
      <input id="dailyLimit" type="number" step="1" min="1" max="1000">
      <div class="row" style="margin-top:12px"><button id="saveBtn">Enregistrer les réglages</button></div>
      <div class="muted" style="margin-top:8px">Un changement de la valeur du point s'applique aux soldes actuels. Le « jour » commence à minuit (<span id="tz"></span>).</div>
    </section>

    <section>
      <h2>Points Firebase (anciens comptes)</h2>
      <div class="muted">Si un élève ne voit pas ses anciens points, relance la reprise : elle se refait à sa prochaine connexion.</div>
      <label for="legacyEmail">E-mail du compte</label>
      <input id="legacyEmail" type="email" autocomplete="off">
      <div class="row" style="margin-top:8px"><button id="legacyBtn" class="secondary">Relancer la reprise</button></div>
    </section>

    <section>
      <h2>Résumé</h2>
      <div class="grid" id="stats"></div>
    </section>

    <section>
      <h2>Demandes en attente</h2>
      <div id="pending"></div>
    </section>

    <section>
      <h2>Historique</h2>
      <div id="history"></div>
    </section>

    <div class="row"><button class="secondary" id="logoutBtn">Se déconnecter</button></div>
  </div>
</main>
<script>
(function () {
  var KEY = null;
  try { KEY = localStorage.getItem('ieltsAdminKey'); } catch (e) {}
  var cfg = null;
  var caps = {};

  function $(id) { return document.getElementById(id); }
  function money(cents) { return '$' + (cents / 100).toFixed(2); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { if (k === 'text') n.textContent = props[k]; else if (k === 'class') n.className = props[k]; else n.setAttribute(k, props[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['x-admin-key'] = KEY || '';
    if (options.body && typeof options.body !== 'string') { options.body = JSON.stringify(options.body); options.headers['Content-Type'] = 'application/json'; }
    return fetch('/api/rewards/admin' + path, options).then(function (r) { return r.json(); });
  }
  function notice(text, bad) {
    var m = $('msg'); m.hidden = !text; m.textContent = text || ''; m.style.borderColor = bad ? 'var(--bad)' : 'var(--ok)';
    if (text) setTimeout(function () { m.hidden = true; }, 6000);
  }

  function render(data) {
    cfg = data.config;
    caps = data.capabilities || {};
    $('switchText').textContent = cfg.withdrawalsEnabled ? 'Les élèves peuvent demander un retrait.' : 'Le bouton « Retirer » est désactivé pour tous les élèves.';
    var t = $('toggleBtn');
    t.textContent = cfg.withdrawalsEnabled ? 'Désactiver les retraits' : 'Activer les retraits';
    t.className = cfg.withdrawalsEnabled ? 'danger' : '';
    $('pointValue').value = (cfg.pointValueCents / 100).toFixed(2);
    $('minWithdrawal').value = Math.round(cfg.minWithdrawalCents / 100);
    $('dailyLimit').value = cfg.dailyVideoLimit;
    $('tz').textContent = data.timeZone;

    var s = data.stats, stats = $('stats'); stats.innerHTML = '';
    [['Élèves inscrits', s.users], ['Élèves avec des points', s.usersWithPoints], ['Points gagnés (total)', s.pointsEarned],
     ['Dû aux élèves', money(s.owedCents)], ['En attente de paiement', s.pendingCount + ' · ' + money(s.pendingCents)], ['Déjà payé', money(s.paidCents)]]
      .forEach(function (x) { stats.appendChild(el('div', { class: 'stat' }, [el('b', { text: String(x[1]) }), el('span', { class: 'muted', text: x[0] })])); });

    var pending = $('pending'), history = $('history'); pending.innerHTML = ''; history.innerHTML = '';
    var any = false;
    data.withdrawals.forEach(function (w) {
      var when = new Date(w.createdAt).toLocaleString();
      var p = w.payout || {};
      var NAMES = { card: 'Carte bancaire (Stripe)', paypal: 'PayPal', cash: 'Western Union / Wafacash' };
      var lines = [el('div', { text: '#' + w.id + ' · ' + w.email + ' · ' + money(w.amountCents) + ' (' + w.points + ' points)' })];
      if (p.method) {
        lines.push(el('div', { text: 'Moyen : ' + (NAMES[p.method] || p.method) + (p.network ? ' (' + (p.network === 'wafacash' ? 'Wafacash' : 'Western Union') + ')' : '') }));
        lines.push(el('div', { class: 'muted', text: 'Bénéficiaire : ' + p.fullName + ' · ' + (p.city ? p.city + ', ' : '') + p.country }));
        if (p.paypalEmail) lines.push(el('div', { class: 'muted', text: 'E-mail PayPal : ' + p.paypalEmail }));
        if (p.contactEmail) lines.push(el('div', { class: 'muted', text: 'E-mail de contact : ' + p.contactEmail }));
        if (p.phone) lines.push(el('div', { class: 'muted', text: 'Téléphone : ' + p.phone + ' · code envoyé à : ' + p.deliveryEmail }));
        lines.push(el('div', { class: 'muted', text: when }));
      } else {
        lines.push(el('div', { class: 'muted', text: 'Paiement : ' + w.payoutInfo + ' · ' + when }));
      }
      if (w.status === 'pending') {
        any = true;
        var rej = el('button', { class: 'secondary', text: 'Refuser' });
        rej.addEventListener('click', function () { resolve(w, 'rejected', 'manual'); });
        var buttons = [];
        if (p.method === 'cash') {
          var send = el('button', { text: caps.mail ? 'Envoyer le code et marquer payé' : 'E-mail non configuré' });
          send.disabled = !caps.mail;
          send.addEventListener('click', function () { resolve(w, 'paid', 'cash'); });
          buttons.push(send);
        } else if (p.method === 'paypal' && caps.paypalAuto) {
          var auto = el('button', { text: 'Payer via PayPal' });
          auto.addEventListener('click', function () { resolve(w, 'paid', 'paypal-auto'); });
          buttons.push(auto);
          var man = el('button', { class: 'secondary', text: 'Déjà payé à la main' });
          man.addEventListener('click', function () { resolve(w, 'paid', 'manual'); });
          buttons.push(man);
        } else {
          var paid = el('button', { text: 'Marquer payé' });
          paid.addEventListener('click', function () { resolve(w, 'paid', 'manual'); });
          buttons.push(paid);
        }
        buttons.push(rej);
        lines.push(el('div', { class: 'actions' }, buttons));
        pending.appendChild(el('div', { class: 'req' }, lines));
      } else {
        lines.push(el('div', { class: w.status === 'paid' ? 'on' : 'off', text: (w.status === 'paid' ? 'Payé' : 'Refusé') + (w.note ? ' · ' + w.note : '') }));
        history.appendChild(el('div', { class: 'req' }, lines));
      }
    });
    if (!any) pending.appendChild(el('div', { class: 'muted', text: 'Aucune demande en attente.' }));
    if (!history.firstChild) history.appendChild(el('div', { class: 'muted', text: 'Rien pour le moment.' }));
  }

  function resolve(w, action, mode) {
    var body = { action: action };
    if (action === 'rejected') {
      if (!confirm('Refuser cette demande ? Les points reviennent à l’élève.')) return;
      body.note = prompt('Motif (facultatif)') || '';
    } else if (mode === 'cash') {
      var code = prompt('Code de retrait ' + (w.payout.network === 'wafacash' ? 'Wafacash' : 'Western Union') + ' (il sera envoyé par e-mail à ' + w.payout.deliveryEmail + ')');
      if (!code) return;
      body.code = code.trim();
    } else if (mode === 'paypal-auto') {
      if (!confirm('Envoyer ' + money(w.amountCents) + ' à ' + w.payout.paypalEmail + ' via PayPal ?')) return;
      body.auto = true;
    } else if (!confirm('Confirmer que tu as payé cette demande ?')) {
      return;
    }
    api('/withdrawals/' + w.id, { method: 'POST', body: body }).then(function (r) {
      notice(r.ok ? 'Demande mise à jour.' : (r.error || 'Erreur'), !r.ok); load();
    });
  }

  function load() {
    return api('/overview').then(function (data) {
      if (!data.ok) {
        $('panel').hidden = true; $('loginBox').hidden = false;
        $('loginMsg').textContent = data.error || 'Accès refusé.';
        return;
      }
      $('loginBox').hidden = true; $('panel').hidden = false; render(data);
    }).catch(function () { $('loginMsg').textContent = 'Connexion impossible.'; });
  }

  $('loginBtn').addEventListener('click', function () {
    var v = $('pass').value; if (!v) return;
    KEY = v; $('loginMsg').textContent = 'Vérification…';
    api('/overview').then(function (data) {
      if (data.ok) { try { localStorage.setItem('ieltsAdminKey', v); } catch (e) {} $('pass').value = ''; $('loginMsg').textContent = ''; $('loginBox').hidden = true; $('panel').hidden = false; render(data); }
      else { KEY = null; $('loginMsg').textContent = data.error || 'Mot de passe incorrect.'; }
    });
  });
  $('pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });

  $('legacyBtn').addEventListener('click', function () {
    var email = $('legacyEmail').value.trim();
    if (!email) return;
    api('/legacy-reset', { method: 'POST', body: { email: email } }).then(function (r) {
      notice(r.ok ? 'Reprise relancée : l’élève doit se reconnecter (ou recharger la page).' : (r.error || 'Erreur'), !r.ok);
    });
  });

  $('toggleBtn').addEventListener('click', function () {
    var next = !cfg.withdrawalsEnabled;
    if (!confirm(next ? 'Réactiver les retraits pour tous les élèves ?' : 'Désactiver le bouton « Retirer » pour tous les élèves ?')) return;
    api('/config', { method: 'POST', body: { withdrawalsEnabled: next } }).then(function (r) { notice(r.ok ? 'Réglage enregistré.' : (r.error || 'Erreur'), !r.ok); load(); });
  });

  $('saveBtn').addEventListener('click', function () {
    var body = {
      pointValueCents: Math.round(parseFloat($('pointValue').value) * 100),
      minWithdrawalCents: Math.round(parseFloat($('minWithdrawal').value) * 100),
      dailyVideoLimit: parseInt($('dailyLimit').value, 10)
    };
    api('/config', { method: 'POST', body: body }).then(function (r) { notice(r.ok ? 'Réglages enregistrés.' : (r.error || 'Erreur'), !r.ok); load(); });
  });

  $('logoutBtn').addEventListener('click', function () {
    KEY = null; try { localStorage.removeItem('ieltsAdminKey'); } catch (e) {}
    $('panel').hidden = true; $('loginBox').hidden = false;
  });

  if (KEY) load();
})();
</script>
</body>
</html>`;

router.get('/admin', (req, res) => {
  res.type('html').send(ADMIN_PAGE);
});

module.exports = router;

// Utilisé par server.js : protège /api/youtube/questions
module.exports.quizGate = quizGate;
