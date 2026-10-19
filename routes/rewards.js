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
const library = require('./quizLibrary');

// Clé interne (secrète, propre à ce démarrage) : permet au serveur d'appeler sa recherche et sa
// génération de quiz pour l'administrateur, sans passer par un élève connecté.
const INTERNAL_KEY = process.env.LIBRARY_INTERNAL_KEY || crypto.randomBytes(24).toString('hex');
process.env.LIBRARY_INTERNAL_KEY = INTERNAL_KEY;

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

// Stripe (clé secrète « sk_test_… » en mode test, « sk_live_… » en production)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_ENABLED = Boolean(STRIPE_SECRET_KEY);
const STRIPE_TEST = STRIPE_SECRET_KEY.startsWith('sk_test_');

// Adresses autorisées pour revenir sur la page de l'élève après un paiement
const FRONTEND_ORIGINS = (process.env.FRONTEND_URLS || 'https://musrh.github.io')
  .split(',')
  .map(item => item.trim().replace(/\/+$/, ''))
  .filter(Boolean);

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
  withdrawalsEnabled: true, // interrupteur général des retraits
  libraryFirst: true, // servir d'abord les quiz approuvés de la bibliothèque (aucun appel API)
  liveFallback: false, // fermée par défaut : la recherche et la génération en direct coûtent des appels API
  liveFallbackChosen: false, // devient vrai dès que l'administrateur a lui-même ouvert ou fermé l'interrupteur
  depositCents: 500, // dépôt de garantie du mode récompense : 5 $
  depositRefundDays: 3, // délai de remboursement quand l'élève quitte le mode récompense
  depositInstructions: '', // comment payer le dépôt (affiché aux élèves)
  // Moyens de paiement du dépôt, activés ou désactivés par l'administrateur
  depositMethods: { stripe: true, paypal: true, rib: true, western_union: true, wafacash: true }
};

// ============================================================
// SAUVEGARDE (fichier JSON + journal des opérations)
// ============================================================

let state = {
  config: { ...DEFAULT_CONFIG },
  users: {}, // uid -> { email, points, lockedPoints, withdrawnPoints, plays, days, createdAt }
  withdrawals: [],
  nextWithdrawalId: 1,
  payments: {}, // identifiant de paiement Stripe/PayPal -> uid (un paiement ne sert qu'une fois)
  depositLog: [] // journal des dépôts : reçus, refusés, remboursés
};

// Journal des dépôts de garantie (affiché dans l'historique de /admin)
function logDeposit(type, uid, user, extra) {
  const deposit = user.deposit || {};

  state.depositLog.push({
    at: new Date().toISOString(),
    type,
    uid,
    email: user.email,
    provider: deposit.provider || 'manual',
    payMethod: deposit.payMethod,
    payerName: deposit.payerName,
    reference: deposit.reference || deposit.paymentId,
    amountCents: deposit.amountCents,
    ...(extra || {})
  });
}

// Reconstitue le journal à partir des dépôts déjà enregistrés (première mise à jour seulement)
function backfillDepositLog() {
  const log = [];

  Object.entries(state.users).forEach(([uid, user]) => {
    const deposit = user.deposit;

    if (!deposit) return;

    const base = {
      uid,
      email: user.email,
      provider: deposit.provider || 'manual',
      payMethod: deposit.payMethod,
      payerName: deposit.payerName,
      reference: deposit.reference || deposit.paymentId,
      amountCents: deposit.amountCents
    };

    if (deposit.confirmedAt) log.push({ ...base, type: 'received', at: deposit.confirmedAt });
    if (deposit.status === 'rejected' && deposit.declaredAt) log.push({ ...base, type: 'rejected', at: deposit.declaredAt });
    if (deposit.refundedAt) log.push({ ...base, type: 'refunded', at: deposit.refundedAt });
  });

  return log;
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

      state = {
        config: { ...DEFAULT_CONFIG, ...(raw.config || {}) },
        users: raw.users || {},
        withdrawals: raw.withdrawals || [],
        nextWithdrawalId: raw.nextWithdrawalId || 1,
        payments: raw.payments || {},
        depositLog: raw.depositLog || null
      };

      if (!state.depositLog) {
        state.depositLog = backfillDepositLog();
      }

      // La recherche en direct reste fermée tant que l'administrateur ne l'a pas choisie lui-même
      if (!state.config.liveFallbackChosen) {
        state.config.liveFallback = false;
      }
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

// Moyens de paiement du dépôt payés à la main (confirmés ensuite par l'administrateur)
const MANUAL_DEPOSIT_METHODS = {
  rib: 'Virement / RIB',
  western_union: 'Western Union',
  wafacash: 'Wafacash'
};

const DEPOSIT_METHOD_KEYS = ['stripe', 'paypal', 'rib', 'western_union', 'wafacash'];

function methodEnabled(key) {
  const flags = state.config.depositMethods || {};

  return flags[key] !== false;
}

// Utilisable = activé par l'administrateur ET (pour Stripe / PayPal) configuré sur le serveur
function methodAvailable(key) {
  if (key === 'stripe') return STRIPE_ENABLED && methodEnabled(key);
  if (key === 'paypal') return PAYPAL_ENABLED && methodEnabled(key);

  return methodEnabled(key);
}

// Mode récompense actif : l'élève a choisi ce mode et son dépôt est confirmé
// (statuts du dépôt : pending, held, refunding, leaving, refunded, rejected)
function rewardActive(user) {
  return (
    user.mode === 'reward' &&
    Boolean(user.deposit) &&
    ['held', 'refunding', 'refunded'].includes(user.deposit.status)
  );
}

function depositBusy(user) {
  return rewardActive(user) || Boolean(user.deposit && ['pending', 'leaving'].includes(user.deposit.status));
}

function pendingWithdrawal(uid) {
  return state.withdrawals.find(item => item.uid === uid && item.status === 'pending');
}

function todayCount(user) {
  const day = user.days[dayKey()];

  return day ? day.videos.length : 0;
}

function publicConfig() {
  const {
    pointValueCents,
    minWithdrawalCents,
    dailyVideoLimit,
    withdrawalsEnabled,
    depositCents,
    depositRefundDays,
    depositInstructions,
    libraryFirst,
    liveFallback
  } = state.config;

  return {
    pointValueCents,
    minWithdrawalCents,
    dailyVideoLimit,
    withdrawalsEnabled,
    depositCents,
    depositRefundDays,
    depositInstructions,
    libraryFirst,
    liveFallback,
    depositProviders: { stripe: STRIPE_ENABLED, stripeTest: STRIPE_TEST, paypal: PAYPAL_ENABLED },
    depositMethods: Object.fromEntries(DEPOSIT_METHOD_KEYS.map(key => [key, methodAvailable(key)])),
    depositMethodFlags: Object.fromEntries(DEPOSIT_METHOD_KEYS.map(key => [key, methodEnabled(key)]))
  };
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
      type: item.type || 'withdrawal',
      depositCents: item.depositCents || 0,
      dueBy: item.dueBy || null,
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
      mode: user.mode || null,
      blocked: Boolean(user.blocked),
      rewardActive: rewardActive(user),
      deposit: {
        status: user.deposit ? user.deposit.status : null,
        provider: user.deposit ? user.deposit.provider || 'manual' : null,
        heldCents:
          user.deposit && ['held', 'refunding', 'leaving'].includes(user.deposit.status)
            ? user.deposit.amountCents
            : 0,
        refundDueBy: user.deposit ? user.deposit.refundDueBy || null : null
      },
      withdrawals: mine
    },
    config: publicConfig(),
    legacy: { status: user.legacyStatus || null, message: user.legacyMessage || '' },
    today: { used: todayCount(user), limit: state.config.dailyVideoLimit },
    canWithdraw:
      state.config.withdrawalsEnabled &&
      !user.blocked &&
      rewardActive(user) &&
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

    const record = getUser(user.uid, user.email);

    // Dernière activité (enregistrée au plus toutes les 10 minutes)
    if (!record.lastSeenAt || Date.now() - Date.parse(record.lastSeenAt) > 10 * 60 * 1000) {
      record.lastSeenAt = new Date().toISOString();
      saveState();
    }

    // Compte bloqué par l'administrateur : seule la lecture du solde reste possible (pour afficher le message)
    const isMe = req.method === 'GET' && String(req.originalUrl || '').split('?')[0] === '/api/rewards/me';

    if (record.blocked && !isMe) {
      return res.status(403).json({
        ok: false,
        code: 'account_blocked',
        error: 'Ton compte est bloqué. Contacte l’administrateur.'
      });
    }

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
          setLegacyStatus(user, 'ok', 'Aucun ancien compte à reprendre');
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

// Mémorise les vidéos déjà vues par l'élève (au plus 3000, les plus anciennes sont oubliées)
function pruneSeen(user) {
  const ids = Object.keys(user.seen || {});

  if (ids.length <= 3000) return;

  ids
    .sort((a, b) => String(user.seen[a]).localeCompare(String(user.seen[b])))
    .slice(0, ids.length - 3000)
    .forEach(id => delete user.seen[id]);
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
  (req, res, next) => {
    // Appel interne de l'administrateur (génération d'un quiz pour la bibliothèque)
    const sent = String(req.get('x-internal-library') || '');

    if (sent.length === INTERNAL_KEY.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(INTERNAL_KEY))) {
      req.libraryInternal = true;

      return next();
    }

    return requireUser(req, res, next);
  },

  (req, res, next) => {
    if (req.libraryInternal) return next();

    const videoId = normalizeVideoId((req.body && req.body.videoId) || req.query.videoId);

    if (!videoId) {
      return res.status(400).json({ ok: false, error: 'Identifiant de vidéo invalide.' });
    }

    const uid = req.rewardUser.uid;
    const user = getUser(uid, req.rewardUser.email);

    const language = String((req.body && req.body.language) || req.query.language || 'fr').trim().toLowerCase();
    const category = String((req.body && req.body.category) || req.query.category || '').trim().slice(0, 60);

    // Préparation IELTS : elle garde son fonctionnement d'origine (génération en direct à chaque fois).
    // La bibliothèque, la mémoire des vidéos vues et la fermeture de la recherche ne la concernent pas.
    const ielts = String((req.body && req.body.mode) || req.query.mode || '').trim().toLowerCase() === 'ielts';

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

      // Vidéo désormais vue : l'élève ne la reverra plus. Un quiz généré en direct est gardé
      // « à valider » : l'administrateur pourra l'approuver et il resservira sans coût.
      if (!ielts) {
        user.seen = user.seen || {};
        user.seen[videoId] = dayKey();
        pruneSeen(user);

        if (!body.fromLibrary) {
          library.capture({ videoId, language, category, video: body.video, questions });
        }
      }

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

    // Quiz déjà approuvé : on le sert directement, sans aucun appel à YouTube, à la transcription ni à Claude
    const cached = ielts ? null : library.findApproved(videoId, language);

    if (cached) {
      library.markServed(cached.id);

      return res.json({
        ok: true,
        videoId,
        language,
        fromLibrary: true,
        video: { title: cached.title, channelTitle: cached.channelTitle, duration: cached.duration },
        questions: cached.questions
      });
    }

    // Recherche en direct fermée : seules les vidéos de la bibliothèque sont disponibles
    if (!ielts && !state.config.liveFallback) {
      return res.status(403).json({
        ok: false,
        code: 'library_only',
        error: 'Cette vidéo n’est pas disponible pour le moment.'
      });
    }

    return next();
  }
];

