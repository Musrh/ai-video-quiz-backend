const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const youtubeRouter = require('./routes/youtube');
const contentRouter = require('./routes/content');
const questionsRouter = require('./routes/questions');

const ieltsRouter = require('./routes/ielts');
const ieltsLibraryRouter = require('./routes/ieltsLibrary');

const { adminGuard } = ieltsLibraryRouter;

const app = express();






app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    ok: true,
    app: 'AI Video Quiz Backend',
    version: '1.0.0'
  });
});

app.use('/api/youtube', youtubeRouter);
app.use('/api/youtube', contentRouter);
app.use('/api/youtube', questionsRouter);

// Anciennes adresses IELTS qui lancent des recherches et des analyses (elles
// consomment du crédit) : réservées à l'administrateur (mot de passe dans
// l'en-tête x-admin-key, ou "?key=..." dans l'adresse).
app.use('/api/youtube/ielts/test-video', adminGuard(true));
app.use('/api/youtube/ielts/test-ocr', adminGuard(true));
app.use('/api/youtube/ielts/test-transcript', adminGuard(true));
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    req.path.replace(/\/+$/, '') === '/api/youtube/ielts'
  ) {
    return adminGuard(true)(req, res, next);
  }

  return next();
});

app.use('/api/youtube', ieltsRouter);

// Bibliothèque IELTS (vidéos sauvegardées) + page web /ielts-app
app.use('/', ieltsLibraryRouter);


const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'AI Video Quiz backend running on port ' + PORT
  );
});
