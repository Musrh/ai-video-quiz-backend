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

const MIN_DURATION_SECONDS = 180;
const MAX_DURATION_SECONDS = 3600;
const MIN_DESCRIPTION_LENGTH = 80;

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

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

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

  if (
    audioLanguage === requested &&
    metadataLanguage === requested
  ) {
    return 'strong';
  }

  if (
    audioLanguage === requested &&
    !metadataLanguage
  ) {
    return 'strong';
  }

  if (
    audioLanguage === requested &&
    metadataLanguage !== requested
  ) {
    return 'audio_only';
  }

  if (
    !audioLanguage &&
    metadataLanguage === requested
  ) {
    return 'metadata_only';
  }

  if (!audioLanguage && !metadataLanguage) {
    return 'unknown';
  }

  return 'wrong';
}

function languageMatches(
  video,
  requestedLanguage
) {
  const status =
    getLanguageStatus(
      video,
      requestedLanguage
    );

  return (
    status === 'strong' ||
    status === 'audio_only' ||
    status === 'metadata_only'
  );
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
      'championnat',
      'entraineur',
      'coach',
      'competition',
      'competition sportive'
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
      'genetics',
      'medecine',
      'medicine',
      'climat',
      'climate',
      'environnement',
      'environment',
      'astronomique',
      'astronomical',
      'geologie',
      'geology',
      'evolution',
      'evolution'
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
      'vegetable',
      'vegetables',
      'sauce',
      'pasta',
      'pates',
      'pain',
      'bread',
      'chocolat',
      'chocolate'
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
      'philosophy',
      'monument',
      'historique',
      'historical',
      'biographie',
      'biography'
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

function hasExcludedContent(
  title,
  description,
  category
) {
  const value =
    normalizeText(
      title + ' ' + description
    );

  const commonExcludedTerms = [
    'trailer',
    'official trailer',
    'bande annonce',
    'bande-annonce',
    'teaser',
    'movie trailer',
    'film trailer',
    'court metrage',
    'court-metrage',
    'short film',
    'short movie',
    'clip officiel',
    'official music video',
    'music video',
    'video musicale',
    'clip musical',
    'lyrics video',
    'paroles',
    'karaoke',
    'remix',
    'compilation',
    'best of',
    'shorts',
    '#shorts'
  ];

  if (
    commonExcludedTerms.some(term => {
      return value.includes(
        normalizeText(term)
      );
    })
  ) {
    return true;
  }

  if (category === 'sport') {
    const sportExcludedTerms = [
      'highlights',
      'resume du match',
      'resume match',
      'full match replay',
      'match replay',
      'live score'
    ];

    if (
      sportExcludedTerms.some(term => {
        return value.includes(
          normalizeText(term)
        );
      })
    ) {
      return true;
    }
  }

  return false;
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

  if (
    languageStatus === 'strong'
  ) {
    score += 50;
  } else if (
    languageStatus === 'audio_only'
  ) {
    score += 42;
  } else if (
    languageStatus === 'metadata_only'
  ) {
    score += 20;
  }

  if (
    video.categoryMatch
  ) {
    score += 25;
  }

  if (
    video.captionAvailable
  ) {
    score += 15;
  }

  if (
    video.durationSeconds >= 300
  ) {
    score += 8;
  } else if (
    video.durationSeconds >= 240
  ) {
    score += 5;
  }

  if (
    video.descriptionLength >= 300
  ) {
    score += 5;
  } else if (
    video.descriptionLength >= 150
  ) {
    score += 3;
  }

  if (
    video.viewCount >= 100000
  ) {
    score += 3;
  } else if (
    video.viewCount >= 10000
  ) {
    score += 2;
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
    key:
      process.env.YOUTUBE_API_KEY,

    part: 'snippet',

    type: 'video',

    q:
      categoryInfo.query,

    relevanceLanguage:
      languageInfo.relevanceLanguage,

    videoEmbeddable:
      'true',

    videoSyndicated:
      'true',

    videoCaption:
      'closedCaption',

    safeSearch:
      'moderate',

    maxResults:
      50
  };

  if (pageToken) {
    params.pageToken =
      pageToken;
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
          key:
            process.env.YOUTUBE_API_KEY,

          part:
            'snippet,contentDetails,status,statistics',

          id:
            videoIds.join(',')
        },

        timeout: 20000
      }
    );

  return (
    response.data.items || []
  );
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
          error:
            'Invalid language',
          allowedLanguages:
            Object.keys(
              LANGUAGES
            )
        });
      }

      if (
        !category ||
        !CATEGORIES[category]
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid category',
          allowedCategories:
            Object.keys(
              CATEGORIES
            )
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
        'YouTube V4 search: ' +
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

          version: 'v4',

          language: {
            code: language,
            name:
              LANGUAGES[
                language
              ].name
          },

          category: {
            code: category,
            name:
              CATEGORIES[
                category
              ].name
          },

          searched:
            searchItems.length,

          accepted: 0,

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
              video
                .contentDetails
                ?.duration
            );

          const title =
            video
              .snippet
              ?.title || '';

          const description =
            video
              .snippet
              ?.description || '';

          const channelTitle =
            video
              .snippet
              ?.channelTitle || '';

          const captionAvailable =
            video
              .contentDetails
              ?.caption === 'true';

          const embeddable =
            video
              .status
              ?.embeddable === true;

          const publicStatus =
            video
              .status
              ?.privacyStatus ===
            'public';

          const defaultLanguage =
            video
              .snippet
              ?.defaultLanguage || '';

          const defaultAudioLanguage =
            video
              .snippet
              ?.defaultAudioLanguage ||
            '';

          const viewCount =
            video
              .statistics
              ?.viewCount
              ? Number(
                  video.statistics
                    .viewCount
                )
              : 0;

          const descriptionLength =
            description.trim().length;

          const videoObject = {
            videoId:
              video.id,

            title,

            description,

            channelTitle,

            publishedAt:
              video
                .snippet
                ?.publishedAt ||
              null,

            thumbnail:
              video
                .snippet
                ?.thumbnails
                ?.high
                ?.url ||
              video
                .snippet
                ?.thumbnails
                ?.medium
                ?.url ||
              video
                .snippet
                ?.thumbnails
                ?.default
                ?.url ||
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
              video
                .snippet
                ?.categoryId ||
              null,

            defaultLanguage,

            defaultAudioLanguage,

            viewCount,

            descriptionLength,

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
              title +
              ' ' +
              description,
              category
            );

          videoObject.excludedContent =
            hasExcludedContent(
              title,
              description,
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
        wrongCategory: 0,
        noCaptions: 0,
        poorDescription: 0,
        excludedContent: 0
      };

      const accepted =
        videos.filter(video => {
          if (
            !video.embeddable
          ) {
            rejected.notEmbeddable++;
            return false;
          }

          if (
            !video.publicStatus
          ) {
            rejected.notPublic++;
            return false;
          }

          if (
            video.durationSeconds <
            MIN_DURATION_SECONDS
          ) {
            rejected.tooShort++;
            return false;
          }

          if (
            video.durationSeconds >
            MAX_DURATION_SECONDS
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

          if (
            !video.captionAvailable
          ) {
            rejected.noCaptions++;
            return false;
          }

          if (
            video.descriptionLength <
            MIN_DESCRIPTION_LENGTH
          ) {
            rejected.poorDescription++;
            return false;
          }

          if (
            video.excludedContent
          ) {
            rejected.excludedContent++;
            return false;
          }

          return true;
        });

      const uniqueVideos = [];

      const seenIds =
        new Set();

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
          if (
            b.qualityScore !==
            a.qualityScore
          ) {
            return (
              b.qualityScore -
              a.qualityScore
            );
          }

          return (
            b.viewCount -
            a.viewCount
          );
        }
      );

      const finalVideos =
        uniqueVideos.slice(
          0,
          20
        );

      console.log(
        'YouTube V4 searched: ' +
        searchItems.length
      );

      console.log(
        'YouTube V4 accepted: ' +
        finalVideos.length
      );

      console.log(
        'YouTube V4 rejected: ' +
        JSON.stringify(
          rejected
        )
      );

      return res.json({
        ok: true,

        version: 'v4',

        language: {
          code: language,
          name:
            LANGUAGES[
              language
            ].name
        },

        category: {
          code: category,
          name:
            CATEGORIES[
              category
            ].name
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
          searchData
            .nextPageToken ||
          null
      });

    } catch (error) {
      console.error(
        'YouTube V4 error:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          'YouTube V4 search failed',

        details:
          error.response?.data
            ?.error?.message ||
          error.message
      });
    }
  }
);

module.exports = router;
