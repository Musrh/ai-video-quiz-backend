/* =========================================================
   IELTS Listening : relie index.html à la bibliothèque du serveur
   (liste des tests enregistrés, vidéo, vrai test, réponses,
   espace administrateur pour ajouter ou chercher des vidéos).
   À charger APRÈS le script principal de index.html (balise script avec
   src="ielts-library.js"). index.html l'appelle avec
   window.IeltsLibrary.load() et window.IeltsLibrary.render().
   ========================================================= */
(function () {
  'use strict';

  var LIB_BASE = API_BASE + '/api/youtube/ielts/library';

  // ---------- Textes (FR / EN / AR) ----------
  var TEXT = {
    fr: {
      libEmptyUser: 'Aucun test IELTS disponible pour le moment.',
      libEmptyAdmin: 'Aucune vidéo pour le moment. Utilise « Afficher plus de vidéos » ou ajoute un lien.',
      libShowVideo: 'Afficher la vidéo', libStartTest: 'Commencer le test', libPreparing: 'Test en préparation…',
      libQuestions: 'questions', libReview: 'À relire', libAnalyzing: 'analyse en cours…', libQueued: 'en attente', libFailed: 'échec',
      libMsgAnalyzing: 'Analyse en cours : tu peux déjà regarder la vidéo, le test sera prêt dans quelques minutes.',
      libMsgQueued: 'En attente d’analyse : tu peux déjà regarder la vidéo.', libMsgFailed: 'Analyse impossible pour cette vidéo.',
      libRetry: 'Réessayer', libClose: 'Fermer', libDelete: 'Supprimer', libConfirmDelete: 'Supprimer cette vidéo de la bibliothèque ?', libYourAnswer: 'Ta réponse', libChoose: '— choisir —',
      libShowAnswers: 'Afficher les réponses', libHideAnswers: 'Masquer les réponses', libAnswer: 'Réponse',
      libAnswerNA: 'Réponse non disponible', libScore: 'Score', libLoadingQuestions: 'Chargement des questions…',
      libAdmin: 'Espace administrateur', libLogout: 'Se déconnecter (administrateur)', libPassword: 'Mot de passe administrateur',
      libValidate: 'Valider', libChecking: 'Vérification…', libWrongPass: 'Mot de passe incorrect.', libConnFail: 'Connexion impossible, réessaie.',
      libAddPlaceholder: 'Lien ou identifiant YouTube', libAdd: 'Ajouter', libMore: 'Afficher plus de vidéos',
      libPasteLink: 'Colle un lien ou un identifiant YouTube.', libSearching: '🔎 Recherche de la vidéo…',
      libExists: '✅ Vidéo existante :', libExistsEnd: 'Elle est déjà dans la liste.',
      libAlreadyRunning: '⏳ Cette vidéo est déjà en cours d’analyse.', libFound: 'Vidéo trouvée :',
      libFoundEnd: 'Analyse lancée : tu peux déjà la regarder, le test sera prêt dans quelques minutes.',
      libWorking: 'Traitement en cours…', libWaiting: 'en attente', libAdded: 'ajoutées',
      libLoadError: 'Impossible de charger les tests IELTS pour le moment.'
    },
    en: {
      libEmptyUser: 'No IELTS test is available yet.',
      libEmptyAdmin: 'No video yet. Use “Show more videos” or add a link.',
      libShowVideo: 'Show the video', libStartTest: 'Start the test', libPreparing: 'Test being prepared…',
      libQuestions: 'questions', libReview: 'Needs review', libAnalyzing: 'analysis in progress…', libQueued: 'waiting', libFailed: 'failed',
      libMsgAnalyzing: 'Analysis in progress: you can already watch the video, the test will be ready in a few minutes.',
      libMsgQueued: 'Waiting for analysis: you can already watch the video.', libMsgFailed: 'This video could not be analyzed.',
      libRetry: 'Try again', libClose: 'Close', libDelete: 'Delete', libConfirmDelete: 'Remove this video from the library?', libYourAnswer: 'Your answer', libChoose: '— choose —',
      libShowAnswers: 'Show answers', libHideAnswers: 'Hide answers', libAnswer: 'Answer',
      libAnswerNA: 'Answer not available', libScore: 'Score', libLoadingQuestions: 'Loading questions…',
      libAdmin: 'Administrator area', libLogout: 'Log out (administrator)', libPassword: 'Administrator password',
      libValidate: 'Confirm', libChecking: 'Checking…', libWrongPass: 'Wrong password.', libConnFail: 'Connection failed, try again.',
      libAddPlaceholder: 'YouTube link or ID', libAdd: 'Add', libMore: 'Show more videos',
      libPasteLink: 'Paste a YouTube link or ID.', libSearching: '🔎 Looking for the video…',
      libExists: '✅ Video already exists:', libExistsEnd: 'It is already in the list.',
      libAlreadyRunning: '⏳ This video is already being analyzed.', libFound: 'Video found:',
      libFoundEnd: 'Analysis started: you can already watch it, the test will be ready in a few minutes.',
      libWorking: 'Working…', libWaiting: 'waiting', libAdded: 'added',
      libLoadError: 'Unable to load IELTS tests right now.'
    },
    ar: {
      libEmptyUser: 'لا توجد اختبارات IELTS متاحة حاليا.',
      libEmptyAdmin: 'لا توجد فيديوهات بعد. استخدم «عرض المزيد من الفيديوهات» أو أضف رابطا.',
      libShowVideo: 'عرض الفيديو', libStartTest: 'ابدأ الاختبار', libPreparing: 'الاختبار قيد الإعداد…',
      libQuestions: 'سؤالا', libReview: 'قيد المراجعة', libAnalyzing: 'جار التحليل…', libQueued: 'في الانتظار', libFailed: 'فشل',
      libMsgAnalyzing: 'التحليل جار: يمكنك مشاهدة الفيديو الآن، وسيكون الاختبار جاهزا خلال دقائق.',
      libMsgQueued: 'في انتظار التحليل: يمكنك مشاهدة الفيديو الآن.', libMsgFailed: 'تعذر تحليل هذا الفيديو.',
      libRetry: 'إعادة المحاولة', libClose: 'إغلاق', libDelete: 'حذف', libConfirmDelete: 'حذف هذا الفيديو من المكتبة؟', libYourAnswer: 'إجابتك', libChoose: '— اختر —',
      libShowAnswers: 'عرض الإجابات', libHideAnswers: 'إخفاء الإجابات', libAnswer: 'الإجابة',
      libAnswerNA: 'الإجابة غير متوفرة', libScore: 'النتيجة', libLoadingQuestions: 'جار تحميل الأسئلة…',
      libAdmin: 'مساحة المشرف', libLogout: 'تسجيل الخروج (مشرف)', libPassword: 'كلمة مرور المشرف',
      libValidate: 'تأكيد', libChecking: 'جار التحقق…', libWrongPass: 'كلمة المرور غير صحيحة.', libConnFail: 'تعذر الاتصال، حاول مرة أخرى.',
      libAddPlaceholder: 'رابط أو معرف YouTube', libAdd: 'إضافة', libMore: 'عرض المزيد من الفيديوهات',
      libPasteLink: 'ألصق رابط أو معرف YouTube.', libSearching: '🔎 جار البحث عن الفيديو…',
      libExists: '✅ الفيديو موجود:', libExistsEnd: 'هو موجود بالفعل في القائمة.',
      libAlreadyRunning: '⏳ هذا الفيديو قيد التحليل بالفعل.', libFound: 'تم العثور على الفيديو:',
      libFoundEnd: 'بدأ التحليل: يمكنك مشاهدته الآن، وسيكون الاختبار جاهزا خلال دقائق.',
      libWorking: 'جار المعالجة…', libWaiting: 'في الانتظار', libAdded: 'تمت إضافتها',
      libLoadError: 'تعذر تحميل اختبارات IELTS حاليا.'
    }
  };

  function L(key) {
    var pack = TEXT[interfaceLanguage] || TEXT.fr;
    return pack[key] !== undefined ? pack[key] : TEXT.fr[key];
  }

  // ---------- Styles (ajoutés sans toucher au CSS de index.html) ----------
  var style = document.createElement('style');
  style.textContent = [
    '.ielts-video-card.lib-open{grid-column:1 / -1}',
    '.lib-player{position:relative;width:100%;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;background:#000;margin:12px 0}',
    '.lib-player iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}',
    '.lib-msg{color:#64748b;font-size:13px;margin:6px 0;line-height:1.5}',
    '.lib-issues{color:#b45309;font-size:13px;margin:6px 0;padding-left:18px;line-height:1.5}',
    '[dir="rtl"] .lib-issues{padding-left:0;padding-right:18px}',
    '.lib-row{display:flex;gap:8px;margin-top:8px}.lib-row button{flex:1}',
    '.lib-chip-review{background:#fef3c7;color:#92400e}.lib-chip-wait{background:#e0e7ff;color:#3730a3}.lib-chip-bad{background:#fee2e2;color:#991b1b}',
    '.lib-secondary{background:#fff;color:#4f46e5;border:1px solid #a5b4fc;box-shadow:none}',
    '.lib-test{margin-top:14px;border-top:1px solid #e2e8f0;padding-top:12px}',
    '.lib-head{margin:16px 0 6px;padding:10px 12px;border-left:4px solid #4f46e5;background:#f8fafc;border-radius:8px;font-size:14px;line-height:1.5}',
    '[dir="rtl"] .lib-head{border-left:0;border-right:4px solid #4f46e5}',
    '.lib-head b{display:block}',
    '.lib-opts{margin:6px 0 0;padding-left:20px;font-size:14px;line-height:1.6}',
    '[dir="rtl"] .lib-opts{padding-left:0;padding-right:20px}',
    '.lib-q{padding:12px 0;border-bottom:1px solid #e2e8f0}',
    '.lib-qtext{margin:0 0 8px;font-weight:700;line-height:1.45}',
    '.lib-choice{display:flex;align-items:flex-start;gap:8px;padding:6px 0;cursor:pointer;line-height:1.45}',
    '.lib-choice input{margin-top:4px}',
    '.lib-input,.lib-select{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;font-size:16px;color:inherit}',
    '.lib-answer{margin-top:8px;font-weight:700;font-size:14px}',
    '.lib-answer.right{color:#16a34a}.lib-answer.wrong{color:#dc2626}.lib-answer.plain{color:#4f46e5}',
    '.lib-score{font-weight:800;font-size:18px;margin:14px 0;text-align:center}',
    '.lib-notice{padding:10px 12px;border-radius:10px;margin:10px 0;font-size:14px;border:1px solid #e2e8f0;background:#fff;line-height:1.5}',
    '.lib-notice.info{border-color:#4f46e5}.lib-notice.ok{border-color:#16a34a;color:#166534}.lib-notice.warn{border-color:#d97706;color:#92400e}',
    '.lib-add{display:flex;gap:8px;margin:12px 0}.lib-add input{flex:1}',
    '.lib-foot{margin-top:26px;padding-top:12px;border-top:1px solid #e2e8f0;text-align:center}',
    '.lib-link{background:transparent;color:#64748b;box-shadow:none;padding:6px 8px;font-size:13px;font-weight:600;text-decoration:underline}',
    '.lib-foot .lib-row{max-width:420px;margin:8px auto 0}',
    '.lib-flash{outline:3px solid #4f46e5}'
  ].join('\n');
  document.head.appendChild(style);

  // ---------- Outils ----------
  var KEY = null;
  try { KEY = localStorage.getItem('ieltsAdminKey'); } catch (e) {}

  var isAdminUI = false;
  var cards = {};
  var pollTimer = null;
  var noticeTimer = null;
  var ui = null;

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
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
    return fetch(LIB_BASE + path, options).then(function (r) { return r.json(); });
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Accepte les variantes de la réponse : "colour / color"
  function matches(mine, correct) {
    var m = norm(mine);
    if (!m) return false;
    return String(correct).split(/\s*(?:\/|\bor\b)\s*/i).some(function (alt) { return norm(alt) === m; });
  }

  function cleanText(q) {
    var text = q.text || '';
    if (/^\(\d{1,2}\)\s*/.test(text)) return text.replace(/^\(\d{1,2}\)\s*/, '');
    return text.replace(/\(\d{1,2}\)/g, '________');
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  }

  function isReady(v) { return v.status === 'ok' || v.status === 'to_review'; }

  // ---------- Messages à l'administrateur ----------
  function showNotice(text, kind, seconds) {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (!text) { ui.notice.hidden = true; return; }
    ui.notice.hidden = false;
    ui.notice.className = 'lib-notice ' + (kind || 'info');
    ui.notice.textContent = text;
    if (seconds) noticeTimer = setTimeout(function () { ui.notice.hidden = true; }, seconds * 1000);
  }

  function showStatus(text) {
    if (!text) { ui.status.hidden = true; return; }
    ui.status.hidden = false;
    ui.status.className = 'lib-notice';
    ui.status.textContent = text;
  }

  function updateStatus(s) {
    ui.moreBtn.disabled = !!s.searchActive;
    if (s.running) {
      var text = s.message || L('libWorking');
      if (s.search) text += '  (' + s.search.analyzed + '/' + s.search.target + ' ' + L('libAdded') + ')';
      if (s.queueLength > 1) text += '  — ' + (s.queueLength - 1) + ' ' + L('libWaiting');
      showStatus(text);
    } else if (s.lastError) {
      showStatus('⚠️ ' + s.lastError + (s.lastMessage ? ' — ' + s.lastMessage : ''));
    } else {
      showStatus(s.lastMessage || '');
    }
  }

  function highlight(videoId) {
    var c = cards[videoId];
    if (!c) return;
    if (c.node.scrollIntoView) c.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.node.classList.add('lib-flash');
    setTimeout(function () { c.node.classList.remove('lib-flash'); }, 2500);
  }

  // ---------- Interface administrateur + zones ajoutées à la page ----------
  function retextStatic() {
    if (!ui) return;
    ui.addInput.placeholder = L('libAddPlaceholder');
    ui.addBtn.textContent = L('libAdd');
    ui.moreBtn.textContent = L('libMore');
    ui.adminLink.textContent = isAdminUI ? L('libLogout') : L('libAdmin');
    ui.pass.placeholder = L('libPassword');
    ui.loginBtn.textContent = L('libValidate');
    ui.empty.textContent = isAdminUI ? L('libEmptyAdmin') : L('libEmptyUser');
  }

  function setAdminUI(on) {
    isAdminUI = on;
    ui.top.hidden = !on;
    ui.more.hidden = !on;
    retextStatic();
  }

  function resetCards() {
    Object.keys(cards).forEach(function (id) { cards[id].node.remove(); });
    cards = {};
  }

  function forgetKey() {
    KEY = null;
    try { localStorage.removeItem('ieltsAdminKey'); } catch (e) {}
  }

  function ensureUI() {
    if (ui) return;
    ui = {};

    // Zone d'ajout (administrateur)
    ui.addInput = el('input', { type: 'text', class: 'lib-input', autocomplete: 'off', autocapitalize: 'off' });
    ui.addBtn = el('button', { type: 'button' });
    ui.notice = el('div', { class: 'lib-notice', hidden: '' });
    ui.status = el('div', { class: 'lib-notice', hidden: '' });
    ui.top = el('div', { hidden: '' }, [el('div', { class: 'lib-add' }, [ui.addInput, ui.addBtn]), ui.notice, ui.status]);
    ieltsScreen.insertBefore(ui.top, ieltsError);

    // Message "aucune vidéo"
    ui.empty = el('div', { class: 'ielts-empty', hidden: '' });
    ieltsScreen.insertBefore(ui.empty, ieltsVideoGrid);

    // Bouton "Afficher plus de vidéos" (administrateur)
    ui.moreBtn = el('button', { type: 'button', class: 'ielts-watch primary' });
    ui.more = el('div', { hidden: '', style: 'margin-top:16px' }, [ui.moreBtn]);

    // Connexion administrateur
    ui.adminLink = el('button', { type: 'button', class: 'lib-link' });
    ui.pass = el('input', { type: 'password', class: 'lib-input', autocomplete: 'current-password' });
    ui.loginBtn = el('button', { type: 'button' });
    ui.loginBox = el('div', { class: 'lib-row', hidden: '' }, [ui.pass, ui.loginBtn]);
    ui.loginMsg = el('div', { class: 'lib-msg' });
    ui.foot = el('div', { class: 'lib-foot' }, [ui.adminLink, ui.loginBox, ui.loginMsg]);

    ieltsVideoGrid.parentNode.insertBefore(ui.more, ieltsVideoGrid.nextSibling);
    ui.more.parentNode.insertBefore(ui.foot, ui.more.nextSibling);

    ui.addBtn.addEventListener('click', addVideo);
    ui.addInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') addVideo(); });

    ui.moreBtn.addEventListener('click', function () {
      ui.moreBtn.disabled = true;
      api('/search-more', { method: 'POST', body: { count: 3 } }).then(function (r) {
        if (r.ok === false) showNotice('⚠️ ' + (r.error || 'Erreur'), 'warn', 10);
        refreshAll();
        schedulePoll();
      });
    });

    ui.adminLink.addEventListener('click', function () {
      if (isAdminUI) {
        forgetKey();
        resetCards();
        ui.loginMsg.textContent = '';
        refreshAll();
      } else {
        ui.loginBox.hidden = !ui.loginBox.hidden;
        ui.loginMsg.textContent = '';
        if (!ui.loginBox.hidden) ui.pass.focus();
      }
    });

    ui.loginBtn.addEventListener('click', login);
    ui.pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

    retextStatic();
  }

  function login() {
    var value = ui.pass.value;
    if (!value) return;
    ui.loginMsg.textContent = L('libChecking');
    fetch(LIB_BASE + '/admin-check', { headers: { 'x-admin-key': value } })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) {
          KEY = value;
          try { localStorage.setItem('ieltsAdminKey', value); } catch (e) {}
          ui.pass.value = '';
          ui.loginBox.hidden = true;
          ui.loginMsg.textContent = '';
          resetCards();
          refreshAll();
        } else {
          ui.loginMsg.textContent = r.error || L('libWrongPass');
        }
      })
      .catch(function () { ui.loginMsg.textContent = L('libConnFail'); });
  }

  function addVideo() {
    var value = ui.addInput.value.trim();
    if (!value) { showNotice(L('libPasteLink'), 'warn', 6); return; }

    ui.addBtn.disabled = true;
    ui.addInput.disabled = true;
    showNotice(L('libSearching'), 'info');

    api('/analyze', { method: 'POST', body: { videoId: value } }).then(function (r) {
      var id = r.video && r.video.videoId;
      var title = r.video && r.video.title ? ' « ' + r.video.title + ' »' : '';

      if (r.ok === false) { showNotice('⚠️ ' + (r.error || 'Erreur'), 'warn', 10); return; }

      ui.addInput.value = '';
      if (r.status === 'exists') showNotice(L('libExists') + title + '. ' + L('libExistsEnd'), 'ok', 10);
      else if (r.status === 'already_queued') showNotice(L('libAlreadyRunning'), 'info', 10);
      else showNotice(L('libFound') + title + '. ' + L('libFoundEnd'), 'ok', 12);

      schedulePoll();
      return refreshAll().then(function () { if (id) highlight(id); });
    }).catch(function () {
      showNotice('⚠️ ' + L('libConnFail'), 'warn', 10);
    }).then(function () {
      ui.addBtn.disabled = false;
      ui.addInput.disabled = false;
    });
  }

  // ---------- Mise à jour de la liste ----------
  function schedulePoll() {
    if (!pollTimer) pollTimer = setInterval(function () {
      if (state.screen !== 'ielts') { stopPoll(); return; }
      refreshAll();
    }, 4000);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function refreshAll() {
    ensureUI();
    return api('').then(function (data) {
      if (!data || data.ok === false) throw new Error('api');
      ieltsError.classList.add('hidden');

      // Mot de passe enregistré mais refusé par le serveur : on l'oublie
      if (KEY && !data.admin) forgetKey();
      setAdminUI(!!data.admin);

      reconcile(data.videos || []);

      if (data.admin) {
        updateStatus(data.status);
        if (data.status.running) schedulePoll(); else stopPoll();
      } else {
        stopPoll();
      }
    }).catch(function () {
      if (!Object.keys(cards).length) {
        ieltsError.textContent = L('libLoadError');
        ieltsError.classList.remove('hidden');
      }
      if (isAdminUI) schedulePoll();
    });
  }

  // Met à jour sans toucher aux cartes déjà affichées (la vidéo ouverte ne se recharge pas)
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
        ieltsVideoGrid.insertBefore(c.node, ieltsVideoGrid.firstChild);
      }
    });

    ui.empty.hidden = videos.length > 0;
  }

  // ---------- Carte d'une vidéo ----------
  function chipFor(v) {
    if (v.status === 'ok') return null;
    if (v.status === 'to_review') return { cls: 'lib-chip-review', text: L('libReview') };
    if (v.status === 'analyzing') return { cls: 'lib-chip-wait', text: L('libAnalyzing') };
    if (v.status === 'queued') return { cls: 'lib-chip-wait', text: L('libQueued') };
    return { cls: 'lib-chip-bad', text: L('libFailed') };
  }

  function createCard(v) {
    var c = { v: v, playerShown: false, testStarted: false, startState: '', actionKey: '' };

    c.node = el('article', { class: 'ielts-video-card' });
    c.node.appendChild(el('img', {
      class: 'ielts-thumbnail',
      src: v.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(v.videoId) + '/hqdefault.jpg'),
      alt: '', loading: 'lazy'
    }));

    var body = el('div', { class: 'ielts-video-body' });
    c.title = el('div', { class: 'ielts-video-title' });
    c.channel = el('div', { class: 'ielts-video-channel' });
    c.meta = el('div', { class: 'ielts-video-meta' });
    c.issues = el('ul', { class: 'lib-issues' });
    c.msg = el('div', { class: 'lib-msg' });
    c.actions = el('div', { class: 'lib-row' });
    c.area = el('div');
    c.startBox = el('div');

    c.showBtn = el('button', { type: 'button', class: 'ielts-watch' });
    c.showBtn.addEventListener('click', function () {
      c.showBtn.remove();
      c.playerShown = true;
      c.node.classList.add('lib-open');
      c.area.appendChild(el('div', { class: 'lib-player' }, [
        el('iframe', {
          src: 'https://www.youtube.com/embed/' + encodeURIComponent(c.v.videoId),
          title: c.v.title || 'YouTube video player',
          allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
          allowfullscreen: ''
        })
      ]));
      c.area.appendChild(c.startBox);
      renderStart(c);
    });

    [c.title, c.channel, c.meta, c.issues, c.msg, c.actions, c.showBtn, c.area].forEach(function (n) { body.appendChild(n); });
    c.node.appendChild(body);

    updateCard(c, v);
    return c;
  }

  function updateCard(c, v) {
    c.v = v;
    c.title.textContent = v.title || v.videoId;
    c.channel.textContent = (v.channelTitle ? t('ieltsChannel') + ': ' + v.channelTitle : '');
    c.showBtn.textContent = L('libShowVideo');

    // Pastilles : langue, durée, nombre de questions, état
    c.meta.innerHTML = '';
    c.meta.appendChild(el('span', { class: 'ielts-meta', text: t('ieltsEnglish') }));
    if (v.durationSeconds) c.meta.appendChild(el('span', { class: 'ielts-meta', text: t('ieltsDuration') + ': ' + fmtDuration(v.durationSeconds) }));
    if (isReady(v)) c.meta.appendChild(el('span', { class: 'ielts-meta', text: v.questionCount + ' ' + L('libQuestions') }));
    var chip = chipFor(v);
    if (chip) c.meta.appendChild(el('span', { class: 'ielts-meta ' + chip.cls, text: chip.text }));

    // Détails techniques : administrateur seulement
    c.issues.innerHTML = '';
    if (isAdminUI) (v.issues || []).forEach(function (i) { c.issues.appendChild(el('li', { text: i })); });

    if (v.status === 'analyzing') c.msg.textContent = L('libMsgAnalyzing');
    else if (v.status === 'queued') c.msg.textContent = L('libMsgQueued');
    else if (v.status === 'failed') c.msg.textContent = '⚠️ ' + (v.error || L('libMsgFailed'));
    else c.msg.textContent = '';

    // "Réessayer" / "Fermer" : administrateur seulement, reconstruits si l'état change
    var key = isAdminUI ? (v.status === 'failed' ? 'failed' : (isReady(v) ? 'ready' : '')) : '';
    if (key !== c.actionKey) {
      c.actionKey = key;
      c.actions.innerHTML = '';
      if (key === 'ready') {
        var del = el('button', { type: 'button', class: 'lib-secondary', text: L('libDelete') });
        del.addEventListener('click', function () {
          if (!confirm(L('libConfirmDelete'))) return;
          api('/' + encodeURIComponent(v.videoId), { method: 'DELETE' }).then(refreshAll);
        });
        c.actions.appendChild(del);
      }
      if (key === 'failed') {
        var retry = el('button', { type: 'button', class: 'lib-secondary', text: L('libRetry') });
        retry.addEventListener('click', function () {
          api('/analyze', { method: 'POST', body: { videoId: v.videoId, force: true } }).then(function () { refreshAll(); schedulePoll(); });
        });
        var close = el('button', { type: 'button', class: 'lib-secondary', text: L('libClose') });
        close.addEventListener('click', function () {
          api('/' + encodeURIComponent(v.videoId), { method: 'DELETE' }).then(refreshAll);
        });
        c.actions.appendChild(retry);
        c.actions.appendChild(close);
      }
    }

    renderStart(c);
  }

  // Bouton du test : grisé pendant l'analyse, actif dès que le test est prêt
  function renderStart(c) {
    if (!c.playerShown || c.testStarted) return;
    var state_ = isReady(c.v) ? 'ready' : (c.v.status === 'failed' ? 'none' : 'wait');

    if (state_ === c.startState) {
      var current = c.startBox.firstChild;
      if (current) current.textContent = state_ === 'ready' ? L('libStartTest') : L('libPreparing');
      return;
    }

    c.startState = state_;
    c.startBox.innerHTML = '';
    if (state_ === 'ready') {
      var btn = el('button', { type: 'button', class: 'ielts-watch primary', style: 'margin-top:8px', text: L('libStartTest') });
      btn.addEventListener('click', function () {
        c.testStarted = true;
        c.startBox.innerHTML = '';
        loadTest(c);
      });
      c.startBox.appendChild(btn);
    } else if (state_ === 'wait') {
      var wait = el('button', { type: 'button', class: 'ielts-watch lib-secondary', style: 'margin-top:8px', text: L('libPreparing') });
      wait.disabled = true;
      c.startBox.appendChild(wait);
    }
  }

  // ---------- Le test ----------
  function loadTest(c) {
    var v = c.v;
    var box = el('div', { class: 'lib-test' }, [el('div', { class: 'lib-msg', text: L('libLoadingQuestions') })]);
    c.area.appendChild(box);

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
          var head = el('div', { class: 'lib-head' });
          if (q.instructions) head.appendChild(el('b', { text: q.instructions }));
          if (q.context) head.appendChild(el('span', { text: q.context }));
          box.appendChild(head);
        }
        lastHead = headKey;

        var optKey = JSON.stringify(q.options || []);
        if (q.options && q.options.length && optKey !== lastOptions) {
          var ul = el('ul', { class: 'lib-opts' });
          q.options.forEach(function (o) { ul.appendChild(el('li', { text: o.letter + ' — ' + o.text })); });
          box.appendChild(ul);
        }
        lastOptions = optKey;

        var block = el('div', { class: 'lib-q' });
        block.appendChild(el('p', { class: 'lib-qtext', text: q.number + '. ' + cleanText(q) }));

        var name = 'lib_' + v.videoId + '_' + q.number;
        if (q.choices && q.choices.length) {
          q.choices.forEach(function (ch) {
            var radio = el('input', { type: 'radio', name: name, value: ch.letter });
            block.appendChild(el('label', { class: 'lib-choice' }, [radio, el('span', { text: ch.letter + '. ' + ch.text })]));
          });
          inputs[q.number] = function () {
            var checked = block.querySelector('input[name="' + name + '"]:checked');
            return checked ? checked.value : '';
          };
        } else if (q.options && q.options.length) {
          var select = el('select', { class: 'lib-select' });
          select.appendChild(el('option', { value: '', text: L('libChoose') }));
          q.options.forEach(function (o) { select.appendChild(el('option', { value: o.letter, text: o.letter + ' — ' + o.text })); });
          block.appendChild(select);
          inputs[q.number] = function () { return select.value; };
        } else {
          var input = el('input', { type: 'text', class: 'lib-input', placeholder: L('libYourAnswer'), autocomplete: 'off', autocapitalize: 'off' });
          block.appendChild(input);
          inputs[q.number] = function () { return input.value; };
        }

        var ans = el('div', { class: 'lib-answer', hidden: '' });
        block.appendChild(ans);
        answerEls[q.number] = ans;
        box.appendChild(block);
      });

      var scoreEl = el('div', { class: 'lib-score', hidden: '' });
      var shown = false;
      var answers = null;

      var btn = el('button', { type: 'button', class: 'ielts-watch primary', style: 'margin-top:14px', text: L('libShowAnswers') });
      btn.addEventListener('click', function () {
        if (shown) {
          Object.keys(answerEls).forEach(function (n) { answerEls[n].hidden = true; });
          scoreEl.hidden = true;
          btn.textContent = L('libShowAnswers');
          shown = false;
          return;
        }
        var render = function () {
          var good = 0, total = 0;
          Object.keys(answerEls).forEach(function (n) {
            var correct = answers[n];
            var node = answerEls[n];
            node.hidden = false;
            if (!correct) { node.className = 'lib-answer plain'; node.textContent = L('libAnswerNA'); return; }
            total++;
            var mine = inputs[n]();
            if (matches(mine, correct)) {
              good++;
              node.className = 'lib-answer right';
              node.textContent = '✓ ' + correct;
            } else if (mine) {
              node.className = 'lib-answer wrong';
              node.textContent = '✗ ' + L('libAnswer') + ' : ' + correct;
            } else {
              node.className = 'lib-answer plain';
              node.textContent = L('libAnswer') + ' : ' + correct;
            }
          });
          scoreEl.hidden = false;
          scoreEl.textContent = L('libScore') + ' : ' + good + ' / ' + total;
          btn.textContent = L('libHideAnswers');
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
    }).catch(function () {
      box.textContent = L('libConnFail');
    });
  }

  // ---------- Point d'entrée appelé par index.html ----------
  // (l'ancienne adresse /api/youtube/ielts est maintenant réservée à l'administrateur)
  window.IeltsLibrary = {
    // Affiche la liste des tests enregistrés
    load: function () {
      if (!requireLogin()) return Promise.resolve();
      ensureUI();
      ieltsError.classList.add('hidden');
      if (!Object.keys(cards).length) ieltsLoading.classList.remove('hidden');
      return refreshAll().then(function () { ieltsLoading.classList.add('hidden'); });
    },

    // Appelé quand la langue change : met à jour les textes sans recharger la liste
    render: function () {
      ensureUI();
      retextStatic();
      Object.keys(cards).forEach(function (id) { updateCard(cards[id], cards[id].v); });
    }
  };
})();
