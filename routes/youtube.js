const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_SEARCH_URL =
  'https://www.googleapis.com/youtube/v3/search';

const YOUTUBE_VIDEOS_URL =
  'https://www.googleapis.com/youtube/v3/videos';

const LANGUAGES = {
  fr: {
    name: 'Francais',
    relevanceLanguage: 'fr',
    keywords: [
      'francais',
      'france',
      'francophone'
    ]
  },

  en: {
    name: 'English',
    relevanceLanguage: 'en',
    keywords: [
      'english',
      'learn',
      'explained'
    ]
  },

  ar: {
    name: 'Arabic',
    relevanceLanguage: 'ar',
    keywords: [
      'arabic',
      'العربية',
      'عربي'
    ]
  }
};

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
    query: 'cuisine cooking recipe'
  },

  culture: {
    name: 'Culture generale',
    query: 'culture general knowledge'
  }
};

function parseDuration(duration) {
  if (!duration) {
    return 0;
  }

  const match = duration.match(
    /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/
  );

  if (!match) {
    return 0;
  }

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(seconds) {
  const total = Number(seconds) || 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return (
      String(hours).padStart(2, '0') +
      ':' +
      String(minutes).padStart(2, '0') +
      ':' +
      String(secs).padStart(2, '0')
    );
  }

  return (
    String(minutes).padStart(2, '0') +
    ':' +
    String(secs).padStart(2, '0')
  );
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function categoryMatches(text, category) {
  const value = normalizeText(text);

  const keywords = {
    sport: [
      'sport',
      'football',
      'soccer',
      'basketball',
      'tennis',
      'rugby',
      'boxe',
      'boxing',
      'athletisme',
      'athletics',
      'natation',
      'swimming',
      'cyclisme',
      'cycling',
      'fitness',
      'olympique',
      'olympics'
    ],

    sciences: [
      'science',
      'scientifique',
      'physics',
      'physique',
      'chimie',
      'chemistry',
      'biologie',
      'biology',
      'astronomie',
      'astronomy',
      'espace',
      'space',
      'mathematique',
      'mathematics',
      'technologie',
      'technology',
      'intelligence artificielle',
      'artificial intelligence',
      'ia',
      'ai'
    ],

    cuisine: [
      'cuisine',
      'cooking',
      'recipe',
      'recette',
      'food',
      'plat',
      'dish',
      'chef',
      'restaurant',
      'gastronomie',
      'gastronomy',
      'dessert',
      'gateau',
      'cake',
      'patisserie',
      'baking'
    ],

    culture: [
      'culture',
      'history',
      'histoire',
      'geographie',
      'geography',
      'art',
      'litterature',
      'literature',
      'musique',
      'music',
      'cinema',
      'film',
      'civilisation',
      'civilization',
      'general knowledge',
      'connaissance',
      'quiz'
    ]
  };

  const list = keywords[category] || [];

  return list.some(keyword => {
    return value.includes(normalizeText(keyword));
  });
}

function languageLooksCorrect(video, language) {
  const title = normalizeText(video.title);
  const description = normalizeText(video.description);

  const text = title + ' ' + description;

  if (language === 'fr') {
    const frenchIndicators = [
      ' le ',
      ' la ',
      ' les ',
      ' des ',
      ' une ',
      ' un ',
      ' est ',
      ' avec ',
      ' pour ',
      ' dans ',
      ' comment ',
      ' pourquoi ',
      ' toutes ',
      ' cette ',
      ' science ',
      ' recette ',
      ' histoire '
    ];

    return frenchIndicators.some(word => {
      return text.includes(word);
    });
  }

  if (language === 'en') {
    const englishIndicators = [
      ' the ',
      ' and ',
      ' with ',
      ' for ',
      ' this ',
      ' that ',
      ' how ',
      ' why ',
      ' what ',
      ' science ',
      ' recipe ',
      ' history '
    ];

    return englishIndicators.some(word => {
      return text.includes(word);
    });
  }

  if (language === 'ar') {
    const arabicPattern = /[\u0600-\u06FF]/;

    return arabicPattern.test(
      video.title + ' ' + video.description
    );
  }

  return true;
}

function calculateQualityScore(video, category, language) {
  let score = 0;

  const title = normalizeText(video.title);
  const description = normalizeText(video.description);

  const combined = title + ' ' + description;

  if (categoryMatches(combined, category)) {
    score += 40;
  }

  if (languageLooksCorrect(video, language)) {
    score += 30;
  }

  if (video.durationSeconds >= 60) {
    score += 10;
  }

  if (video.durationSeconds >= 120) {
    score += 5;
  }

  if (video.durationSeconds <= 1800) {
    score += 5;
  }

  if (video.description.length >= 50) {
    score += 5;
  }

  if (video.captionAvailable) {
    score += 5;
  }

  return score;
}

async function searchYouTube(
  language,
  category,
  pageToken = null
) {
  const languageInfo = LANGUAGES[language];
  const categoryInfo = CATEGORIES[category];

  const params = {
    key: process.env.YOUTUBE_API_KEY,
    part: 'snippet',
    type: 'video',

    q: categoryInfo.query,

    relevanceLanguage:
      languageInfo.relevanceLanguage,

    videoEmbeddable: 'true',

    videoSyndicated: 'true',

    videoCaption: 'closedCaption',

    safeSearch: 'moderate',

    maxResults: 50
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  const response = await axios.get(
    YOUTUBE_SEARCH_URL,
    {
      params,
      timeout: 20000
    }
  );

  return response.data;
}

async function getVideoDetails(videoIds) {
  if (!videoIds || videoIds.length === 0) {
    return [];
  }

  const response = await axios.get(
    YOUTUBE_VIDEOS_URL,
    {
      params: {
        key: process.env.YOUTUBE_API_KEY,
        part: 'snippet,contentDetails,status,statistics',
        id: videoIds.join(',')
      },
      timeout: 20000
    }
  );

  return response.data.items || [];
}

router.get('/search', async (req, res) => {
  try {
    const {
      language,
      category,
      pageToken
    } = req.query;

    if (!language || !LANGUAGES[language]) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid language',
        allowedLanguages: Object.keys(LANGUAGES)
      });
    }

    if (!category || !CATEGORIES[category]) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid category',
        allowedCategories: Object.keys(CATEGORIES)
      });
    }

    if (!process.env.YOUTUBE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'YOUTUBE_API_KEY is missing'
      });
    }

    console.log(
      'YouTube search: ' +
      LANGUAGES[language].name +
      ' / ' +
      CATEGORIES[category].name
    );

    const searchData = await searchYouTube(
      language,
      category,
      pageToken || null
    );

    const searchItems = searchData.items || [];

    const candidateIds = searchItems
      .filter(item => {
        return item.id && item.id.videoId;
      })
      .map(item => item.id.videoId);

    if (candidateIds.length === 0) {
      return res.json({
        ok: true,
        language: {
          code: language,
          name: LANGUAGES[language].name
        },
        category: {
          code: category,
          name: CATEGORIES[category].name
        },
        count: 0,
        candidates: [],
        nextPageToken:
          searchData.nextPageToken || null
      });
    }

    const details = await getVideoDetails(
      candidateIds
    );

    const videos = details
      .map(video => {
        const durationSeconds =
          parseDuration(
            video.contentDetails?.duration
          );

        const title =
          video.snippet?.title || '';

        const description =
          video.snippet?.description || '';

        const channelTitle =
          video.snippet?.channelTitle || '';

        const captionAvailable =
          video.contentDetails?.caption === 'true';

        const embeddable =
          video.status?.embeddable === true;

        const publicStatus =
          video.status?.privacyStatus === 'public';

        const regionRestricted =
          video.contentDetails?.regionRestriction;

        const videoObject = {
          videoId: video.id,

          title,

          description,

          channelTitle,

          publishedAt:
            video.snippet?.publishedAt || null,

          thumbnail:
            video.snippet?.thumbnails?.high?.url ||
            video.snippet?.thumbnails?.medium?.url ||
            video.snippet?.thumbnails?.default?.url ||
            null,

          duration:
            formatDuration(durationSeconds),

          durationSeconds,

          captionAvailable,

          embeddable,

          publicStatus,

          categoryId:
            video.snippet?.categoryId || null,

          defaultLanguage:
            video.snippet?.defaultLanguage || null,

          defaultAudioLanguage:
            video.snippet?.defaultAudioLanguage ||
            null,

          viewCount:
            video.statistics?.viewCount
              ? Number(video.statistics.viewCount)
              : 0,

          language,

          category
        };

        videoObject.qualityScore =
          calculateQualityScore(
            videoObject,
            category,
            language
          );

        videoObject.categoryMatch =
          categoryMatches(
            title + ' ' + description,
            category
          );

        videoObject.languageMatch =
          languageLooksCorrect(
            videoObject,
            language
          );

        return videoObject;
      })

      .filter(video => {
        if (!video.embeddable) {
          return false;
        }

        if (!video.publicStatus) {
          return false;
        }

        return true;
      })

      .filter(video => {
        if (!video.title) {
          return false;
        }

        return true;
      })

      .filter(video => {
        return video.durationSeconds >= 60;
      })

      .filter(video => {
        return video.durationSeconds <= 3600;
      })

      .filter(video => {
        return video.categoryMatch;
      })

      .filter(video => {
        return video.languageMatch;
      });

    const uniqueVideos = [];

    const seenIds = new Set();

    for (const video of videos) {
      if (seenIds.has(video.videoId)) {
        continue;
      }

      seenIds.add(video.videoId);

      uniqueVideos.push(video);
    }

    uniqueVideos.sort((a, b) => {
      return b.qualityScore - a.qualityScore;
    });

    const finalVideos =
      uniqueVideos.slice(0, 20);

    console.log(
      'YouTube candidates found: ' +
      searchItems.length
    );

    console.log(
      'YouTube videos accepted: ' +
      finalVideos.length
    );

    return res.json({
      ok: true,

      language: {
        code: language,
        name: LANGUAGES[language].name
      },

      category: {
        code: category,
        name: CATEGORIES[category].name
      },

      searched: searchItems.length,

      count: finalVideos.length,

      videos: finalVideos,

      nextPageToken:
        searchData.nextPageToken || null
    });

  } catch (error) {
    console.error(
      'YouTube search error:',
      error.response?.data ||
      error.message
    );

    return res.status(500).json({
      ok: false,
      error: 'YouTube search failed',
      details:
        error.response?.data?.error?.message ||
        error.message
    });
  }
});

module.exports = router;