// ============================================================
// MOYENS DE RETRAIT : validation des coordonnées, e-mails, PayPal
// ============================================================

const PAYOUT_METHODS = {
  card: 'Carte / virement bancaire',
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

    // RIB (24 chiffres au Maroc) ou IBAN : chiffres et lettres, espaces tolérés
    const account = cleanText(body.bankAccount, 10, 50);
    const compact = account ? account.replace(/\s+/g, '') : '';

    if (!account || !/^[A-Za-z0-9 ]+$/.test(account) || compact.length < 10 || compact.length > 34) {
      return payoutError('payout_info', 'Indique ton RIB ou ton IBAN (10 à 34 chiffres ou lettres).');
    }

    payout.contactEmail = email.toLowerCase();
    payout.bankAccount = compact.toUpperCase();
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
  if (payout.bankAccount) parts.push('RIB/IBAN ' + payout.bankAccount);
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
  } else if (!rewardActive(user)) {
    reason = 'no_reward_mode'; // jeu libre : on joue, mais sans points ni cumul
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

  if (!rewardActive(user)) {
    return res.status(403).json({
      ok: false,
      code: 'reward_mode_required',
      error: 'Les retraits sont réservés au mode récompense.'
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
  const pointsCents = points * state.config.pointValueCents;

  // Le dépôt de garantie est rendu avec le premier retrait
  const depositCents = user.deposit.status === 'held' ? user.deposit.amountCents : 0;
  const amountCents = pointsCents + depositCents;

  if (pointsCents < state.config.minWithdrawalCents) {
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
    depositCents,
    payoutInfo,
    payout: built.payout,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  if (depositCents > 0) {
    user.deposit.status = 'refunding';
  }

  user.lockedPoints += points;
  state.withdrawals.push(withdrawal);

  audit({ type: 'withdrawal_requested', id: withdrawal.id, uid, email: user.email, points, amountCents });

  saveState();

  return res.json(summarize(uid, user));
});

// ----- Paiement du dépôt par Stripe / PayPal -----

// Adresse de retour : seulement les sites autorisés (FRONTEND_URLS)
function safeReturnUrl(value) {
  try {
    const url = new URL(String(value || ''));

    if (!FRONTEND_ORIGINS.includes(url.origin)) return null;

    return url.origin + url.pathname;
  } catch (error) {
    return null;
  }
}

function gatewayError(prefix, error) {
  const data = error.response && error.response.data;
  const detail =
    (data && data.error && (data.error.message || data.error)) ||
    (data && (data.message || data.error_description)) ||
    error.message;

  return new Error(`${prefix} : ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function paypalToken() {
  const auth = await axios.post(`${PAYPAL_BASE}/v1/oauth2/token`, 'grant_type=client_credentials', {
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });

  return auth.data.access_token;
}

async function stripeCall(method, path, form) {
  const config = {
    method,
    url: `https://api.stripe.com/v1/${path}`,
    auth: { username: STRIPE_SECRET_KEY, password: '' },
    timeout: 20000
  };

  if (form) {
    config.data = new URLSearchParams(form).toString();
    config.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  return axios(config);
}

const confirming = new Set();

router.post('/api/rewards/deposit/checkout', requireUser, async (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);
  const provider = String((req.body && req.body.provider) || '');
  const base = safeReturnUrl(req.body && req.body.returnUrl);

  if (!state.config.withdrawalsEnabled) {
    return res.status(403).json({
      ok: false,
      code: 'reward_unavailable',
      error: 'Le mode récompense n’est pas encore disponible.'
    });
  }

  if (depositBusy(user)) {
    return res.status(409).json({ ok: false, code: 'deposit_exists', error: 'Tu as déjà un dépôt en cours ou un mode récompense actif.' });
  }

  if (!base) {
    return res.status(400).json({ ok: false, error: 'Adresse de retour non autorisée.' });
  }

  const cents = state.config.depositCents;

  try {
    if (provider === 'stripe' && methodAvailable('stripe')) {
      const session = await stripeCall('post', 'checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': 'Dépôt de garantie AI Video Quiz',
        'line_items[0][quantity]': '1',
        success_url: `${base}?deposit=stripe&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}?deposit=cancel`,
        client_reference_id: uid,
        customer_email: user.email,
        'metadata[uid]': uid
      });

      return res.json({ ok: true, url: session.data.url });
    }

    if (provider === 'paypal' && methodAvailable('paypal')) {
      const token = await paypalToken();

      const order = await axios.post(
        `${PAYPAL_BASE}/v2/checkout/orders`,
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              custom_id: uid,
              description: 'Dépôt de garantie AI Video Quiz',
              amount: { currency_code: 'USD', value: (cents / 100).toFixed(2) }
            }
          ],
          application_context: {
            brand_name: 'AI Video Quiz',
            user_action: 'PAY_NOW',
            return_url: `${base}?deposit=paypal`,
            cancel_url: `${base}?deposit=cancel`
          }
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
      );

      const link = (order.data.links || []).find(item => item.rel === 'approve' || item.rel === 'payer-action');

      if (!link) throw new Error('Lien de paiement PayPal introuvable.');

      return res.json({ ok: true, url: link.href });
    }
  } catch (error) {
    const wrapped = gatewayError(provider === 'stripe' ? 'Stripe' : 'PayPal', error);
    console.error('⚠️ Paiement du dépôt :', wrapped.message);

    return res.status(502).json({ ok: false, error: 'Paiement indisponible pour le moment. Réessaie plus tard.' });
  }

  return res.status(403).json({
    ok: false,
    code: 'method_disabled',
    error: 'Ce moyen de paiement est désactivé pour le moment.'
  });
});

