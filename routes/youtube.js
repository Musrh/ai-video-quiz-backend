const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY;

const YOUTUBE_API_URL =
  'https://www.googleapis.com/youtube/v3';

const MIN_DURATION_SECONDS = 120;
const MAX_DURATION_SECONDS = 3600;

const MIN_DESCRIPTION_LENGTH = 40;

const MAX_RESULTS = 50;
const MAX_RETURNED_VIDEOS = 20;

const SUPPORTED_LANGUAGES = [
  'fr',
  'en',
  'ar'
];


// =========================================================
// LANGUAGE
// =========================================================

function getLanguageName(language) {

  if (language === 'fr') {
    return 'French';
  }

  if (language === 'en') {
    return 'English';
  }

  if (language === 'ar') {
    return 'Arabic';
  }

  return language;
}


// =========================================================
// SEARCH TERMS
// =========================================================

function getSearchQuery(language, category) {

  const queries = {

    fr: {
      sport:
        'sport actualite entrainement technique',
      sciences:
        'science sciences technologie education',
      'art culinaire':
        'cuisine recette gastronomie chef',
      'culture générale':
        'culture générale histoire géographie société'
    },

    en: {
      sport:
        'sport training technique education',
      sciences:
        'science technology education',
      'art culinaire':
        'cooking recipe gastronomy chef',
      'culture générale':
        'general knowledge history geography culture society'
    },

    ar: {
      sport:
        'رياضة تدريب كرة قدم معلومات',
      sciences:
        'علوم تكنولوجيا تعليم',
      'art culinaire':
        'طبخ وصفات مطبخ',
      'culture générale':
        'ثقافة عامة تاريخ جغرافيا معلومات'
    }

  };

  return (
    queries[language] &&
    queries[language][category]
  ) ||
  category;
}


// =========================================================
// CATEGORY KEYWORDS
// =========================================================

function getCategoryKeywords(
  language,
  category
) {

  const keywords = {

    sport: [
      'sport',
      'football',
      'soccer',
      'basketball',
      'tennis',
      'athlétisme',
      'athletisme',
      'rugby',
      'boxe',
      'golf',
      'natation',
      'sportif',
      'sportive',
      'entraînement',
      'entrainement',
      'رياضة',
      'كرة القدم',
      'كرة السلة',
      'تنس'
    ],

    sciences: [
      'science',
      'sciences',
      'scientifique',
      'physique',
      'chimie',
      'biologie',
      'astronomie',
      'espace',
      'planète',
      'planete',
      'technologie',
      'technologies',
      'médecine',
      'medecine',
      'nature',
      'environnement',
      'énergie',
      'energie',
      'science',
      'علوم',
      'فيزياء',
      'كيمياء',
      'أحياء',
      'فضاء',
      'تكنولوجيا',
      'طب'
    ],

    'art culinaire': [
      'cuisine',
      'cuisiner',
      'recette',
      'recettes',
      'gastronomie',
      'chef',
      'pâtisserie',
      'patisserie',
      'dessert',
      'desserts',
      'food',
      'cooking',
      'recipe',
      'recipes',
      'culinaire',
      'مطبخ',
      'طبخ',
      'وصفة',
      'وصفات',
      'حلويات'
    ],

    'culture générale': [
      'culture',
      'culture générale',
      'culture generale',
      'histoire',
      'géographie',
      'geographie',
      'civilisation',
      'société',
      'societe',
      'connaissance',
      'connaissances',
      'general knowledge',
      'history',
      'geography',
      'culture',
      'society',
      'general',
      'ثقافة',
      'ثقافة عامة',
      'تاريخ',
      'جغرافيا',
      'معلومات عامة'
    ]

  };

  return keywords[category] || [];
}


// =========================================================
// EXCLUDED CONTENT
// =========================================================

function getExcludedTerms(category) {

  const common = [

    'trailer',
    'official trailer',
    'bande annonce',
    'teaser',

    'official music video',
    'music video',
    'clip musical',
    'lyrics video',
    'karaoke',
    'remix',

    'shorts',
    '#shorts',

    'compilation',
    'best of',

    'live stream',
    'livestream'
  ];

  const sportExcluded = [

    'highlights',
    'highlight',
    'résumé du match',
    'resume du match',
    'resume match',
    'full match replay',
    'replay complet',
    'live score',
    'score en direct'
  ];

  if (category === 'sport') {
    return common.concat(
      sportExcluded
    );
  }

  return common;
}


// =========================================================
// NORMALIZE TEXT
// =========================================================

function normalizeText(value) {

  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    );
}


// =========================================================
// DURATION
// =========================================================

