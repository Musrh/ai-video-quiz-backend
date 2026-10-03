````javascript
const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_URL =
  'https://www.googleapis.com/youtube/v3';

const TRANSCRIPT_API_URL =
  'https://www.youtubetranscript.dev/api/v2/transcribe';

const ANTHROPIC_API_URL =
  'https://api.anthropic.com/v1/messages';

const CLAUDE_MODEL =
  'claude-sonnet-5';

const MAX_RESULTS = 10;

// Nombre maximum de vidéos candidates à analyser
// réellement avec la transcription.
const MAX_CANDIDATES_TO_ANALYZE = 20;

const MIN_TRANSCRIPT_LENGTH = 500;


// ============================================================
// IELTS SEARCH QUERIES
// ============================================================

const LISTENING_QUERIES = [
  'IELTS Listening test with questions',
  'IELTS Listening practice test questions',
  'IELTS Listening full test questions',
  'IELTS Listening practice Cambridge questions',
  'IELTS Listening test section 1 2 3 4'
];


// ============================================================
// Terms
// ============================================================

const EXCLUDED_TERMS = [
  'shorts',
  '#shorts',
  'official music video',
  'music video',
  'lyrics video',
  'karaoke',
  'remix',
  'trailer',
  'official trailer',
  'teaser',
  'livestream',
  'live stream'
];

const IELTS_TERMS = [
  'ielts',
  'ielts academic',
  'ielts general training',
  'ielts preparation',
  'ielts test',
  'ielts practice',
  'ielts listening'
];


// ============================================================
// Helpers
// ============================================================

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


function containsExcludedTerm(text) {
  const value = normalizeText(text);

  return EXCLUDED_TERMS.some(function(term) {
    return value.includes(term);
  });
}


function hasIeltsTerm(text) {
  const value = normalizeText(text);

  return IELTS_TERMS.some(function(term) {
    return value.includes(term);
  });
}


function hasListeningTerm(text) {
  const value = normalizeText(text);

  const terms = [
    'ielts listening',
    'listening test',
    'listening practice',
    'listening exam',
    'listening section',
    'listening questions',
    'listening answers'
  ];

  return terms.some(function(term) {
    return value.includes(term);
  });
}


function normalizeLanguage(value) {
  return normalizeText(value).split('-')[0];
}


function isEnglishVideo(item) {
  const details = item.snippet || {};

  const defaultLanguage =
    normalizeLanguage(
      details.defaultLanguage
    );

  const defaultAudioLanguage =
    normalizeLanguage(
      details.defaultAudioLanguage
    );

  const englishLanguages = [
    'en',
    'eng',
    'english'
  ];

  if (
    defaultLanguage &&
    !englishLanguages.includes(
      defaultLanguage
    )
  ) {
    return false;
  }

  if (
    defaultAudioLanguage &&
    !englishLanguages.includes(
      defaultAudioLanguage
    )
  ) {
    return false;
  }

  return true;
}