// Après le retour de Stripe / PayPal : le serveur vérifie lui-même le paiement chez le fournisseur
router.post('/api/rewards/deposit/confirm', requireUser, async (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);
  const provider = String((req.body && req.body.provider) || '');
  const id = String((req.body && req.body.id) || '').trim();

  if (!id || id.length > 200 || !/^[A-Za-z0-9_\-]+$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'Paiement introuvable.' });
  }

  const key = `${provider}:${id}`;

  // Même paiement présenté deux fois (rechargement de la page) : on répond sans rien recréditer
  if (state.payments[key] === uid && user.deposit && user.deposit.paymentId === id) {
    return res.json(summarize(uid, user));
  }

  if (state.payments[key]) {
    return res.status(409).json({ ok: false, error: 'Ce paiement a déjà été utilisé.' });
  }

  if (depositBusy(user)) {
    return res.status(409).json({ ok: false, code: 'deposit_exists', error: 'Tu as déjà un dépôt en cours ou un mode récompense actif.' });
  }

  if (confirming.has(key)) {
    return res.status(409).json({ ok: false, error: 'Vérification en cours, réessaie dans un instant.' });
  }

  confirming.add(key);

  try {
    let amountCents = 0;
    let refundRef = '';

    if (provider === 'stripe' && STRIPE_ENABLED) {
      const session = (await stripeCall('get', `checkout/sessions/${id}`)).data;

      if (session.payment_status !== 'paid' || !session.metadata || session.metadata.uid !== uid || session.currency !== 'usd') {
        return res.status(402).json({ ok: false, error: 'Paiement non confirmé par Stripe.' });
      }

      amountCents = session.amount_total;
      refundRef = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || '';
    } else if (provider === 'paypal' && PAYPAL_ENABLED) {
      const token = await paypalToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      let order;

      try {
        order = (await axios.post(`${PAYPAL_BASE}/v2/checkout/orders/${id}/capture`, {}, { headers, timeout: 20000 })).data;
      } catch (error) {
        const issues = (error.response && error.response.data && error.response.data.details) || [];

        if (!issues.some(item => item.issue === 'ORDER_ALREADY_CAPTURED')) throw error;

        order = (await axios.get(`${PAYPAL_BASE}/v2/checkout/orders/${id}`, { headers, timeout: 20000 })).data;
      }

      const unit = (order.purchase_units || [])[0] || {};
      const capture = ((unit.payments || {}).captures || [])[0] || {};

      if (order.status !== 'COMPLETED' || capture.status !== 'COMPLETED' || unit.custom_id !== uid || !capture.amount || capture.amount.currency_code !== 'USD') {
        return res.status(402).json({ ok: false, error: 'Paiement non confirmé par PayPal.' });
      }

      amountCents = Math.round(Number(capture.amount.value) * 100);
      refundRef = capture.id;
    } else {
      return res.status(400).json({ ok: false, error: 'Moyen de paiement indisponible.' });
    }

    if (!Number.isFinite(amountCents) || amountCents < state.config.depositCents) {
      return res.status(402).json({ ok: false, error: 'Montant du paiement insuffisant.' });
    }

    user.mode = 'reward';
    user.deposit = {
      status: 'held',
      provider,
      paymentId: id,
      refundRef,
      amountCents,
      paidAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString()
    };

    state.payments[key] = uid;
    logDeposit('received', uid, user);

    audit({ type: 'deposit_paid', uid, email: user.email, provider, paymentId: id, amountCents });

    saveState();

    return res.json(summarize(uid, user));
  } catch (error) {
    console.error('⚠️ Vérification du paiement :', gatewayError(provider, error).message);

    return res.status(502).json({ ok: false, error: 'Impossible de vérifier le paiement pour le moment. Réessaie dans un instant.' });
  } finally {
    confirming.delete(key);
  }
});

// Prochaine vidéo approuvée que l'élève n'a pas encore vue (aucun appel API)
router.get('/api/rewards/library/next', requireUser, (req, res) => {
  const user = getUser(req.rewardUser.uid, req.rewardUser.email);
  const language = String(req.query.language || 'fr').trim().toLowerCase();

  if (!['fr', 'en', 'ar'].includes(language)) {
    return res.status(400).json({ ok: false, error: 'Langue invalide.' });
  }

  const total = library.countFor({ language, category: String(req.query.category || '').slice(0, 60) });

  if (!state.config.libraryFirst) {
    return res.json({ ok: true, video: null, total, liveFallback: state.config.liveFallback });
  }

  const seen = new Set([...Object.keys(user.seen || {}), ...Object.keys(user.plays || {})]);

  String(req.query.exclude || '')
    .split(',')
    .slice(0, 200)
    .forEach(id => {
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) seen.add(id);
    });

  const { record, remaining } = library.pickUnseen({
    language,
    category: String(req.query.category || '').slice(0, 60),
    seen
  });

  return res.json({
    ok: true,
    video: record ? library.toVideo(record) : null,
    remaining,
    total,
    liveFallback: state.config.liveFallback
  });
});

// Choix « jeu libre » : on joue sans points ni cumul
router.post('/api/rewards/mode', requireUser, (req, res) => {
  const user = getUser(req.rewardUser.uid, req.rewardUser.email);

  if (String((req.body && req.body.mode) || '') !== 'free') {
    return res.status(400).json({ ok: false, error: 'Mode invalide.' });
  }

  if (depositBusy(user)) {
    return res.status(409).json({
      ok: false,
      code: 'quit_first',
      error: 'Quitte d’abord le mode récompense.'
    });
  }

  user.mode = 'free';
  saveState();

  return res.json(summarize(req.rewardUser.uid, user));
});

// Mode récompense : l'élève déclare avoir payé le dépôt, l'administrateur le confirme
router.post('/api/rewards/deposit', requireUser, (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);
  const body = req.body || {};

  if (!state.config.withdrawalsEnabled) {
    return res.status(403).json({
      ok: false,
      code: 'reward_unavailable',
      error: 'Le mode récompense n’est pas encore disponible.'
    });
  }

  if (depositBusy(user)) {
    return res.status(409).json({
      ok: false,
      code: 'deposit_exists',
      error: 'Tu as déjà un dépôt en cours ou un mode récompense actif.'
    });
  }

  // Le moyen vient de la page (rib, western_union, wafacash) ; les anciens libellés restent acceptés
  let methodKey = String(body.payMethod || '').trim();

  if (!MANUAL_DEPOSIT_METHODS[methodKey]) {
    methodKey = Object.keys(MANUAL_DEPOSIT_METHODS).find(key => MANUAL_DEPOSIT_METHODS[key] === methodKey) || '';
  }

  if (!methodKey) {
    return res.status(400).json({ ok: false, code: 'deposit_info', error: 'Choisis un moyen de paiement valide.' });
  }

  if (!methodAvailable(methodKey)) {
    return res.status(403).json({
      ok: false,
      code: 'method_disabled',
      error: 'Ce moyen de paiement est désactivé pour le moment.'
    });
  }

  const payMethod = MANUAL_DEPOSIT_METHODS[methodKey];
  const payerName = cleanText(body.payerName, 2, 80);
  const reference = cleanText(body.reference, 4, 80);

  if (!payMethod || !payerName || !reference) {
    return res.status(400).json({
      ok: false,
      code: 'deposit_info',
      error: 'Indique comment tu as payé, ton nom et la référence du paiement.'
    });
  }

  user.mode = 'reward';
  user.deposit = {
    status: 'pending',
    amountCents: state.config.depositCents,
    payMethod,
    payerName,
    reference,
    declaredAt: new Date().toISOString()
  };

  audit({ type: 'deposit_declared', uid, email: user.email, amountCents: user.deposit.amountCents, payMethod, reference });

  saveState();

  return res.json(summarize(uid, user));
});

