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
    relevanceLanguage: 'fr'
  },

  en: {
    name: 'English',
    relevanceLanguage: 'en'
  },

  ar: {
    name: 'Arabic',
    relevanceLanguage: 'ar'
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
    query: 'culture history general knowledge'
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

function normalizeLanguage(language) {
  if (!language) {
    return '';
  }

  return String(language)
    .toLowerCase()
    .split('-')[0]
    .split('_')[0]
    .trim();
}

/*
 * IMPORTANT:
 *
 * defaultAudioLanguage is the strongest signal available
 * from the public YouTube Data API for the language spoken
 * in the default audio track.
 *
 * defaultLanguage identifies the language of the title
 * and description metadata.
 */
function getLanguageStatus(video, requestedLanguage) {
  const audioLanguage = normalizeLanguage(
    video.defaultAudioLanguage
  );

  const metadataLanguage = normalizeLanguage(
    video.defaultLanguage
  );

  const requested = normalizeLanguage(
    requestedLanguage
  );

  /*
   * Strong confirmation:
   * audio + metadata match requested language.
   */
  if (
    audioLanguage === requested &&
    metadataLanguage === requested
  ) {
    return 'strong';
  }

  /*
   * Audio is correct, metadata language missing.
   */
  if (
    audioLanguage === requested &&
    !metadataLanguage
  ) {
    return 'strong';
  }

  /*
   * Audio language is correct but metadata is another
   * language. We still accept because the spoken language
   * is the most important signal for the quiz.
   */
  if (
    audioLanguage === requested &&
    metadataLanguage !== requested
  ) {
    return 'audio_only';
  }

  /*
   * Metadata says the requested language but YouTube did
   * not specify the audio language.
   */
  if (
    !audioLanguage &&
    metadataLanguage === requested
  ) {
    return 'metadata_only';
  }

  /*
   * No language information at all.
   */
  if (!audioLanguage && !metadataLanguage) {
    return 'unknown';
  }

  /*
   * Explicitly another language.
   */
  return 'wrong';
}

function languageMatches(
  video,
  requestedLanguage
) {
  const status = getLanguageStatus(
    video,
    requestedLanguage
  );

  /*
   * V3 policy:
   *
   * We do NOT accept "unknown" anymore.
   *
   * This prevents us from returning videos whose language
   * cannot be verified.
   */
  return (
    status === 'strong' ||
    status === 'audio_only' ||
    status === 'metadata_only'
  );
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function categoryMatches(
  text,
  category
) {
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
      'olympics',
      'joueur',
      'match',
      'championnat'
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
      'ai',
      'univers',
      'terre',
      'planete',
      'planet',
      'quantique',
      'quantum',
      'energie',
      'energy',
      'cerveau',
      'brain',
      'genetique',
      'genetics'
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
      'baking',
      'ingredient',
      'ingredients',
      'viande',
      'poisson',
      'legumes',
      'vegetable'
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
      'quiz',
      'societe',
      'society',
      'patrimoine',
      'heritage',
      'philosophie',
      'philosophy'
    ]
  };

  const list =
    keywords[category] || [];

  return list.some(keyword => {
    return value.includes(
      normalizeText(keyword)
    );
  });
}

function calculateQualityScore(
  video,
  category,
  language
) {
  let score = 0;

  const languageStatus =
    getLanguageStatus(
      video,
      language
    );

  if (languageStatus === 'strong') {
    score += 50;
  } else if (languageStatus === 'audio_only') {
    score += 45;
  } else if (languageStatus === 'metadata_only') {
    score += 25;
  }

  if (
    categoryMatches(
      video.title + ' ' + video.description,
      category
    )
  ) {
    score += 25;
  }

  if (video.captionAvailable) {
    score += 10;
  }

  if (video.durationSeconds >= 120) {
    score += 5;
  }

  if (video.durationSeconds >= 300) {
    score += 5;
  }

  return score;
}

async function searchYouTube(
  language,
  category,
  pageToken
) {
  const languageInfo =
    LANGUAGES[language];

  const categoryInfo =
    CATEGORIES[category];

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

  const response =
    await axios.get(
      YOUTUBE_SEARCH_URL,
      {
        params,
        timeout: 20000
      }
    );

  return response.data;
}

async function getVideoDetails(
  videoIds
) {
  if (
    !videoIds ||
    videoIds.length === 0
  ) {
    return [];
  }

  const response =
    await axios.get(
      YOUTUBE_VIDEOS_URL,
      {
        params: {
          key: process.env.YOUTUBE_API_KEY,

          part:
            'snippet,contentDetails,status,statistics',

          id: videoIds.join(',')
        },

        timeout: 20000
      }
    );

  return response.data.items || [];
}