function parseDuration(isoDuration) {
  const match =
    String(isoDuration || '').match(
      /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
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


function formatDuration(totalSeconds) {
  const seconds =
    Number(totalSeconds || 0);

  const hours =
    Math.floor(seconds / 3600);

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  const remainingSeconds =
    seconds % 60;

  if (hours > 0) {
    return (
      String(hours) +
      ':' +
      String(minutes).padStart(2, '0') +
      ':' +
      String(remainingSeconds).padStart(2, '0')
    );
  }

  return (
    String(minutes) +
    ':' +
    String(remainingSeconds).padStart(2, '0')
  );
}


// ============================================================
// Strict IELTS Listening candidate filter
// ============================================================

function isStrongListeningCandidate(item) {
  const snippet =
    item.snippet || {};

  const title =
    normalizeText(
      snippet.title
    );

  const description =
    normalizeText(
      snippet.description
    );

  const combined =
    title + ' ' + description;

  if (!hasIeltsTerm(combined)) {
    return false;
  }

  if (!hasListeningTerm(combined)) {
    return false;
  }

  if (containsExcludedTerm(combined)) {
    return false;
  }

  return true;
}


// ============================================================
// Quality score
// ============================================================

function calculateQuality(
  item,
  durationSeconds
) {
  const snippet =
    item.snippet || {};

  const details =
    item.contentDetails || {};

  const statistics =
    item.statistics || {};

  const title =
    normalizeText(
      snippet.title
    );

  const description =
    normalizeText(
      snippet.description
    );

  let score = 0;

  if (
    title.includes(
      'ielts listening'
    )
  ) {
    score += 40;
  }

  if (
    title.includes(
      'listening test'
    )
  ) {
    score += 20;
  }

  if (
    title.includes(
      'listening practice'
    )
  ) {
    score += 15;
  }

  if (
    title.includes(
      'questions'
    )
  ) {
    score += 10;
  }

  if (
    title.includes(
      'section 1'
    ) ||
    title.includes(
      'section 2'
    ) ||
    title.includes(
      'section 3'
    ) ||
    title.includes(
      'section 4'
    )
  ) {
    score += 10;
  }

  if (
    description.includes(
      'ielts listening'
    )
  ) {
    score += 15;
  }

  if (
    description.includes(
      'questions'
    )
  ) {
    score += 10;
  }

  if (
    description.includes(
      'answers'
    )
  ) {
    score += 5;
  }

  if (durationSeconds >= 600) {
    score += 10;
  }

  if (durationSeconds >= 1200) {
    score += 10;
  }

  if (
    details.caption === 'true'
  ) {
    score += 5;
  }

  if (
    Number(
      statistics.viewCount || 0
    ) >= 10000
  ) {
    score += 5;
  }

  return Math.min(
    score,
    100
  );
}


// ============================================================
// YouTube API
// ============================================================

async function youtubeRequest(
  endpoint,
  params
) {
  const apiKey =
    process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error(
      'YOUTUBE_API_KEY is missing'
    );
  }

  const response =
    await axios.get(
      YOUTUBE_API_URL +
      endpoint,
      {
        params: Object.assign(
          {},
          params,
          {
            key: apiKey
          }
        ),

        timeout: 20000
      }
    );

  return response.data;
}


async function searchYouTube(
  query
) {
  return youtubeRequest(
    '/search',
    {
      part: 'snippet',

      q: query,

      type: 'video',

      maxResults: 50,

      videoDuration: 'long',

      videoEmbeddable: 'true',

      videoSyndicated: 'true',

      relevanceLanguage: 'en',

      regionCode: 'US'
    }
  );
}


async function getVideoDetails(
  videoIds
) {
  if (!videoIds.length) {
    return {
      items: []
    };
  }

  return youtubeRequest(
    '/videos',
    {
      part:
        'snippet,contentDetails,status,statistics',

      id:
        videoIds.join(',')
    }
  );
}


// ============================================================
// Transcript
// ============================================================

async function getTranscript(
  videoId
) {
  const apiKey =
    process.env.YOUTUBE_TRANSCRIPT_API_KEY;

  if (!apiKey) {
    throw new Error(
      'YOUTUBE_TRANSCRIPT_API_KEY is missing'
    );
  }

  const response =
    await axios.post(
      TRANSCRIPT_API_URL,

      {
        video:
          videoId,

        language:
          'en',

        source:
          'auto'
      },

      {
        headers: {
          Authorization:
            'Bearer ' +
            apiKey,

          'Content-Type':
            'application/json'
        },

        timeout: 30000
      }
    );

  const data =
    response.data || {};

  if (
    data.status !==
    'completed'
  ) {
    return null;
  }

  const transcript =
    data.data &&
    data.data.transcript
      ? data.data.transcript
      : null;

  const text =
    transcript &&
    typeof transcript.text ===
      'string'
      ? transcript.text.trim()
      : '';

  if (!text) {
    return null;
  }

  if (
    text.length <
    MIN_TRANSCRIPT_LENGTH
  ) {
    return null;
  }

  return {
    text:
      text,

    language:
      transcript.language ||
      null
  };
}


// ============================================================
// Detect IELTS question markers
// ============================================================

function hasQuestionMarkers(
  transcript
) {
  const text =
    normalizeText(
      transcript
    );

  const markers = [
    'questions 1',
    'questions 1-5',
    'questions 1 to 5',
    'questions 6',
    'questions 6-10',
    'questions 6 to 10',
    'questions 11',
    'questions 11-15',
    'questions 11 to 15',
    'questions 16',
    'questions 16-20',
    'questions 16 to 20',
    'questions 21',
    'questions 21-25',
    'questions 21 to 25',
    'questions 26',
    'questions 26-30',
    'questions 26 to 30',
    'questions 31',
    'questions 31-35',
    'questions 31 to 35',
    'questions 36',
    'questions 36-40',
    'questions 36 to 40',

    'question one',
    'question two',
    'question three',
    'question four',
    'question five',

    'choose the correct answer',
    'choose two answers',
    'choose the correct letter',
    'complete the form',
    'complete the notes',
    'complete the table',
    'complete the sentence',
    'complete the summary',
    'write one word',
    'write no more than one word',
    'write no more than two words',
    'write no more than three words',
    'match'
  ];

  return markers.some(
    function(marker) {
      return text.includes(marker);
    }
  );
}


// ============================================================
// Extract JSON from Claude
// ============================================================

function extractJson(
  text
) {
  if (
    !text ||
    typeof text !== 'string'
  ) {
    throw new Error(
      'Claude returned an empty response'
    );
  }

  let cleaned =
    text.trim();

  cleaned =
    cleaned
      .replace(
        /^```json\s*/i,
        ''
      )
      .replace(
        /^```\s*/i,
        ''
      )
      .replace(
        /\s*```$/i,
        ''
      )
      .trim();

  try {
    return JSON.parse(
      cleaned
    );
  } catch (error) {
  }

  const firstObject =
    cleaned.indexOf('{');

  const lastObject =
    cleaned.lastIndexOf('}');

  if (
    firstObject !== -1 &&
    lastObject > firstObject
  ) {
    const objectText =
      cleaned.substring(
        firstObject,
        lastObject + 1
      );

    try {
      return JSON.parse(
        objectText
      );
    } catch (error) {
    }
  }

  throw new Error(
    'Unable to parse Claude JSON response'
  );
}


// ============================================================
// Extract REAL questions from transcript
// ============================================================

async function extractIeltsQuestions(
  video,
  transcript
) {
  const apiKey =
    process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is missing'
    );
  }

  const systemPrompt =
    'You are an IELTS Listening content extractor. ' +
    'Your task is extraction, not question generation. ' +
    'Use ONLY the supplied transcript. ' +
    'Do NOT invent questions. ' +
    'Do NOT rewrite questions unnecessarily. ' +
    'If the transcript contains IELTS Listening questions, extract them. ' +
    'If there are no identifiable IELTS Listening questions, return an empty questions array. ' +
    'Return ONLY valid JSON.';

  const userPrompt =
    'Analyze this IELTS Listening video transcript.\n\n' +

    'VIDEO TITLE:\n' +
    (video.title || '') +
    '\n\n' +

    'TRANSCRIPT:\n' +
    '<transcript>\n' +
    transcript +
    '\n</transcript>\n\n' +

    'Extract ONLY questions that actually appear in the transcript ' +
    'as part of an IELTS Listening exercise.\n\n' +

    'Do not create new questions from the listening passage.\n' +

    'Do not infer missing questions.\n' +

    'Do not invent answer choices.\n\n' +

    'If an actual question has answer choices explicitly present ' +
    'in the transcript, include them.\n\n' +

    'If answer choices are not present, return an empty choices array.\n\n' +

    'For each question, preserve its meaning and wording as closely ' +
    'as possible.\n\n' +

    'Return this exact structure:\n' +

    '{\n' +
    '  "questions": [\n' +
    '    {\n' +
    '      "number": 1,\n' +
    '      "question": "actual question text",\n' +
    '      "choices": [\n' +
    '        "A. ...",\n' +
    '        "B. ...",\n' +
    '        "C. ..."\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +

    'If there are no identifiable IELTS Listening questions, return:\n' +

    '{\n' +
    '  "questions": []\n' +
    '}';

  const response =
    await axios.post(
      ANTHROPIC_API_URL,

      {
        model:
          CLAUDE_MODEL,

        max_tokens:
          5000,

        system:
          systemPrompt,

        messages: [
          {
            role:
              'user',

            content:
              userPrompt
          }
        ]
      },

      {
        headers: {
          'x-api-key':
            apiKey,

          'anthropic-version':
            '2023-06-01',

          'content-type':
            'application/json'
        },

        timeout: 120000
      }
    );

  const data =
    response.data || {};

  const content =
    Array.isArray(
      data.content
    )
      ? data.content
      : [];

  const text =
    content
      .filter(
        function(block) {
          return (
            block &&
            block.type === 'text' &&
            typeof block.text ===
              'string'
          );
        }
      )
      .map(
        function(block) {
          return block.text;
        }
      )
      .join('\n')
      .trim();

  if (!text) {
    return [];
  }

  const parsed =
    extractJson(text);

  if (
    !parsed ||
    !Array.isArray(
      parsed.questions
    )
  ) {
    return [];
  }

  return parsed.questions
    .filter(
      function(item) {
        return (
          item &&
          typeof item === 'object' &&
          typeof item.question ===
            'string' &&
          item.question.trim()
        );
      }
    )
    .map(
      function(item, index) {
        return {
          number:
            Number.isInteger(
              Number(item.number)
            )
              ? Number(item.number)
              : index + 1,

          question:
            item.question.trim(),

          choices:
            Array.isArray(
              item.choices
            )
              ? item.choices
                  .map(
                    function(choice) {
                      return String(
                        choice
                      ).trim();
                    }
                  )
                  .filter(Boolean)
              : []
        };
      }
    );
}


// ============================================================
// Process candidates
// ============================================================

async function findUsableIeltsVideos(
  items
) {
  const candidates = [];
  const seen = new Set();

  for (const item of items) {
    if (
      !item ||
      !item.id
    ) {
      continue;
    }

    const videoId =
      item.id.videoId ||
      item.id;

    if (!videoId) {
      continue;
    }

    if (
      seen.has(videoId)
    ) {
      continue;
    }

    seen.add(videoId);

    const snippet =
      item.snippet || {};

    const contentDetails =
      item.contentDetails || {};

    const status =
      item.status || {};

    const statistics =
      item.statistics || {};

    const title =
      String(
        snippet.title || ''
      );

    const description =
      String(
        snippet.description || ''
      );

    const combined =
      title +
      ' ' +
      description;

    if (
      !hasIeltsTerm(combined)
    ) {
      continue;
    }

    if (
      !hasListeningTerm(combined)
    ) {
      continue;
    }

    if (
      containsExcludedTerm(combined)
    ) {
      continue;
    }

    if (
      status.privacyStatus &&
      status.privacyStatus !==
        'public'
    ) {
      continue;
    }

    if (
      status.uploadStatus &&
      status.uploadStatus !==
        'processed'
    ) {
      continue;
    }

    if (
      status.embeddable === false
    ) {
      continue;
    }

    if (
      !isEnglishVideo(item)
    ) {
      continue;
    }

    const durationSeconds =
      parseDuration(
        contentDetails.duration
      );

    if (
      durationSeconds < 120 ||
      durationSeconds > 3600
    ) {
      continue;
    }

    const quality =
      calculateQuality(
        item,
        durationSeconds
      );

    if (
      quality < 45
    ) {
      continue;
    }

    const thumbnail =
      snippet.thumbnails &&
      (
        snippet.thumbnails.high ||
        snippet.thumbnails.medium ||
        snippet.thumbnails.default
      );

    candidates.push({
      videoId:
        videoId,

      title:
        title,

      description:
        description,

      channelTitle:
        snippet.channelTitle || '',

      channelId:
        snippet.channelId || '',

      publishedAt:
        snippet.publishedAt || null,

      defaultLanguage:
        snippet.defaultLanguage || null,

      defaultAudioLanguage:
        snippet.defaultAudioLanguage || null,

      duration:
        contentDetails.duration || null,

      durationSeconds:
        durationSeconds,

      durationFormatted:
        formatDuration(
          durationSeconds
        ),

      captionAvailable:
        contentDetails.caption ===
        'true',

      embeddable:
        status.embeddable !== false,

      viewCount:
        Number(
          statistics.viewCount || 0
        ),

      thumbnail:
        thumbnail
          ? thumbnail.url
          : null,

      quality:
        quality
    });
  }

  candidates.sort(
    function(a, b) {
      return (
        b.quality -
        a.quality
      );
    }
  );

  return candidates.slice(
    0,
    MAX_CANDIDATES_TO_ANALYZE
  );
}


// ============================================================
// GET /api/youtube/ielts
// ============================================================

router.get(
  '/ielts',
  async function(req, res) {
    try {
      const requestedSkill =
        normalizeText(
          req.query.skill ||
          'listening'
        );

      // Cette route est maintenant spécialisée
      // pour IELTS Listening.
      if (
        requestedSkill !==
        'listening'
      ) {
        return res.json({
          ok: true,

          version:
            'v2',

          language:
            'en',

          languageName:
            'English',

          section:
            'ielts',

          skill:
            'listening',

          searched:
            0,

          candidates:
            0,

          accepted:
            0,

          returned:
            0,

          videos:
            []
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

      if (
        !process.env.YOUTUBE_TRANSCRIPT_API_KEY
      ) {
        return res.status(500).json({
          ok: false,

          error:
            'YOUTUBE_TRANSCRIPT_API_KEY is missing'
        });
      }

      if (
        !process.env.ANTHROPIC_API_KEY
      ) {
        return res.status(500).json({
          ok: false,

          error:
            'ANTHROPIC_API_KEY is missing'
        });
      }

      console.log(
        'Searching for real IELTS Listening tests...'
      );

      // ------------------------------------------------------
      // 1. Search YouTube
      // ------------------------------------------------------

      let allItems = [];

      for (
        const query
        of LISTENING_QUERIES
      ) {
        try {
          console.log(
            'IELTS search:',
            query
          );

          const result =
            await searchYouTube(
              query
            );

          if (
            result &&
            Array.isArray(
              result.items
            )
          ) {
            allItems =
              allItems.concat(
                result.items
              );
          }
        } catch (error) {
          console.error(
            'Search error:',
            error.message
          );
        }
      }

      // ------------------------------------------------------
      // 2. Unique IDs
      // ------------------------------------------------------

      const ids = [];

      for (
        const item
        of allItems
      ) {
        const id =
          item &&
          item.id &&
          item.id.videoId
            ? item.id.videoId
            : null;

        if (
          id &&
          !ids.includes(id)
        ) {
          ids.push(id);
        }
      }

      if (!ids.length) {
        return res.json({
          ok: true,

          version:
            'v2',

          language:
            'en',

          languageName:
            'English',

          section:
            'ielts',

          skill:
            'listening',

          searched:
            0,

          candidates:
            0,

          accepted:
            0,

          returned:
            0,

          videos:
            []
        });
      }

      // ------------------------------------------------------
      // 3. Get details
      // ------------------------------------------------------

      const detailedItems = [];

      for (
        let i = 0;
        i < ids.length;
        i += 50
      ) {
        const chunk =
          ids.slice(
            i,
            i + 50
          );

        const details =
          await getVideoDetails(
            chunk
          );

        if (
          details &&
          Array.isArray(
            details.items
          )
        ) {
          detailedItems.push(
            ...details.items
          );
        }
      }

      // ------------------------------------------------------
      // 4. Strict candidate filtering
      // ------------------------------------------------------

      const candidates =
        await findUsableIeltsVideos(
          detailedItems
        );

      console.log(
        'IELTS candidates:',
        candidates.length
      );

      // ------------------------------------------------------
      // 5. Analyze candidates one by one
      // ------------------------------------------------------

      const acceptedVideos = [];

      for (
        const video
        of candidates
      ) {
        if (
          acceptedVideos.length >=
          MAX_RESULTS
        ) {
          break;
        }

        console.log(
          'Checking IELTS video:',
          video.videoId,
          video.title
        );

        try {
          const transcript =
            await getTranscript(
              video.videoId
            );

          if (!transcript) {
            console.log(
              'Rejected: no usable transcript'
            );

            continue;
          }

          // Première vérification rapide
          // avant d'utiliser Claude.
          if (
            !hasQuestionMarkers(
              transcript.text
            )
          ) {
            console.log(
              'Rejected: no IELTS question markers'
            );

            continue;
          }

          // Claude extrait uniquement
          // les questions réellement présentes.
          const questions =
            await extractIeltsQuestions(
              video,
              transcript.text
            );

          if (
            !questions.length
          ) {
            console.log(
              'Rejected: no IELTS questions extracted'
            );

            continue;
          }

          console.log(
            'Accepted:',
            video.videoId,
            'questions:',
            questions.length
          );

          acceptedVideos.push({
            ...video,

            transcript: {
              language:
                transcript.language,

              characters:
                transcript.text.length
            },

            questions:
              questions,

            questionCount:
              questions.length,

            ieltsVerified:
              true
          });

        } catch (error) {
          console.error(
            'IELTS video analysis error:',
            video.videoId,
            error.message
          );

          // On rejette cette vidéo
          // et on passe automatiquement
          // à la suivante.
          continue;
        }
      }

      // ------------------------------------------------------
      // 6. Final response
      // ------------------------------------------------------

      return res.json({
        ok: true,

        version:
          'v2',

        language:
          'en',

        languageName:
          'English',

        section:
          'ielts',

        skill:
          'listening',

        searched:
          detailedItems.length,

        candidates:
          candidates.length,

        accepted:
          acceptedVideos.length,

        returned:
          acceptedVideos.length,

        videos:
          acceptedVideos
      });

    } catch (error) {
      console.error(
        'IELTS route error:',
        error.response &&
        error.response.data
          ? error.response.data
          : error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          'IELTS Listening search failed',

        message:
          error.message
      });
    }
  }
);


module.exports = router;
````