// Quitter le mode récompense : le dépôt est remboursé dans le délai prévu
router.post('/api/rewards/leave', requireUser, async (req, res) => {
  const uid = req.rewardUser.uid;
  const user = getUser(uid, req.rewardUser.email);

  if (user.mode !== 'reward' || !user.deposit) {
    return res.status(409).json({ ok: false, error: 'Tu n’es pas en mode récompense.' });
  }

  if (pendingWithdrawal(uid)) {
    return res.status(409).json({
      ok: false,
      code: 'pending',
      error: 'Une demande est en cours de traitement : attends qu’elle soit payée.'
    });
  }

  if (user.deposit.status === 'pending') {
    return res.status(409).json({
      ok: false,
      code: 'deposit_pending',
      error: 'Ton dépôt est en cours de vérification : attends sa confirmation.'
    });
  }

  if (user.deposit.status === 'held' && ['stripe', 'paypal'].includes(user.deposit.provider)) {
    // Dépôt payé en ligne : remboursé tout de suite sur le moyen de paiement d'origine
    try {
      if (user.deposit.provider === 'stripe') {
        await stripeCall('post', 'refunds', { payment_intent: user.deposit.refundRef });
      } else {
        const token = await paypalToken();

        await axios.post(
          `${PAYPAL_BASE}/v2/payments/captures/${user.deposit.refundRef}/refund`,
          {},
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
        );
      }
    } catch (error) {
      console.error('⚠️ Remboursement du dépôt :', gatewayError(user.deposit.provider, error).message);

      return res.status(502).json({
        ok: false,
        error: 'Remboursement impossible pour le moment. Réessaie plus tard ou contacte l’administrateur.'
      });
    }

    user.deposit.status = 'refunded';
    user.deposit.refundedAt = new Date().toISOString();
    logDeposit('refunded', uid, user, { note: 'Remboursé à la sortie du mode récompense' });
  } else if (user.deposit.status === 'held') {
    const built = buildPayout(req.body || {}, user);

    if (built.error) {
      return res.status(400).json({ ok: false, ...built.error });
    }

    const dueBy = new Date(Date.now() + state.config.depositRefundDays * 86400000).toISOString();

    state.withdrawals.push({
      id: state.nextWithdrawalId++,
      uid,
      email: user.email,
      type: 'deposit_refund',
      points: 0,
      amountCents: user.deposit.amountCents,
      payoutInfo: built.summary,
      payout: built.payout,
      status: 'pending',
      createdAt: new Date().toISOString(),
      dueBy
    });

    user.deposit.status = 'leaving';
    user.deposit.refundDueBy = dueBy;
  }

  // Dépôt déjà rendu (premier retrait) : rien à rembourser. Les points restent sur le compte.
  if (user.deposit.status === 'refunded') {
    logDeposit('left', uid, user, { note: 'Dépôt déjà remboursé : aucun nouveau remboursement' });
  }

  user.mode = 'free';

  audit({ type: 'mode_left', uid, email: user.email, deposit: user.deposit.status });

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
    capabilities: { mail: MAIL_ENABLED, paypalAuto: PAYPAL_ENABLED, stripe: STRIPE_ENABLED, stripeTest: STRIPE_TEST },
    stats: {
      users: users.length,
      usersWithPoints: users.filter(user => user.points > 0).length,
      pointsEarned: users.reduce((sum, user) => sum + user.points, 0),
      owedCents: owedPoints * value,
      pendingCount: pending.length,
      pendingCents: pending.reduce((sum, item) => sum + item.amountCents, 0),
      paidCents: state.withdrawals
        .filter(item => item.status === 'paid')
        .reduce((sum, item) => sum + item.amountCents, 0),
      depositsHeldCents: users.reduce(
        (sum, user) =>
          user.deposit && ['held', 'refunding', 'leaving'].includes(user.deposit.status)
            ? sum + user.deposit.amountCents
            : sum,
        0
      )
    },
    usersTotal: Object.keys(state.users).length,
    users: Object.entries(state.users)
      .map(([uid, user]) => ({
        uid,
        email: user.email,
        createdAt: user.createdAt || null,
        lastSeenAt: user.lastSeenAt || null,
        mode: user.mode || null,
        depositStatus: user.deposit ? user.deposit.status : null,
        points: availablePoints(user),
        earnedPoints: user.points,
        videos: Object.keys(user.plays || {}).length,
        blocked: Boolean(user.blocked),
        blockedAt: user.blockedAt || null,
        blockedReason: user.blockedReason || ''
      }))
      .sort((a, b) =>
        String(b.lastSeenAt || b.createdAt || '').localeCompare(String(a.lastSeenAt || a.createdAt || ''))
      )
      .slice(0, 1000),
    depositLog: state.depositLog.slice(-300),
    deposits: Object.entries(state.users)
      .filter(([, user]) => user.deposit && user.deposit.status === 'pending')
      .map(([uid, user]) => ({ uid, email: user.email, ...user.deposit })),
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

  if (body.depositCents !== undefined) {
    if (!integer(body.depositCents, 100, 100000)) {
      return res.status(400).json({ ok: false, error: 'Montant du dépôt invalide.' });
    }

    next.depositCents = body.depositCents;
  }

  if (body.depositRefundDays !== undefined) {
    if (!integer(body.depositRefundDays, 1, 30)) {
      return res.status(400).json({ ok: false, error: 'Délai de remboursement invalide.' });
    }

    next.depositRefundDays = body.depositRefundDays;
  }

  if (body.depositInstructions !== undefined) {
    next.depositInstructions = String(body.depositInstructions).trim().slice(0, 600);
  }

  for (const key of ['libraryFirst', 'liveFallback']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'Réglage de la bibliothèque invalide.' });
      }

      next[key] = body[key];

      if (key === 'liveFallback') {
        next.liveFallbackChosen = true;
      }
    }
  }

  if (body.depositMethods !== undefined) {
    const flags = { ...(state.config.depositMethods || {}) };
    const sent = body.depositMethods && typeof body.depositMethods === 'object' ? body.depositMethods : {};

    for (const key of DEPOSIT_METHOD_KEYS) {
      if (sent[key] === undefined) continue;

      if (typeof sent[key] !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'Réglage de moyen de paiement invalide.' });
      }

      flags[key] = sent[key];
    }

    next.depositMethods = flags;
  }

  audit({ type: 'config', before: state.config, after: next });

  state.config = next;

  saveState();

  return res.json({ ok: true, config: publicConfig() });
});

// Export CSV : trace de toutes les opérations (retraits, remboursements, dépôts)
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);

  // Une cellule ne doit jamais être lue comme une formule par Excel
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvMoney(cents) {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',');
}

function csvDate(iso) {
  return iso ? String(iso).replace('T', ' ').slice(0, 19) : '';
}