router.get(
  '/search',
  async (req, res) => {
    try {
      const {
        language,
        category,
        pageToken
      } = req.query;

      if (
        !language ||
        !LANGUAGES[language]
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid language',
          allowedLanguages:
            Object.keys(LANGUAGES)
        });
      }

      if (
        !category ||
        !CATEGORIES[category]
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid category',
          allowedCategories:
            Object.keys(CATEGORIES)
        });
      }

      if (
        !process.env.YOUTUBE_API_KEY
      ) {
        return res.status(500).json({
          ok: false,
          error:
            'YOUTUBE_API_KEY is missing'
        });
      }

      console.log(
        'YouTube V3 search: ' +
        LANGUAGES[language].name +
        ' / ' +
        CATEGORIES[category].name
      );

      const searchData =
        await searchYouTube(
          language,
          category,
          pageToken || null
        );

      const searchItems =
        searchData.items || [];

      const candidateIds =
        searchItems
          .filter(item => {
            return (
              item.id &&
              item.id.videoId
            );
          })
          .map(item => {
            return item.id.videoId;
          });

      if (
        candidateIds.length === 0
      ) {
        return res.json({
          ok: true,

          language: {
            code: language,
            name:
              LANGUAGES[language].name
          },

          category: {
            code: category,
            name:
              CATEGORIES[category].name
          },

          searched:
            searchItems.length,

          count: 0,

          videos: [],

          nextPageToken:
            searchData.nextPageToken ||
            null
        });
      }

      const details =
        await getVideoDetails(
          candidateIds
        );

      const videos =
        details.map(video => {
          const durationSeconds =
            parseDuration(
              video.contentDetails
                ?.duration
            );

          const title =
            video.snippet?.title || '';

          const description =
            video.snippet?.description ||
            '';

          const channelTitle =
            video.snippet?.channelTitle ||
            '';

          const captionAvailable =
            video.contentDetails
              ?.caption === 'true';

          const embeddable =
            video.status?.embeddable === true;

          const publicStatus =
            video.status
              ?.privacyStatus === 'public';

          const defaultLanguage =
            video.snippet
              ?.defaultLanguage || '';

          const defaultAudioLanguage =
            video.snippet
              ?.defaultAudioLanguage || '';

          const videoObject = {
            videoId: video.id,

            title,

            description,

            channelTitle,

            publishedAt:
              video.snippet
                ?.publishedAt || null,

            thumbnail:
              video.snippet
                ?.thumbnails?.high?.url ||
              video.snippet
                ?.thumbnails?.medium?.url ||
              video.snippet
                ?.thumbnails?.default?.url ||
              null,

            duration:
              formatDuration(
                durationSeconds
              ),

            durationSeconds,

            captionAvailable,

            embeddable,

            publicStatus,

            categoryId:
              video.snippet
                ?.categoryId || null,

            defaultLanguage,

            defaultAudioLanguage,

            viewCount:
              video.statistics
                ?.viewCount
                ? Number(
                    video.statistics
                      .viewCount
                  )
                : 0,

            language,

            category
          };

          videoObject.languageStatus =
            getLanguageStatus(
              videoObject,
              language
            );

          videoObject.languageMatch =
            languageMatches(
              videoObject,
              language
            );

          videoObject.categoryMatch =
            categoryMatches(
              title + ' ' + description,
              category
            );

          videoObject.qualityScore =
            calculateQualityScore(
              videoObject,
              category,
              language
            );

          return videoObject;
        });

      const rejected = {
        notEmbeddable: 0,
        notPublic: 0,
        tooShort: 0,
        tooLong: 0,
        wrongLanguage: 0,
        unknownLanguage: 0,
        wrongCategory: 0
      };

      const accepted =
        videos.filter(video => {
          if (!video.embeddable) {
            rejected.notEmbeddable++;
            return false;
          }

          if (!video.publicStatus) {
            rejected.notPublic++;
            return false;
          }

          if (
            video.durationSeconds < 60
          ) {
            rejected.tooShort++;
            return false;
          }

          if (
            video.durationSeconds > 3600
          ) {
            rejected.tooLong++;
            return false;
          }

          if (
            video.languageStatus ===
            'wrong'
          ) {
            rejected.wrongLanguage++;
            return false;
          }

          if (
            video.languageStatus ===
            'unknown'
          ) {
            rejected.unknownLanguage++;
            return false;
          }

          if (
            !video.categoryMatch
          ) {
            rejected.wrongCategory++;
            return false;
          }

          return true;
        });

      const uniqueVideos = [];

      const seenIds = new Set();

      for (
        const video of accepted
      ) {
        if (
          seenIds.has(
            video.videoId
          )
        ) {
          continue;
        }

        seenIds.add(
          video.videoId
        );

        uniqueVideos.push(
          video
        );
      }

      uniqueVideos.sort(
        (a, b) => {
          return (
            b.qualityScore -
            a.qualityScore
          );
        }
      );

      const finalVideos =
        uniqueVideos.slice(0, 20);

      console.log(
        'YouTube V3 searched: ' +
        searchItems.length
      );

      console.log(
        'YouTube V3 accepted: ' +
        finalVideos.length
      );

      console.log(
        'YouTube V3 rejected: ' +
        JSON.stringify(rejected)
      );

      return res.json({
        ok: true,

        version: 'v3',

        language: {
          code: language,
          name:
            LANGUAGES[language].name
        },

        category: {
          code: category,
          name:
            CATEGORIES[category].name
        },

        searched:
          searchItems.length,

        accepted:
          finalVideos.length,

        rejected,

        count:
          finalVideos.length,

        videos:
          finalVideos,

        nextPageToken:
          searchData.nextPageToken ||
          null
      });

    } catch (error) {
      console.error(
        'YouTube V3 error:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          'YouTube V3 search failed',

        details:
          error.response?.data
            ?.error?.message ||
          error.message
      });
    }
  }
);

module.exports = router;
