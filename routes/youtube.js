```javascript
const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_URL =
  'https://www.googleapis.com/youtube/v3/search';

// ---------------------------------------------------------
// Langues autorisées
// ---------------------------------------------------------

const LANGUAGES = {
  fr: {
    name: 'Français',
    relevanceLanguage: 'fr'
  },

  en: {
    name: 'English',
    relevanceLanguage: 'en'
  },

  ar: {
    name: 'العربية',
    relevanceLanguage: 'ar'
  }
};

// ---------------------------------------------------------
// Catégories de notre application
// ---------------------------------------------------------

const CATEGORIES = {
  sport: {
    name: 'Sport',
    query: 'sport'
  },

  sciences: {
    name: 'Sciences',
    query: 'science'
  },

  cuisine: {
    name: 'Art culinaire',
    query: 'cuisine cooking'
  },

  culture: {
    name: 'Culture générale',
    query: 'culture générale'
  }
};

// ---------------------------------------------------------
// GET /api/youtube/search
//
// Exemple :
// /api/youtube/search?language=fr&category=sciences
// ---------------------------------------------------------

router.get('/search', async (req, res) => {
  try {
    const { language, category } = req.query;

    // Vérification de la langue
    if (!language || !LANGUAGES[language]) {
      return res.status(400).json({
        ok: false,
        error: 'Langue invalide',
        allowedLanguages: Object.keys(LANGUAGES)
      });
    }

    // Vérification de la catégorie
    if (!category || !CATEGORIES[category]) {
      return res.status(400).json({
        ok: false,
        error: 'Catégorie invalide',
        allowedCategories: Object.keys(CATEGORIES)
      });
    }

    // Vérification de la clé API
    if (!process.env.YOUTUBE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'YOUTUBE_API_KEY est absente des variables Railway'
      });
    }

    const languageInfo = LANGUAGES[language];
    const categoryInfo = CATEGORIES[category];

    console.log(
      `🔎 Recherche YouTube : ${languageInfo.name} / ${categoryInfo.name}`
    );

    const response = await axios.get(YOUTUBE_API_URL, {
      params: {
        key: process.env.YOUTUBE_API_KEY,

        part: 'snippet',

        type: 'video',

        q: categoryInfo.query,

        relevanceLanguage: languageInfo.relevanceLanguage,

        videoEmbeddable: 'true',

        videoSyndicated: 'true',

        maxResults: 10,

        safeSearch: 'moderate'
      },

      timeout: 15000
    });

    const items = response.data.items || [];

    const videos = items
      .filter(item => item.id && item.id.videoId)
      .map(item => ({
        videoId: item.id.videoId,

        title: item.snippet?.title || '',

        description: item.snippet?.description || '',

        channelTitle: item.snippet?.channelTitle || '',

        publishedAt: item.snippet?.publishedAt || null,

        thumbnail:
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          null,

        language,

        category
      }));

    return res.json({
      ok: true,

      language: {
        code: language,
        name: languageInfo.name
      },

      category: {
        code: category,
        name: categoryInfo.name
      },

      count: videos.length,

      videos
    });

  } catch (error) {

    console.error(
      '❌ Erreur YouTube:',
      error.response?.data || error.message
    );

    return res.status(500).json({
      ok: false,
      error: 'Erreur lors de la recherche YouTube',

      details:
        error.response?.data?.error?.message ||
        error.message
    });
  }
});

module.exports = router;
```