router.get('/api/rewards/admin/export', requireAdmin, (req, res) => {
  const rows = [];

  state.withdrawals.forEach(item => {
    const payout = item.payout || {};
    const masked =
      payout.bankAccountMasked || (payout.bankAccount ? '****' + payout.bankAccount.slice(-4) : '');
    const how = payout.method
      ? (PAYOUT_METHODS[payout.method] || payout.method) +
        (payout.network ? ` (${CASH_NETWORKS[payout.network] || payout.network})` : '')
      : item.payoutInfo || '';
    const notes = [];

    if (item.depositCents) notes.push(`dont dépôt remboursé ${csvMoney(item.depositCents)}`);
    if (masked) notes.push(`RIB ${masked}`);
    if (item.paypalBatchId) notes.push(`Lot PayPal ${item.paypalBatchId}`);
    if (item.codeSentAt) notes.push('Code envoyé par e-mail');
    if (item.codeSentManually) notes.push('Code transmis à la main');
    if (item.note) notes.push(item.note);

    rows.push({
      at: item.createdAt,
      cells: [
        csvDate(item.createdAt),
        item.type === 'deposit_refund' ? 'Remboursement de dépôt' : 'Retrait',
        item.id,
        item.email,
        csvMoney(item.amountCents),
        item.points,
        how,
        payout.fullName || '',
        [payout.city, payout.country].filter(Boolean).join(', '),
        '',
        { pending: 'En attente', paid: 'Payé', rejected: 'Refusé' }[item.status] || item.status,
        csvDate(item.resolvedAt),
        notes.join(' · ')
      ]
    });
  });

  const TYPES = {
    received: 'Dépôt reçu',
    refunded: 'Dépôt remboursé',
    rejected: 'Dépôt refusé',
    left: 'Sortie du mode récompense'
  };

  (state.depositLog || []).forEach(event => {
    const way =
      { stripe: 'Stripe', paypal: 'PayPal', manual: 'Paiement à la main' }[event.provider] || event.provider || '';

    rows.push({
      at: event.at,
      cells: [
        csvDate(event.at),
        TYPES[event.type] || event.type,
        '',
        event.email,
        csvMoney(event.amountCents),
        '',
        way + (event.payMethod ? ` (${event.payMethod})` : ''),
        event.payerName || '',
        '',
        event.reference || '',
        { received: 'Reçu', refunded: 'Remboursé', rejected: 'Refusé', left: 'Sans remboursement' }[event.type] || '',
        '',
        event.note || ''
      ]
    });
  });

  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const header = [
    'Date',
    'Opération',
    'N°',
    'E-mail',
    'Montant (USD)',
    'Points',
    'Moyen',
    'Bénéficiaire / payeur',
    'Lieu',
    'Référence',
    'Statut',
    'Date de traitement',
    'Notes'
  ];

  const csv = [header, ...rows.map(row => row.cells)].map(cells => cells.map(csvCell).join(';')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="operations-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  // Le BOM permet à Excel d'ouvrir correctement les accents
  return res.send('\ufeff' + csv);
});

// Recherche de vidéos par l'administrateur (même recherche que le jeu, plus mots-clés et page suivante)
const LIBRARY_CATEGORIES = ['sport', 'sciences', 'art culinaire', 'culture générale'];
const generating = new Set();

function internalGet(pathname, params, timeout) {
  return axios.get(`http://127.0.0.1:${process.env.PORT || 8080}${pathname}`, {
    params,
    headers: { 'x-internal-library': INTERNAL_KEY },
    timeout,
    validateStatus: () => true
  });
}

router.get('/api/rewards/admin/library/search', requireAdmin, async (req, res) => {
  const language = String(req.query.language || '').toLowerCase();
  const category = String(req.query.category || '').toLowerCase();

  if (!['fr', 'en', 'ar'].includes(language) || !LIBRARY_CATEGORIES.includes(category)) {
    return res.status(400).json({ ok: false, error: 'Langue ou thème invalide.' });
  }

  try {
    const response = await internalGet(
      '/api/youtube/search',
      {
        language,
        category,
        q: String(req.query.q || '').slice(0, 80),
        pageToken: String(req.query.pageToken || '').slice(0, 200)
      },
      30000
    );

    if (response.status !== 200 || !response.data || !response.data.ok) {
      const detail = response.data && response.data.error ? response.data.error : `erreur ${response.status}`;

      return res.status(502).json({ ok: false, error: `La recherche YouTube a échoué (${detail}).` });
    }

    return res.json({
      ok: true,
      nextPageToken: response.data.nextPageToken || null,
      videos: (response.data.videos || []).map(video => ({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        durationFormatted: video.durationFormatted,
        captionAvailable: Boolean(video.captionAvailable),
        viewCount: video.viewCount || null,
        status: library.statusOf(video.videoId, language)
      }))
    });
  } catch (error) {
    console.error('⚠️ Recherche administrateur :', error.message);

    return res.status(502).json({ ok: false, error: 'La recherche n’a pas pu aboutir. Réessaie.' });
  }
});

// Génère le quiz d'une vidéo choisie (appel payant) et le met dans « À valider »
router.post('/api/rewards/admin/library/generate', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const videoId = normalizeVideoId(body.videoId);
  const language = String(body.language || '').toLowerCase();
  const category = String(body.category || '').toLowerCase();

  if (!videoId || !['fr', 'en', 'ar'].includes(language) || !LIBRARY_CATEGORIES.includes(category)) {
    return res.status(400).json({ ok: false, error: 'Vidéo, langue ou thème invalide.' });
  }

  // Déjà connue : aucun appel payant
  const known = library.statusOf(videoId, language);

  if (known) {
    library.capture({ videoId, language, category, video: {}, questions: [] });

    return res.json({ ok: true, already: known });
  }

  const key = `${language}:${videoId}`;

  if (generating.has(key)) {
    return res.status(409).json({ ok: false, error: 'Génération déjà en cours pour cette vidéo.' });
  }

  generating.add(key);

  try {
    const response = await internalGet('/api/youtube/questions', { videoId, language, count: 4 }, 150000);

    if (response.status !== 200 || !response.data || !response.data.ok) {
      const detail = response.data && response.data.error ? response.data.error : `erreur ${response.status}`;

      return res.status(502).json({ ok: false, error: `Quiz non généré : ${detail}` });
    }

    const record = library.capture({
      videoId,
      language,
      category,
      video: response.data.video,
      questions: response.data.questions,
      source: 'admin'
    });

    if (!record) {
      return res.status(422).json({
        ok: false,
        error: 'Quiz invalide, ou liste « À valider » pleine (trie-la d’abord).'
      });
    }

    audit({ type: 'library_generate', videoId, language, category });

    return res.json({ ok: true, status: record.status });
  } catch (error) {
    console.error('⚠️ Génération administrateur :', error.message);

    return res.status(502).json({ ok: false, error: 'La génération n’a pas pu aboutir. Réessaie.' });
  } finally {
    generating.delete(key);
  }
});

// Bibliothèque de quiz : liste (à valider, approuvés, refusés) et décisions
router.get('/api/rewards/admin/library', requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';

  return res.json({
    ok: true,
    status,
    stats: library.stats(),
    coverage: library.coverage(),
    items: library.list(status)
  });
});

router.post('/api/rewards/admin/library', requireAdmin, (req, res) => {
  const body = req.body || {};
  const result = library.decide(String(body.id || ''), String(body.action || ''), body.note);

  if (!result.ok) return res.status(404).json(result);

  audit({ type: `library_${body.action}`, id: body.id });

  return res.json({ ok: true, stats: library.stats() });
});

// Bloque ou débloque un élève : il ne peut plus jouer, gagner de points, payer un dépôt ni retirer
router.post('/api/rewards/admin/users/:uid/block', requireAdmin, (req, res) => {
  const user = state.users[req.params.uid];
  const blocked = req.body && req.body.blocked;

  if (!user) {
    return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
  }

  if (typeof blocked !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Action invalide.' });
  }

  if (blocked) {
    user.blocked = true;
    user.blockedAt = new Date().toISOString();
    user.blockedReason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  } else {
    delete user.blocked;
    delete user.blockedAt;
    delete user.blockedReason;
  }

  audit({ type: blocked ? 'user_blocked' : 'user_unblocked', uid: req.params.uid, email: user.email, reason: user.blockedReason || '' });

  saveState();

  return res.json({ ok: true });
});