function parseDuration(
  duration
) {

  if (!duration) {
    return 0;
  }

  const match =
    duration.match(
      /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/
    );

  if (!match) {
    return 0;
  }

  const hours =
    Number(match[1] || 0);

  const minutes =
    Number(match[2] || 0);

  const seconds =
    Number(match[3] || 0);

  return (
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}


// =========================================================
// FORMAT DURATION
// =========================================================

function formatDuration(
  totalSeconds
) {

  const hours =
    Math.floor(
      totalSeconds / 3600
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const seconds =
    totalSeconds % 60;


  if (hours > 0) {

    return (
      String(hours).padStart(2, '0') +
      ':' +
      String(minutes).padStart(2, '0') +
      ':' +
      String(seconds).padStart(2, '0')
    );

  }


  return (
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0')
  );

}


// =========================================================
// LANGUAGE SCORE
// =========================================================

function getLanguageScore(
  snippet,
  requestedLanguage
) {

  const defaultLanguage =
    normalizeText(
      snippet.defaultLanguage
    );

  const defaultAudioLanguage =
    normalizeText(
      snippet.defaultAudioLanguage
    );

  const language =
    requestedLanguage.toLowerCase();


  if (
    defaultLanguage === language ||
    defaultAudioLanguage === language
  ) {

    return 50;

  }


  if (
    defaultLanguage.startsWith(
      language + '-'
    ) ||
    defaultAudioLanguage.startsWith(
      language + '-'
    )
  ) {

    return 48;

  }


  const combined =
    (
      defaultLanguage +
      ' ' +
      defaultAudioLanguage
    );


  if (
    !defaultLanguage &&
    !defaultAudioLanguage
  ) {

    return 10;

  }


  if (
    language === 'fr' &&
    (
      combined.includes('fr')
    )
  ) {

    return 42;

  }


  if (
    language === 'en' &&
    (
      combined.includes('en')
    )
  ) {

    return 42;

  }


  if (
    language === 'ar' &&
    (
      combined.includes('ar')
    )
  ) {

    return 42;

  }


  return -30;
}


// =========================================================
// CATEGORY SCORE
// =========================================================

function getCategoryScore(
  title,
  description,
  category
) {

  const text =
    normalizeText(
      title +
      ' ' +
      description
    );

  const keywords =
    getCategoryKeywords(
      null,
      category
    );


  let score = 0;

  let matches = 0;


  for (
    let i = 0;
    i < keywords.length;
    i++
  ) {

    const keyword =
      normalizeText(
        keywords[i]
      );

    if (!keyword) {
      continue;
    }


    if (
      text.includes(keyword)
    ) {

      matches++;

    }

  }


  if (matches >= 4) {
    score += 35;
  } else if (matches >= 3) {
    score += 30;
  } else if (matches >= 2) {
    score += 25;
  } else if (matches >= 1) {
    score += 15;
  }


  return {
    score: score,
    matches: matches
  };

}


// =========================================================
// EXCLUDED CONTENT
// =========================================================

function containsExcludedTerm(
  title,
  description,
  category
) {

  const text =
    normalizeText(
      title +
      ' ' +
      description
    );


  const excluded =
    getExcludedTerms(
      category
    );


  for (
    let i = 0;
    i < excluded.length;
    i++
  ) {

    const term =
      normalizeText(
        excluded[i]
      );


    if (
      term &&
      text.includes(term)
    ) {

      return term;

    }

  }


  return null;

}


// =========================================================
// SEARCH YOUTUBE
// =========================================================

async function searchYouTube(
  query,
  language
) {

  const response =
    await axios.get(
      YOUTUBE_API_URL +
      '/search',
      {
        params: {

          part:
            'snippet',

          q:
            query,

          type:
            'video',

          maxResults:
            MAX_RESULTS,

          relevanceLanguage:
            language,

          videoEmbeddable:
            'true',

          videoSyndicated:
            'true',

          safeSearch:
            'moderate',

          key:
            YOUTUBE_API_KEY

        },

        timeout: 15000

      }
    );


  return response.data;

}


// =========================================================
// GET VIDEO DETAILS
// =========================================================

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
      YOUTUBE_API_URL +
      '/videos',
      {
        params: {

          part:
            'snippet,contentDetails,status,statistics',

          id:
            videoIds.join(','),

          key:
            YOUTUBE_API_KEY

        },

        timeout: 15000

      }
    );


  return response.data.items || [];

}


// =========================================================
// MAIN SEARCH ROUTE
// =========================================================