// Confirme (argent reçu) ou refuse (rien reçu) le dépôt déclaré par un élève
router.post('/api/rewards/admin/deposits/:uid', requireAdmin, (req, res) => {
  const user = state.users[req.params.uid];
  const action = req.body && req.body.action;

  if (!user || !user.deposit || user.deposit.status !== 'pending') {
    return res.status(404).json({ ok: false, error: 'Aucun dépôt en attente pour ce compte.' });
  }

  if (action !== 'confirm' && action !== 'reject') {
    return res.status(400).json({ ok: false, error: 'Action invalide.' });
  }

  if (action === 'confirm') {
    user.deposit.status = 'held';
    user.deposit.confirmedAt = new Date().toISOString();
    user.mode = 'reward';
    logDeposit('received', req.params.uid, user);
  } else {
    user.deposit.status = 'rejected';
    user.deposit.note = String((req.body && req.body.note) || '').slice(0, 200);
    user.mode = null;
    logDeposit('rejected', req.params.uid, user, { note: user.deposit.note });
  }

  audit({ type: `deposit_${action}`, uid: req.params.uid, email: user.email, amountCents: user.deposit.amountCents });

  saveState();

  return res.json({ ok: true });
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
        if (body.noEmail === true) {
          // E-mail non configuré : l'administrateur a transmis le code à l'élève lui-même
          withdrawal.codeSentManually = true;
        } else {
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
        }
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

      // Dépôt de garantie : rendu avec le premier retrait ou à la sortie du mode récompense
      const touchesDeposit = withdrawal.type === 'deposit_refund' || withdrawal.depositCents > 0;

      if (user.deposit && touchesDeposit && ['refunding', 'leaving'].includes(user.deposit.status)) {
        if (action === 'paid') {
          user.deposit.status = 'refunded';
          user.deposit.refundedAt = new Date().toISOString();
          logDeposit('refunded', withdrawal.uid, user, {
            note: withdrawal.type === 'deposit_refund' ? 'Remboursement #' + withdrawal.id : 'Avec le retrait #' + withdrawal.id
          });
        } else {
          user.deposit.status = 'held';

          if (withdrawal.type === 'deposit_refund') {
            user.mode = 'reward'; // remboursement refusé : l'élève reste en mode récompense
          }
        }
      }
    }

    // Le RIB n'est gardé que le temps de payer : on l'efface, il ne reste que les 4 derniers caractères
    if (payout.bankAccount) {
      const last4 = payout.bankAccount.slice(-4);

      payout.bankAccountMasked = '****' + last4;
      delete payout.bankAccount;
      withdrawal.payoutInfo = String(withdrawal.payoutInfo || '').replace(/RIB\/IBAN \S+/, 'RIB/IBAN ****' + last4);
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
        <div><h2 style="margin:0">Retraits et mode récompense</h2><div class="muted" id="switchText"></div></div>
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
      <label for="depositAmount">Dépôt de garantie du mode récompense (en dollars)</label>
      <input id="depositAmount" type="number" step="1" min="1" max="1000">
      <label for="depositDays">Délai de remboursement quand l'élève quitte (en jours)</label>
      <input id="depositDays" type="number" step="1" min="1" max="30">
      <label for="depositInstructions">Comment payer le dépôt (affiché aux élèves : PayPal, RIB, Wafacash…)</label>
      <textarea id="depositInstructions" maxlength="600" style="width:100%;min-height:90px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit"></textarea>
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
      <h2>Bibliothèque de quiz</h2>
      <div class="muted" id="libInfo"></div>
      <div class="muted" id="libCoverage"></div>
      <div id="libSettings"></div>

      <h3 style="margin:18px 0 6px">Chercher des vidéos à valider</h3>
      <div class="muted">La recherche utilise le quota YouTube. « Générer le quiz » utilise l'API de questions (tokens). Les quiz générés arrivent dans « À valider ».</div>
      <select id="srLang" style="width:100%;margin:8px 0;padding:10px;border-radius:8px"><option value="fr">Français</option><option value="en">English</option><option value="ar">العربية</option></select>
      <select id="srCat" style="width:100%;margin:0 0 8px;padding:10px;border-radius:8px"><option value="sciences">Sciences</option><option value="sport">Sport</option><option value="art culinaire">Art culinaire</option><option value="culture générale">Culture générale</option></select>
      <input id="srQuery" type="text" maxlength="80" placeholder="Mots-clés en plus (facultatif)" autocomplete="off">
      <div class="row" style="margin-top:8px"><button id="srBtn">Chercher</button></div>
      <div class="muted" id="srInfo" style="margin-top:8px"></div>
      <div id="srList"></div>
      <div class="row" style="margin-top:8px"><button id="srMore" class="secondary" style="display:none">Résultats suivants</button></div>

      <div class="row" id="libTabs" style="margin:10px 0"></div>
      <div id="libList"></div>
    </section>

    <section>
      <h2>Utilisateurs</h2>
      <div class="muted" id="usersInfo"></div>
      <input id="userSearch" type="search" placeholder="Rechercher par e-mail" autocomplete="off" style="margin:8px 0">
      <div id="users"></div>
    </section>

    <section>
      <h2>Moyens de paiement du dépôt</h2>
      <div class="muted">Les élèves voient chaque moyen avec son état (activé ou désactivé). Un moyen désactivé ne peut plus être utilisé pour un nouveau dépôt.</div>
      <div id="methods"></div>
    </section>

    <section>
      <h2>Dépôts de garantie à vérifier</h2>
      <div id="depositGateways" class="muted"></div>
      <div id="deposits"></div>
    </section>

    <section>
      <h2>Demandes en attente</h2>
      <div id="pending"></div>
    </section>

    <section>
      <h2>Historique</h2>
      <div class="row" style="margin-bottom:10px"><button id="exportBtn" class="secondary">Télécharger l'historique (CSV)</button></div>
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
  var usersData = [], usersTotal = 0;
  var libStatus = 'pending';
  var srToken = null;

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
    $('switchText').textContent = cfg.withdrawalsEnabled ? 'Les élèves peuvent activer le mode récompense et demander un retrait.' : 'Retraits et mode récompense fermés : tout le monde joue en jeu libre. Les élèves déjà en mode récompense gardent leur dépôt.';
    var t = $('toggleBtn');
    t.textContent = cfg.withdrawalsEnabled ? 'Fermer retraits et mode récompense' : 'Ouvrir retraits et mode récompense';
    t.className = cfg.withdrawalsEnabled ? 'danger' : '';
    $('pointValue').value = (cfg.pointValueCents / 100).toFixed(2);
    $('minWithdrawal').value = Math.round(cfg.minWithdrawalCents / 100);
    $('dailyLimit').value = cfg.dailyVideoLimit;
    $('depositAmount').value = Math.round(cfg.depositCents / 100);
    $('depositDays').value = cfg.depositRefundDays;
    $('depositInstructions').value = cfg.depositInstructions || '';
    $('tz').textContent = data.timeZone;

    var s = data.stats, stats = $('stats'); stats.innerHTML = '';
    [['Élèves inscrits', s.users], ['Élèves avec des points', s.usersWithPoints], ['Points gagnés (total)', s.pointsEarned],
     ['Dû aux élèves', money(s.owedCents)], ['En attente de paiement', s.pendingCount + ' · ' + money(s.pendingCents)], ['Déjà payé', money(s.paidCents)], ['Dépôts détenus', money(s.depositsHeldCents)]]
      .forEach(function (x) { stats.appendChild(el('div', { class: 'stat' }, [el('b', { text: String(x[1]) }), el('span', { class: 'muted', text: x[0] })])); });

    $('depositGateways').textContent = 'Paiement en ligne du dépôt : ' +
      (caps.stripe ? (caps.stripeTest ? 'Stripe (mode test)' : 'Stripe') : 'Stripe non configuré') + ' · ' +
      (caps.paypalAuto ? 'PayPal' : 'PayPal non configuré') + '. Les paiements par RIB, Western Union ou Wafacash se confirment ci-dessous.';
    loadLibrary();
    usersData = data.users || [];
    usersTotal = data.usersTotal || 0;
    renderUsers();

    var METHODS = [['stripe', 'Carte bancaire (Stripe)'], ['paypal', 'PayPal'], ['rib', 'Virement / RIB'], ['western_union', 'Western Union'], ['wafacash', 'Wafacash']];
    var methodsBox = $('methods'); methodsBox.innerHTML = '';
    METHODS.forEach(function (m) {
      var key = m[0], name = m[1];
      var on = (cfg.depositMethodFlags || {})[key] !== false;
      var configured = key === 'stripe' ? caps.stripe : key === 'paypal' ? caps.paypalAuto : true;
      var label = !configured ? 'Non configuré sur le serveur' : (on ? 'Activé' : 'Désactivé');
      var btn = el('button', { class: on ? 'secondary' : '', text: on ? 'Désactiver' : 'Activer' });
      btn.addEventListener('click', function () { toggleMethod(key, !on, name); });
      methodsBox.appendChild(el('div', { class: 'req' }, [
        el('div', { text: name + ' : ' + label }),
        el('div', { class: 'actions' }, [btn])
      ]));
    });

    var depBox = $('deposits'); depBox.innerHTML = '';
    (data.deposits || []).forEach(function (d) {
      var ok = el('button', { text: 'Dépôt reçu' }), no = el('button', { class: 'secondary', text: 'Pas reçu' });
      ok.addEventListener('click', function () { resolveDeposit(d, 'confirm'); });
      no.addEventListener('click', function () { resolveDeposit(d, 'reject'); });
      depBox.appendChild(el('div', { class: 'req' }, [
        el('div', { text: d.email + ' · ' + money(d.amountCents) }),
        el('div', { class: 'muted', text: 'Payé par : ' + d.payMethod + ' · Nom : ' + d.payerName }),
        el('div', { text: 'Référence : ' + d.reference }),
        el('div', { class: 'muted', text: new Date(d.declaredAt).toLocaleString('fr-FR') }),
        el('div', { class: 'actions' }, [ok, no])
      ]));
    });
    if (!depBox.firstChild) depBox.appendChild(el('div', { class: 'muted', text: 'Aucun dépôt à vérifier.' }));

    var pending = $('pending'), history = $('history'); pending.innerHTML = ''; history.innerHTML = '';
    var any = false;
    var histItems = [];
    data.withdrawals.forEach(function (w) {
      var when = new Date(w.createdAt).toLocaleString();
      var p = w.payout || {};
      var NAMES = { card: 'Carte / virement bancaire', paypal: 'PayPal', cash: 'Western Union / Wafacash' };
      var title = '#' + w.id + ' · ' + w.email + ' · ' + money(w.amountCents) + ' (' + w.points + ' points)';
      if (w.type === 'deposit_refund') {
        title = '#' + w.id + ' · ' + w.email + ' · REMBOURSEMENT DU DÉPÔT · ' + money(w.amountCents) + (w.dueBy ? ' · à payer avant le ' + new Date(w.dueBy).toLocaleDateString('fr-FR') : '');
      } else if (w.depositCents) {
        title += ' + dépôt remboursé ' + money(w.depositCents);
      }
      var lines = [el('div', { text: title })];
      if (p.method) {
        lines.push(el('div', { text: 'Moyen : ' + (NAMES[p.method] || p.method) + (p.network ? ' (' + (p.network === 'wafacash' ? 'Wafacash' : 'Western Union') + ')' : '') }));
        lines.push(el('div', { class: 'muted', text: 'Bénéficiaire : ' + p.fullName + ' · ' + (p.city ? p.city + ', ' : '') + p.country }));
        if (p.paypalEmail) lines.push(el('div', { class: 'muted', text: 'E-mail PayPal : ' + p.paypalEmail }));
        if (p.contactEmail) lines.push(el('div', { class: 'muted', text: 'E-mail de contact : ' + p.contactEmail }));
        if (p.bankAccount) lines.push(el('div', { text: 'RIB / IBAN : ' + p.bankAccount }));
        if (p.bankAccountMasked) lines.push(el('div', { class: 'muted', text: 'RIB / IBAN effacé après traitement : ' + p.bankAccountMasked }));
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
          var send = el('button', { text: caps.mail ? 'Envoyer le code et marquer payé' : 'Marquer payé (code donné à la main)' });
          send.addEventListener('click', function () { resolve(w, 'paid', caps.mail ? 'cash' : 'cash-manual'); });
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
        histItems.push({ t: new Date(w.resolvedAt || w.createdAt).getTime(), node: el('div', { class: 'req' }, lines) });
      }
    });
    (data.depositLog || []).forEach(function (e) {
      var LABELS = { received: 'DÉPÔT REÇU', refunded: 'DÉPÔT REMBOURSÉ', rejected: 'DÉPÔT REFUSÉ', left: 'SORTIE DU MODE RÉCOMPENSE' };
      var WAYS = { stripe: 'Stripe', paypal: 'PayPal', manual: 'Paiement à la main' };
      var how = (WAYS[e.provider] || e.provider || '') + (e.payMethod ? ' (' + e.payMethod + ')' : '');
      var dl = [el('div', { text: (LABELS[e.type] || e.type) + ' · ' + e.email + ' · ' + money(e.amountCents) })];
      if (how) dl.push(el('div', { class: 'muted', text: 'Moyen : ' + how }));
      if (e.payerName) dl.push(el('div', { class: 'muted', text: 'Payé par : ' + e.payerName }));
      if (e.reference) dl.push(el('div', { class: 'muted', text: 'Référence : ' + e.reference }));
      if (e.note) dl.push(el('div', { class: 'muted', text: e.note }));
      dl.push(el('div', { class: 'muted', text: new Date(e.at).toLocaleString() }));
      dl.push(el('div', { class: e.type === 'rejected' ? 'off' : 'on', text: e.type === 'received' ? 'Reçu' : e.type === 'refunded' ? 'Remboursé' : e.type === 'left' ? 'Sans remboursement' : 'Refusé' }));
      histItems.push({ t: new Date(e.at).getTime(), node: el('div', { class: 'req' }, dl) });
    });
    histItems.sort(function (a, b) { return b.t - a.t; }).forEach(function (item) { history.appendChild(item.node); });
    if (!any) pending.appendChild(el('div', { class: 'muted', text: 'Aucune demande en attente.' }));
    if (!history.firstChild) history.appendChild(el('div', { class: 'muted', text: 'Rien pour le moment.' }));
  }

  function loadLibrary() {
    return api('/library?status=' + libStatus).then(function (d) {
      if (d && d.ok) renderLibrary(d);
    });
  }

  function toggleLib(key, value, label) {
    var warning = key === 'liveFallback' && value
      ? 'Attention : chaque élève qui a tout vu déclenchera une recherche YouTube et une génération de quiz payantes (tokens). Ouvrir quand même ?'
      : (value ? 'Activer' : 'Désactiver') + ' : ' + label + ' ?';
    if (!confirm(warning)) return;
    var body = {}; body[key] = value;
    api('/config', { method: 'POST', body: body }).then(function (r) {
      notice(r.ok ? 'Réglage enregistré.' : (r.error || 'Erreur'), !r.ok); load();
    });
  }

  function srRow(v, lang, cat) {
    var STATUS = { pending: 'Quiz déjà généré (à valider)', approved: 'Déjà dans la bibliothèque', rejected: 'Déjà refusé' };
    var lines = [
      el('div', { text: v.title || v.videoId }),
      el('div', { class: 'muted', text: (v.channelTitle || '') + ' · ' + (v.durationFormatted || '') + (v.captionAvailable ? ' · sous-titres' : ' · sous-titres non indiqués') + (v.viewCount ? ' · ' + v.viewCount + ' vues' : '') }),
      el('a', { href: 'https://www.youtube.com/watch?v=' + v.videoId, target: '_blank', rel: 'noopener', text: 'Voir la vidéo sur YouTube' })
    ];
    var holder = el('div', { class: 'actions' });
    if (v.status) {
      holder.appendChild(el('div', { class: 'muted', text: STATUS[v.status] || v.status }));
    } else {
      var b = el('button', { text: 'Générer le quiz' });
      b.addEventListener('click', function () {
        if (!confirm('Générer le quiz de cette vidéo ? Cela utilise l’API (tokens).')) return;
        b.disabled = true; b.textContent = 'Génération en cours…';
        api('/library/generate', { method: 'POST', body: { videoId: v.videoId, language: lang, category: cat } }).then(function (r) {
          if (r.ok) {
            holder.innerHTML = '';
            holder.appendChild(el('div', { class: 'muted', text: r.already ? 'Déjà dans la bibliothèque.' : 'Quiz généré : va dans l’onglet « À valider ».' }));
            libStatus = 'pending'; loadLibrary();
          } else {
            b.disabled = false; b.textContent = 'Générer le quiz'; notice(r.error || 'Erreur', true);
          }
        }).catch(function () { b.disabled = false; b.textContent = 'Générer le quiz'; notice('Erreur réseau', true); });
      });
      holder.appendChild(b);
    }
    lines.push(holder);
    return el('div', { class: 'req' }, lines);
  }

  function searchVideos(more) {
    var lang = $('srLang').value, cat = $('srCat').value, q = $('srQuery').value.trim();
    if (!more) { srToken = null; $('srList').innerHTML = ''; }
    $('srInfo').textContent = 'Recherche en cours…';
    var url = '/library/search?language=' + encodeURIComponent(lang) + '&category=' + encodeURIComponent(cat) +
      '&q=' + encodeURIComponent(q) + (more && srToken ? '&pageToken=' + encodeURIComponent(srToken) : '');
    api(url).then(function (d) {
      if (!d || !d.ok) { $('srInfo').textContent = (d && d.error) || 'Erreur'; return; }
      srToken = d.nextPageToken;
      $('srInfo').textContent = d.videos.length + ' vidéo(s) dans cette page.';
      d.videos.forEach(function (v) { $('srList').appendChild(srRow(v, lang, cat)); });
      $('srMore').style.display = srToken ? '' : 'none';
    }).catch(function () { $('srInfo').textContent = 'Erreur réseau'; });
  }

  function libDecide(item, action, question) {
    if (question && !confirm(question)) return;
    api('/library', { method: 'POST', body: { id: item.id, action: action } }).then(function (r) {
      notice(r.ok ? 'Bibliothèque mise à jour.' : (r.error || 'Erreur'), !r.ok); loadLibrary();
    });
  }

  function renderLibrary(d) {
    var st = d.stats;
    $('libInfo').textContent = 'Approuvés : ' + st.approved + ' · À valider : ' + st.pending + ' · Refusés : ' + st.rejected +
      ' · Quiz servis sans aucun appel API : ' + st.served;

    var cov = d.coverage || [];
    $('libCoverage').textContent = cov.length
      ? 'Vidéos approuvées par langue et thème : ' + cov.map(function (c) { return c.language.toUpperCase() + ' · ' + c.category + ' : ' + c.approved; }).join(' — ')
      : 'Aucune vidéo approuvée pour le moment : les élèves n’ont rien à jouer avec la recherche en direct fermée.';

    var box = $('libSettings'); box.innerHTML = '';
    [['libraryFirst', 'Servir d’abord les quiz de la bibliothèque'], ['liveFallback', 'Recherche et génération en direct par les élèves (fermée : ils ne jouent que la bibliothèque)']].forEach(function (s) {
      var on = cfg[s[0]] !== false;
      var btn = el('button', { class: on ? 'secondary' : '', text: on ? 'Désactiver' : 'Activer' });
      btn.addEventListener('click', function () { toggleLib(s[0], !on, s[1]); });
      box.appendChild(el('div', { class: 'req' }, [el('div', { text: s[1] + ' : ' + (on ? 'Activé' : 'Désactivé') }), el('div', { class: 'actions' }, [btn])]));
    });

    var tabs = $('libTabs'); tabs.innerHTML = '';
    [['pending', 'À valider (' + st.pending + ')'], ['approved', 'Approuvés (' + st.approved + ')'], ['rejected', 'Refusés (' + st.rejected + ')']].forEach(function (t) {
      var b = el('button', { class: libStatus === t[0] ? '' : 'secondary', text: t[1] });
      b.addEventListener('click', function () { libStatus = t[0]; loadLibrary(); });
      tabs.appendChild(b);
    });

    var list = $('libList'); list.innerHTML = '';
    d.items.forEach(function (item) {
      var qs = item.questions.map(function (q, i) {
        var rows = [el('div', { text: (i + 1) + '. ' + q.question })];
        q.choices.forEach(function (c, k) {
          rows.push(el('div', { class: 'muted', text: (k === Number(q.correctAnswer) ? '✔ ' : '• ') + c }));
        });
        return el('div', { style: 'margin:8px 0' }, rows);
      });
      var lines = [
        el('div', { text: item.title || item.videoId }),
        el('div', { class: 'muted', text: item.language.toUpperCase() + ' · ' + (item.categories.join(', ') || 'thème inconnu') + ' · ' + (item.channelTitle || 'chaîne inconnue') + ' · servi ' + (item.served || 0) + ' fois · ' + fdate(item.createdAt) }),
        el('a', { href: 'https://www.youtube.com/watch?v=' + item.videoId, target: '_blank', rel: 'noopener', text: 'Voir la vidéo sur YouTube' }),
        el('details', {}, [el('summary', { text: 'Voir les questions et les bonnes réponses (' + item.questions.length + ')' })].concat(qs))
      ];
      var buttons = [];
      if (item.status === 'pending') {
        var ok = el('button', { text: 'Approuver' }); ok.addEventListener('click', function () { libDecide(item, 'approve'); });
        var no = el('button', { class: 'secondary', text: 'Refuser' }); no.addEventListener('click', function () { libDecide(item, 'reject'); });
        buttons.push(ok, no);
      } else if (item.status === 'approved') {
        var out = el('button', { class: 'secondary', text: 'Retirer de la bibliothèque' }); out.addEventListener('click', function () { libDecide(item, 'reject', 'Retirer ce quiz de la bibliothèque ?'); });
        buttons.push(out);
      } else {
        var back = el('button', { class: 'secondary', text: 'Remettre à valider' }); back.addEventListener('click', function () { libDecide(item, 'reopen'); });
        var del = el('button', { class: 'secondary', text: 'Supprimer' }); del.addEventListener('click', function () { libDecide(item, 'delete', 'Supprimer définitivement ce quiz ?'); });
        buttons.push(back, del);
      }
      lines.push(el('div', { class: 'actions' }, buttons));
      list.appendChild(el('div', { class: 'req' }, lines));
    });
    if (!d.items.length) list.appendChild(el('div', { class: 'muted', text: 'Rien dans cette liste.' }));
  }

  function fdate(iso) { return iso ? new Date(iso).toLocaleString('fr-FR') : '—'; }

  function renderUsers() {
    var q = ($('userSearch').value || '').trim().toLowerCase();
    var box = $('users'); box.innerHTML = '';
    var list = usersData.filter(function (u) { return !q || String(u.email).toLowerCase().indexOf(q) !== -1; });
    var shown = list.slice(0, 100);
    var blockedCount = usersData.filter(function (u) { return u.blocked; }).length;
    $('usersInfo').textContent = usersTotal + ' compte(s) enregistré(s) sur le serveur · ' + blockedCount + ' bloqué(s)' +
      (list.length > shown.length ? ' · ' + shown.length + ' affichés sur ' + list.length + ' (précise la recherche)' : '');
    var MODES = { reward: 'Mode récompense', free: 'Jeu libre' };
    var DEP = { pending: 'dépôt en vérification', held: 'dépôt détenu', refunding: 'dépôt rendu avec le retrait', leaving: 'remboursement en cours', refunded: 'dépôt rendu', rejected: 'dépôt refusé' };
    shown.forEach(function (u) {
      var lines = [el('div', { text: u.email + (u.blocked ? ' · BLOQUÉ' : '') })];
      lines.push(el('div', { class: 'muted', text: (MODES[u.mode] || 'Mode non choisi') + (u.depositStatus ? ' · ' + (DEP[u.depositStatus] || u.depositStatus) : '') + ' · ' + u.points + ' point(s) · ' + u.videos + ' vidéo(s)' }));
      lines.push(el('div', { class: 'muted', text: 'Inscrit le ' + fdate(u.createdAt) + ' · Dernière activité : ' + fdate(u.lastSeenAt) }));
      if (u.blocked) lines.push(el('div', { class: 'muted', text: 'Bloqué le ' + fdate(u.blockedAt) + (u.blockedReason ? ' · Motif : ' + u.blockedReason : '') }));
      var b = el('button', { class: u.blocked ? '' : 'secondary', text: u.blocked ? 'Débloquer' : 'Bloquer' });
      b.addEventListener('click', function () { blockUser(u); });
      lines.push(el('div', { class: 'actions' }, [b]));
      box.appendChild(el('div', { class: 'req' }, lines));
    });
    if (!shown.length) box.appendChild(el('div', { class: 'muted', text: 'Aucun utilisateur.' }));
  }

  function blockUser(u) {
    var body = { blocked: !u.blocked };
    if (!u.blocked) {
      if (!confirm('Bloquer ' + u.email + ' ? Il ne pourra plus jouer, gagner de points, payer un dépôt ni demander de retrait.')) return;
      body.reason = prompt('Motif (facultatif)') || '';
    } else if (!confirm('Débloquer ' + u.email + ' ?')) {
      return;
    }
    api('/users/' + encodeURIComponent(u.uid) + '/block', { method: 'POST', body: body }).then(function (r) {
      notice(r.ok ? (body.blocked ? 'Utilisateur bloqué.' : 'Utilisateur débloqué.') : (r.error || 'Erreur'), !r.ok); load();
    });
  }

  function toggleMethod(key, value, name) {
    if (!confirm((value ? 'Activer' : 'Désactiver') + ' « ' + name + ' » pour les nouveaux dépôts ?')) return;
    var flags = {}; flags[key] = value;
    api('/config', { method: 'POST', body: { depositMethods: flags } }).then(function (r) {
      notice(r.ok ? 'Moyen de paiement mis à jour.' : (r.error || 'Erreur'), !r.ok); load();
    });
  }

  function resolveDeposit(d, action) {
    var body = { action: action };
    if (action === 'confirm') {
      if (!confirm('Confirmer que tu as bien reçu ' + money(d.amountCents) + ' de ' + d.email + ' ?')) return;
    } else {
      if (!confirm('Refuser ce dépôt (rien reçu) ?')) return;
      body.note = prompt('Motif (facultatif)') || '';
    }
    api('/deposits/' + d.uid, { method: 'POST', body: body }).then(function (r) {
      notice(r.ok ? 'Dépôt mis à jour.' : (r.error || 'Erreur'), !r.ok); load();
    });
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
    } else if (mode === 'cash-manual') {
      if (!confirm('Confirme que tu as envoyé l’argent ET transmis le code de retrait à l’élève (l’e-mail automatique n’est pas configuré).')) return;
      body.noEmail = true;
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

  $('srBtn').addEventListener('click', function () { searchVideos(false); });
  $('srMore').addEventListener('click', function () { searchVideos(true); });

  $('userSearch').addEventListener('input', renderUsers);

  $('exportBtn').addEventListener('click', function () {
    fetch('/api/rewards/admin/export', { headers: { 'x-admin-key': KEY || '' } })
      .then(function (r) { if (!r.ok) throw new Error('Export impossible (erreur ' + r.status + ')'); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'operations-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      })
      .catch(function (e) { notice(e.message, true); });
  });

  $('legacyBtn').addEventListener('click', function () {
    var email = $('legacyEmail').value.trim();
    if (!email) return;
    api('/legacy-reset', { method: 'POST', body: { email: email } }).then(function (r) {
      notice(r.ok ? 'Reprise relancée : l’élève doit se reconnecter (ou recharger la page).' : (r.error || 'Erreur'), !r.ok);
    });
  });

  $('toggleBtn').addEventListener('click', function () {
    var next = !cfg.withdrawalsEnabled;
    if (!confirm(next ? 'Ouvrir les retraits et le mode récompense pour tous les élèves ?' : 'Fermer les retraits et le mode récompense ? Plus personne ne pourra payer un dépôt : tout le monde jouera en jeu libre. Les élèves déjà en mode récompense gardent leur dépôt et peuvent le récupérer en quittant.')) return;
    api('/config', { method: 'POST', body: { withdrawalsEnabled: next } }).then(function (r) { notice(r.ok ? 'Réglage enregistré.' : (r.error || 'Erreur'), !r.ok); load(); });
  });

  $('saveBtn').addEventListener('click', function () {
    var body = {
      pointValueCents: Math.round(parseFloat($('pointValue').value) * 100),
      minWithdrawalCents: Math.round(parseFloat($('minWithdrawal').value) * 100),
      dailyVideoLimit: parseInt($('dailyLimit').value, 10),
      depositCents: Math.round(parseFloat($('depositAmount').value) * 100),
      depositRefundDays: parseInt($('depositDays').value, 10),
      depositInstructions: $('depositInstructions').value
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