router.get(
  '/search',
  async function(req, res) {

    try {

      if (!YOUTUBE_API_KEY) {

        return res.status(500).json({

          ok: false,

          error:
            'YOUTUBE_API_KEY is missing'

        });

      }


      const language =
        String(
          req.query.language ||
          'fr'
        )
          .trim()
          .toLowerCase();


      const category =
        String(
          req.query.category ||
          'sciences'
        )
          .trim()
          .toLowerCase();


      if (
        !SUPPORTED_LANGUAGES.includes(
          language
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            'Unsupported language. Use fr, en or ar.'

        });

      }


      const supportedCategories = [
        'sport',
        'sciences',
        'art culinaire',
        'culture générale'
      ];


      if (
        !supportedCategories.includes(
          category
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            'Unsupported category.'

        });

      }


      console.log(
        'YouTube search V5:',
        language,
        category
      );


      // -----------------------------------------------------
      // SEARCH
      // -----------------------------------------------------

      const query =
        getSearchQuery(
          language,
          category
        );


      console.log(
        'Search query:',
        query
      );


      const searchData =
        await searchYouTube(
          query,
          language
        );


      const searchItems =
        searchData.items || [];


      console.log(
        'YouTube search results:',
        searchItems.length
      );


      if (
        searchItems.length === 0
      ) {

        return res.json({

          ok: true,

          version:
            'v5',

          language:
            language,

          category:
            category,

          searched:
            0,

          accepted:
            0,

          rejected:
            {},

          videos:
            [],

          message:
            'No YouTube search results found.'

        });

      }


      // -----------------------------------------------------
      // VIDEO IDS
      // -----------------------------------------------------

      const videoIds =
        searchItems
          .map(
            function(item) {

              return (
                item.id &&
                item.id.videoId
              );

            }
          )
          .filter(
            Boolean
          );


      // -----------------------------------------------------
      // DETAILS
      // -----------------------------------------------------

      const details =
        await getVideoDetails(
          videoIds
        );


      console.log(
        'Video details received:',
        details.length
      );


      // -----------------------------------------------------
      // REJECTION COUNTERS
      // -----------------------------------------------------

      const rejected = {

        notEmbeddable:
          0,

        notPublic:
          0,

        tooShort:
          0,

        tooLong:
          0,

        wrongLanguage:
          0,

        unknownLanguage:
          0,

        wrongCategory:
          0,

        noCaptions:
          0,

        poorDescription:
          0,

        excludedContent:
          0

      };


      // -----------------------------------------------------
      // ACCEPTED
      // -----------------------------------------------------

      const accepted = [];


      for (
        let i = 0;
        i < details.length;
        i++
      ) {

        const item =
          details[i];


        const snippet =
          item.snippet ||
          {};


        const contentDetails =
          item.contentDetails ||
          {};


        const status =
          item.status ||
          {};


        const statistics =
          item.statistics ||
          {};


        const title =
          snippet.title ||
          '';


        const description =
          snippet.description ||
          '';


        const videoId =
          item.id;


        // ---------------------------------------------------
        // PUBLIC
        // ---------------------------------------------------

        if (
          status.privacyStatus !==
          'public'
        ) {

          rejected.notPublic++;

          continue;

        }


        // ---------------------------------------------------
        // EMBEDDABLE
        // ---------------------------------------------------

        if (
          status.embeddable !== true
        ) {

          rejected.notEmbeddable++;

          continue;

        }


        // ---------------------------------------------------
        // DURATION
        // ---------------------------------------------------

        const durationSeconds =
          parseDuration(
            contentDetails.duration
          );


        if (
          durationSeconds <
          MIN_DURATION_SECONDS
        ) {

          rejected.tooShort++;

          continue;

        }


        if (
          durationSeconds >
          MAX_DURATION_SECONDS
        ) {

          rejected.tooLong++;

          continue;

        }


        // ---------------------------------------------------
        // DESCRIPTION
        // ---------------------------------------------------

        if (
          description.trim().length <
          MIN_DESCRIPTION_LENGTH
        ) {

          rejected.poorDescription++;

          continue;

        }


        // ---------------------------------------------------
        // EXCLUDED CONTENT
        // ---------------------------------------------------

        const excludedTerm =
          containsExcludedTerm(
            title,
            description,
            category
          );


        if (excludedTerm) {

          rejected.excludedContent++;

          continue;

        }


        // ---------------------------------------------------
        // LANGUAGE
        // ---------------------------------------------------

        const languageScore =
          getLanguageScore(
            snippet,
            language
          );


        if (
          languageScore <= -30
        ) {

          rejected.wrongLanguage++;

          continue;

        }


        if (
          languageScore === 10
        ) {

          rejected.unknownLanguage++;

        }


        // ---------------------------------------------------
        // CATEGORY
        // ---------------------------------------------------

        const categoryResult =
          getCategoryScore(
            title,
            description,
            category
          );


        /*
         * On ne bloque plus systématiquement une vidéo
         * lorsqu'un seul mot-clé de catégorie manque.
         *
         * Pour les catégories très générales, un titre
         * pertinent peut suffire.
         */

        if (
          categoryResult.matches === 0
        ) {

          rejected.wrongCategory++;

          continue;

        }


        // ---------------------------------------------------
        // CAPTIONS
        // ---------------------------------------------------

        const hasCaptions =
          contentDetails.caption ===
          'true';


        /*
         * IMPORTANT :
         *
         * Nous ne rejetons pas immédiatement une vidéo
         * parce que caption n'est pas true.
         *
         * Cela évite de supprimer trop de résultats.
         *
         * Le système de questions vérifiera ensuite
         * si le service de transcript peut réellement
         * récupérer le texte.
         */


        // ---------------------------------------------------
        // SCORE
        // ---------------------------------------------------

        let quality =
          0;


        quality +=
          languageScore;


        quality +=
          categoryResult.score;


        if (
          hasCaptions
        ) {

          quality += 20;

        } else {

          quality -= 5;

        }


        if (
          durationSeconds >= 300
        ) {

          quality += 8;

        } else if (
          durationSeconds >= 240
        ) {

          quality += 5;

        }


        const descriptionLength =
          description.length;


        if (
          descriptionLength >= 500
        ) {

          quality += 8;

        } else if (
          descriptionLength >= 300
        ) {

          quality += 5;

        } else if (
          descriptionLength >= 150
        ) {

          quality += 3;

        }


        const views =
          Number(
            statistics.viewCount ||
            0
          );


        if (
          views >= 1000000
        ) {

          quality += 5;

        } else if (
          views >= 100000
        ) {

          quality += 3;

        } else if (
          views >= 10000
        ) {

          quality += 2;

        }


        // ---------------------------------------------------
        // RESULT
        // ---------------------------------------------------

        accepted.push({

          videoId:
            videoId,

          title:
            title,

          description:
            description,

          channelTitle:
            snippet.channelTitle ||
            '',

          channelId:
            snippet.channelId ||
            '',

          publishedAt:
            snippet.publishedAt ||
            null,

          defaultLanguage:
            snippet.defaultLanguage ||
            null,

          defaultAudioLanguage:
            snippet.defaultAudioLanguage ||
            null,

          duration:
            contentDetails.duration ||
            null,

          durationSeconds:
            durationSeconds,

          durationFormatted:
            formatDuration(
              durationSeconds
            ),

          captionAvailable:
            hasCaptions,

          embeddable:
            status.embeddable === true,

          privacyStatus:
            status.privacyStatus ||
            null,

          viewCount:
            views,

          thumbnail:
            snippet.thumbnails &&
            snippet.thumbnails.high
              ? snippet.thumbnails.high.url
              : null,

          categoryMatches:
            categoryResult.matches,

          quality:
            quality

        });

      }


      // -----------------------------------------------------
      // SORT
      // -----------------------------------------------------

      accepted.sort(
        function(a, b) {

          if (
            b.quality !==
            a.quality
          ) {

            return (
              b.quality -
              a.quality
            );

          }


          return (
            b.viewCount -
            a.viewCount
          );

        }
      );


      // -----------------------------------------------------
      // RETURN TOP RESULTS
      // -----------------------------------------------------

      const videos =
        accepted.slice(
          0,
          MAX_RETURNED_VIDEOS
        );


      console.log(
        'Accepted videos:',
        videos.length
      );


      console.log(
        'Rejected:',
        JSON.stringify(
          rejected
        )
      );


      return res.json({

        ok: true,

        version:
          'v5',

        language:
          language,

        languageName:
          getLanguageName(
            language
          ),

        category:
          category,

        query:
          query,

        searched:
          searchItems.length,

        accepted:
          accepted.length,

        returned:
          videos.length,

        rejected:
          rejected,

        videos:
          videos,

        nextPageToken:
          searchData.nextPageToken ||
          null

      });


    } catch (error) {

      console.error(
        'YouTube search V5 error:',
        error.message
      );


      if (
        error.response
      ) {

        console.error(
          'YouTube API status:',
          error.response.status
        );


        console.error(
          'YouTube API response:',
          JSON.stringify(
            error.response.data
          )
        );


        return res.status(
          error.response.status || 500
        ).json({

          ok: false,

          error:
            'YouTube API request failed',

          details:
            error.response.data ||
            null

        });

      }


      return res.status(500).json({

        ok: false,

        error:
          'Unable to search YouTube videos',

        details:
          error.message

      });

    }

  }
);


module.exports = router;
