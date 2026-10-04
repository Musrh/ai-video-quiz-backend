const express = require('express');
const axios = require('axios');

const router = express.Router();

// ============================================================================
// CONFIGURATION
// ============================================================================

const YOUTUBE_API_URL =
  'https://www.googleapis.com/youtube/v3';

const TRANSCRIPT_API_URL =
  'https://www.youtubetranscript.dev/api/v2/transcribe';

const ANTHROPIC_URL =
  'https://api.anthropic.com/v1/messages';

const CLAUDE_MODEL =
  'claude-sonnet-5';

// ============================================================================
// RECHERCHES IELTS LISTENING
// ============================================================================

const LISTENING_QUERIES = [
  'IELTS Listening test with questions',
  'IELTS Listening practice test questions',
  'IELTS Listening full test questions',
  'IELTS Listening practice Cambridge questions',
  'IELTS Listening test section 1 2 3 4',
  'IELTS Listening test answers questions',
  'IELTS Listening actual test questions',
  'IELTS Listening mock test questions'
];

// ============================================================================
// TERMES IELTS
// ============================================================================

const IELTS_TERMS = [
  'ielts',
  'ielts academic',
  'ielts general training',
  'ielts preparation',
  'ielts test',
  'ielts practice',
  'ielts listening',
  'ielts listening test',
  'ielts listening practice',
  'ielts mock test',
  'ielts exam',
  'cambridge ielts'
];

// ============================================================================
// TERMES À EXCLURE
// ============================================================================

const EXCLUDED_TERMS = [
  'shorts',
  '#shorts',
  'music video',
  'lyrics',
  'karaoke',
  'remix',
  'trailer',
  'teaser',
  'livestream',
  'live stream',
  'live',
  'song',
  'songs',
  'movie',
  'film',
  'podcast',
  'reaction',
  'reacting'
];

// ============================================================================
// MARQUEURS DE QUESTIONS IELTS LISTENING
// ============================================================================

const QUESTION_MARKERS = [
  // Numérotation
  'question 1',
  'question 2',
  'question 3',
  'question 4',
  'question 5',
  'question 6',
  'question 7',
  'question 8',
  'question 9',
  'question 10',
  'question 11',
  'question 12',
  'question 13',
  'question 14',
  'question 15',
  'question 16',
  'question 17',
  'question 18',
  'question 19',
  'question 20',
  'question 21',
  'question 22',
  'question 23',
  'question 24',
  'question 25',
  'question 26',
  'question 27',
  'question 28',
  'question 29',
  'question 30',
  'question 31',
  'question 32',
  'question 33',
  'question 34',
  'question 35',
  'question 36',
  'question 37',
  'question 38',
  'question 39',
  'question 40',

  // Plages
  'questions 1-5',
  'questions 1 to 5',
  'questions 1–5',
  'questions 6-10',
  'questions 6 to 10',
  'questions 6–10',
  'questions 11-15',
  'questions 11 to 15',
  'questions 11–15',
  'questions 16-20',
  'questions 16 to 20',
  'questions 16–20',
  'questions 21-25',
  'questions 21 to 25',
  'questions 21–25',
  'questions 26-30',
  'questions 26 to 30',
  'questions 26–30',
  'questions 31-35',
  'questions 31 to 35',
  'questions 31–35',
  'questions 36-40',
  'questions 36 to 40',
  'questions 36–40',

  // Instructions IELTS
  'choose the correct answer',
  'choose two answers',
  'choose the correct letter',
  'choose the correct letters',

  'complete the form',
  'complete the notes',
  'complete the table',
  'complete the sentence',
  'complete the summary',
  'complete the flow-chart',
  'complete the flow chart',

  'write one word',
  'write no more than one word',
  'write no more than two words',
  'write no more than three words',

  'match',
  'matching',

  'which option',
  'which of the following',

  'section 1',
  'section 2',
  'section 3',
  'section 4'
];

// ============================================================================
// OUTILS
// ============================================================================

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(text, terms) {
  const normalized = normalizeText(text);

  return terms.some(term =>
    normalized.includes(
      normalizeText(term)
    )
  );
}

function getVideoIdFromUrl(input) {
  if (!input) {
    return null;
  }

  const value = String(input).trim();

  // ID direct
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    // youtube.com/watch?v=
    const queryId =
      url.searchParams.get('v');

    if (
      queryId &&
      /^[a-zA-Z0-9_-]{11}$/.test(queryId)
    ) {
      return queryId;
    }

    // youtu.be/VIDEO_ID
    if (
      url.hostname === 'youtu.be' ||
      url.hostname.endsWith('youtu.be')
    ) {
      const id =
        url.pathname
          .replace(/^\/+/, '')
          .split('/')[0];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(id)
      ) {
        return id;
      }
    }

    // /shorts/VIDEO_ID
    const shortsMatch =
      url.pathname.match(
        /\/shorts\/([a-zA-Z0-9_-]{11})/
      );

    if (shortsMatch) {
      return shortsMatch[1];
    }

    // /embed/VIDEO_ID
    const embedMatch =
      url.pathname.match(
        /\/embed\/([a-zA-Z0-9_-]{11})/
      );

    if (embedMatch) {
      return embedMatch[1];
    }

  } catch (error) {
    // Rien
  }

  return null;
}

// ============================================================================
// DURÉE ISO 8601 YOUTUBE -> SECONDES
// ============================================================================

function parseDuration(duration) {
  if (!duration) {
    return 0;
  }

  const match =
    String(duration).match(
      /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/
    );

  if (!match) {
    return 0;
  }

  const days =
    Number(match[1] || 0);

  const hours =
    Number(match[2] || 0);

  const minutes =
    Number(match[3] || 0);

  const seconds =
    Number(match[4] || 0);

  return (
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}

// ============================================================================
// FORMATAGE TEMPS
// ============================================================================

function formatTime(seconds) {
  const total =
    Math.max(
      0,
      Math.floor(
        Number(seconds) || 0
      )
    );

  const minutes =
    Math.floor(total / 60);

  const secs =
    total % 60;

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ============================================================================
// YOUTUBE SEARCH
// ============================================================================

async function searchYouTube(query) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error(
      'YOUTUBE_API_KEY manquante'
    );
  }

  const response =
    await axios.get(
      `${YOUTUBE_API_URL}/search`,
      {
        params: {
          part: 'snippet',
          q: query,
          type: 'video',

          maxResults: 50,

          // IMPORTANT :
          // on accepte toutes les durées
          // car certains tests IELTS peuvent
          // dépasser les anciennes limites.
          videoDuration: 'any',

          videoEmbeddable: 'true',
          videoSyndicated: 'true',

          relevanceLanguage: 'en',

          regionCode: 'US',

          key: process.env.YOUTUBE_API_KEY
        },

        timeout: 20000
      }
    );

  return response.data.items || [];
}

// ============================================================================
// YOUTUBE DETAILS
// ============================================================================

async function getVideoDetails(videoIds) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error(
      'YOUTUBE_API_KEY manquante'
    );
  }

  const ids =
    Array.isArray(videoIds)
      ? videoIds
      : [videoIds];

  const cleanIds =
    ids
      .filter(Boolean)
      .map(String)
      .filter(id =>
        /^[a-zA-Z0-9_-]{11}$/.test(id)
      );

  if (cleanIds.length === 0) {
    return [];
  }

  const response =
    await axios.get(
      `${YOUTUBE_API_URL}/videos`,
      {
        params: {
          part:
            'snippet,contentDetails,status,statistics',

          id: cleanIds.join(','),

          key:
            process.env.YOUTUBE_API_KEY
        },

        timeout: 20000
      }
    );

  return response.data.items || [];
}

// ============================================================================
// CONSTRUIRE UN OBJET VIDÉO
// ============================================================================

function buildVideoObject(item) {
  const snippet =
    item.snippet || {};

  const contentDetails =
    item.contentDetails || {};

  const statistics =
    item.statistics || {};

  const status =
    item.status || {};

  const videoId =
    item.id || '';

  const title =
    snippet.title || '';

  const description =
    snippet.description || '';

  const durationSeconds =
    parseDuration(
      contentDetails.duration
    );

  const language =
    snippet.defaultLanguage ||
    snippet.defaultAudioLanguage ||
    '';

  const views =
    Number(
      statistics.viewCount || 0
    );

  const likes =
    Number(
      statistics.likeCount || 0
    );

  return {
    videoId,

    title,

    description,

    channelTitle:
      snippet.channelTitle || '',

    publishedAt:
      snippet.publishedAt || null,

    duration:
      contentDetails.duration || null,

    durationSeconds,

    language:
      language || 'en',

    thumbnail:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      null,

    views,

    likes,

    quality: calculateQuality({
      views,
      likes,
      title,
      description,
      durationSeconds
    }),

    skill: 'listening',

    privacyStatus:
      status.privacyStatus || null,

    embeddable:
      status.embeddable !== false
  };
}

// ============================================================================
// SCORE QUALITÉ
// ============================================================================

function calculateQuality({
  views,
  likes,
  title,
  description,
  durationSeconds
}) {
  let score = 0;

  if (containsAny(title, IELTS_TERMS)) {
    score += 40;
  }

  if (
    containsAny(
      title,
      [
        'listening',
        'questions',
        'test',
        'practice'
      ]
    )
  ) {
    score += 20;
  }

  if (description.length >= 20) {
    score += 10;
  }

  if (durationSeconds >= 300) {
    score += 10;
  }

  if (views > 1000) {
    score += 5;
  }

  if (views > 10000) {
    score += 5;
  }

  if (likes > 100) {
    score += 5;
  }

  if (likes > 1000) {
    score += 5;
  }

  return Math.min(
    100,
    score
  );
}

// ============================================================================
// FILTRE DES VIDÉOS DE RECHERCHE
//
// IMPORTANT : ce filtre sert uniquement aux résultats de recherche.
// Le test direct /ielts/test-video NE PASSE PAS par cette fonction.
// ============================================================================

function processVideos(items) {
  const result = [];

  for (const item of items) {
    const snippet =
      item.snippet || {};

    const status =
      item.status || {};

    const contentDetails =
      item.contentDetails || {};

    const title =
      snippet.title || '';

    const description =
      snippet.description || '';

    const combinedText =
      `${title} ${description}`;

    // ----------------------------------------------------------
    // IELTS obligatoire pour les résultats de recherche
    // ----------------------------------------------------------

    if (
      !containsAny(
        combinedText,
        IELTS_TERMS
      )
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // Exclusions
    // ----------------------------------------------------------

    if (
      containsAny(
        combinedText,
        EXCLUDED_TERMS
      )
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // Public
    // ----------------------------------------------------------

    if (
      status.privacyStatus &&
      status.privacyStatus !== 'public'
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // Embeddable
    // ----------------------------------------------------------

    if (
      status.embeddable === false
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // Langue
    //
    // On rejette uniquement une langue explicitement
    // non anglaise.
    // ----------------------------------------------------------

    const language =
      snippet.defaultLanguage ||
      snippet.defaultAudioLanguage ||
      '';

    if (
      language &&
      !normalizeText(language).startsWith('en')
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // Durée
    // ----------------------------------------------------------

    const durationSeconds =
      parseDuration(
        contentDetails.duration
      );

    // ----------------------------------------------------------
    // Objet
    // ----------------------------------------------------------

    const video =
      buildVideoObject(item);

    // Pour la recherche IELTS :
    // une vidéo extrêmement courte n'est généralement
    // pas un vrai test Listening.
    if (
      durationSeconds > 0 &&
      durationSeconds < 60
    ) {
      continue;
    }

    result.push(video);
  }

  return result;
}

// ============================================================================
// TRANSCRIPT
// ============================================================================

async function getTranscript(videoId) {
  if (!videoId) {
    return null;
  }

  if (
    !process.env.YOUTUBE_TRANSCRIPT_API_KEY
  ) {
    throw new Error(
      'YOUTUBE_TRANSCRIPT_API_KEY manquante'
    );
  }

  try {
    console.log(
      `\n📝 Transcript demandé pour ${videoId}`
    );

    const response =
      await axios.post(
        TRANSCRIPT_API_URL,
        {
          video: videoId,

          language: 'en',

          source: 'auto',

          // IMPORTANT :
          // on demande les timestamps afin de savoir
          // à quel moment les questions apparaissent.
          format: {
            timestamp: true,
            paragraphs: true,
            words: false
          }
        },
        {
          headers: {
            Authorization:
              `Bearer ${process.env.YOUTUBE_TRANSCRIPT_API_KEY}`,

            'Content-Type':
              'application/json'
          },

          timeout: 60000
        }
      );

    const data =
      response.data || {};

    console.log(
      `📥 Réponse transcript reçue`
    );

    console.log(
      `📊 Status: ${
        data.status || 'inconnu'
      }`
    );

    // ----------------------------------------------------------
    // Recherche du texte
    // ----------------------------------------------------------

    let text = '';

    if (
      typeof data.text === 'string'
    ) {
      text = data.text;
    }

    if (
      !text &&
      typeof data.transcript === 'string'
    ) {
      text =
        data.transcript;
    }

    if (
      !text &&
      Array.isArray(data.segments)
    ) {
      text =
        data.segments
          .map(segment =>
            segment.text || ''
          )
          .join(' ');
    }

    if (
      !text &&
      Array.isArray(data.transcript)
    ) {
      text =
        data.transcript
          .map(segment =>
            segment.text || ''
          )
          .join(' ');
    }

    // ----------------------------------------------------------
    // Segments
    // ----------------------------------------------------------

    let rawSegments = [];

    if (
      Array.isArray(data.segments)
    ) {
      rawSegments =
        data.segments;
    } else if (
      Array.isArray(data.transcript)
    ) {
      rawSegments =
        data.transcript;
    } else if (
      Array.isArray(data.items)
    ) {
      rawSegments =
        data.items;
    }

    const segments =
      rawSegments
        .map(segment => {
          const segmentText =
            String(
              segment.text ||
              segment.content ||
              ''
            ).trim();

          const start =
            Number(
              segment.start ??
              segment.startTime ??
              segment.offset ??
              0
            );

          const end =
            Number(
              segment.end ??
              segment.endTime ??
              (
                start +
                Number(
                  segment.duration || 0
                )
              )
            );

          return {
            text: segmentText,

            start,

            end,

            startFormatted:
              formatTime(start),

            endFormatted:
              formatTime(end)
          };
        })
        .filter(
          segment =>
            segment.text.length > 0
        );

    console.log(
      `🧩 Segments: ${segments.length}`
    );

    console.log(
      `📝 Longueur texte: ${text.length}`
    );

    // ----------------------------------------------------------
    // Transcript non terminé
    // ----------------------------------------------------------

    if (
      data.status &&
      data.status !== 'completed'
    ) {
      console.log(
        `⚠️ Transcript non terminé: ${data.status}`
      );

      return {
        text,
        segments,

        status:
          data.status,

        language:
          data.language || 'en',

        source:
          data.source || 'youtube',

        videoId
      };
    }

    return {
      text,

      segments,

      status:
        data.status || 'completed',

      language:
        data.language || 'en',

      source:
        data.source || 'youtube',

      videoId
    };

  } catch (error) {
    console.error(
      `❌ Erreur transcript ${videoId}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ============================================================================
// DÉTECTION DES MARQUEURS IELTS
// ============================================================================

function hasQuestionMarkers(text) {
  const normalized =
    normalizeText(text);

  const found =
    QUESTION_MARKERS.filter(
      marker =>
        normalized.includes(
          normalizeText(marker)
        )
    );

  return {
    found:
      found.length > 0,

    markers:
      found
  };
}

// ============================================================================
// TROUVER LES SEGMENTS DE QUESTIONS
// ============================================================================

function findQuestionSegments(segments) {
  if (
    !Array.isArray(segments)
  ) {
    return [];
  }

  const results = [];

  for (
    let i = 0;
    i < segments.length;
    i++
  ) {
    const segment =
      segments[i];

    const normalized =
      normalizeText(
        segment.text
      );

    const hasMarker =
      QUESTION_MARKERS.some(
        marker =>
          normalized.includes(
            normalizeText(marker)
          )
      );

    if (!hasMarker) {
      continue;
    }

    // ----------------------------------------------------------
    // On prend également plusieurs segments autour.
    // Une question IELTS peut être répartie sur plusieurs
    // phrases dans le transcript.
    // ----------------------------------------------------------

    const startIndex =
      Math.max(
        0,
        i - 2
      );

    const endIndex =
      Math.min(
        segments.length - 1,
        i + 8
      );

    const context =
      segments
        .slice(
          startIndex,
          endIndex + 1
        )
        .map(item => ({
          text: item.text,
          start: item.start,
          end: item.end,
          startFormatted:
            item.startFormatted,
          endFormatted:
            item.endFormatted
        }));

    results.push({
      markerSegmentIndex: i,

      markerText:
        segment.text,

      start:
        segment.start,

      end:
        segments[endIndex].end,

      startFormatted:
        segment.startFormatted,

      endFormatted:
        segments[endIndex]
          .endFormatted,

      context
    });
  }

  // ----------------------------------------------------------
  // Éliminer les doublons / zones qui se chevauchent
  // ----------------------------------------------------------

  const merged = [];

  for (const zone of results) {
    const previous =
      merged[merged.length - 1];

    if (
      previous &&
      zone.start <= previous.end
    ) {
      previous.end =
        Math.max(
          previous.end,
          zone.end
        );

      previous.endFormatted =
        formatTime(
          previous.end
        );

      previous.context =
        [
          ...previous.context,
          ...zone.context
        ];
    } else {
      merged.push({
        ...zone
      });
    }
  }

  return merged;
}

// ============================================================================
// CLAUDE
//
// IMPORTANT :
// Claude NE GÉNÈRE PAS de nouvelles questions.
// Il extrait uniquement celles qui existent réellement
// dans le transcript.
// ============================================================================

async function extractIeltsQuestions(
  video,
  transcript,
  questionZones
) {
  if (
    !process.env.ANTHROPIC_API_KEY
  ) {
    throw new Error(
      'ANTHROPIC_API_KEY manquante'
    );
  }

  const fullTranscript =
    transcript.text || '';

  if (
    !fullTranscript ||
    fullTranscript.length < 50
  ) {
    return [];
  }

  const zonesText =
    questionZones
      .map(
        (zone, index) => {
          const context =
            zone.context
              .map(
                segment =>
                  `[${segment.startFormatted}] ${segment.text}`
              )
              .join('\n');

          return `
--- ZONE ${index + 1} ---
Début: ${zone.startFormatted}
Fin: ${zone.endFormatted}

${context}
`;
        }
      )
      .join('\n');

  const prompt = `
You are an IELTS Listening question extraction system.

IMPORTANT:
You MUST NOT create new questions.

Your task is ONLY to extract IELTS Listening questions
that are actually present in the supplied transcript.

VIDEO:
Title: ${video.title}
Video ID: ${video.videoId}

TRANSCRIPT:
${fullTranscript}

POSSIBLE QUESTION ZONES:
${zonesText}

RULES:

1. Extract ONLY questions that actually appear in the transcript.

2. Do NOT invent questions.

3. Do NOT transform a normal sentence into a question.

4. Preserve the original wording as closely as possible.

5. Detect IELTS Listening sections and question numbers
   whenever they are explicitly identifiable.

6. If a question number is spoken, use it.

7. If the question number is not known, use null.

8. Extract answer choices ONLY if they are actually present
   in the transcript.

9. Never invent answer choices.

10. If the question is a form/table/note completion task,
    preserve the task wording.

11. If the transcript only contains the instructions
    but not the actual question, do not fabricate the question.

12. If there are no identifiable IELTS Listening questions,
    return an empty array.

13. Return valid JSON only.

JSON format:

{
  "questions": [
    {
      "number": 1,
      "section": 1,
      "type": "multiple_choice",
      "question": "exact question text",
      "choices": [
        "A. ...",
        "B. ...",
        "C. ..."
      ],
      "startTime": 123,
      "endTime": 145
    }
  ]
}

Allowed type values:

- multiple_choice
- matching
- form_completion
- note_completion
- table_completion
- sentence_completion
- summary_completion
- short_answer
- unknown

If choices are not spoken or visible in the transcript,
use:

"choices": []

Do not invent the correct answer.

Return JSON only.
`;

  try {
    console.log(
      `\n🤖 Extraction des questions avec Claude...`
    );

    const response =
      await axios.post(
        ANTHROPIC_URL,
        {
          model:
            CLAUDE_MODEL,

          max_tokens:
            8000,

          temperature:
            0,

          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        },
        {
          headers: {
            'x-api-key':
              process.env.ANTHROPIC_API_KEY,

            'anthropic-version':
              '2023-06-01',

            'Content-Type':
              'application/json'
          },

          timeout: 120000
        }
      );

    const content =
      response.data?.content
        ?.map(item =>
          item.text || ''
        )
        .join('') || '';

    console.log(
      `🤖 Réponse Claude longueur: ${content.length}`
    );

    if (!content) {
      return [];
    }

    let jsonText =
      content.trim();

    // ----------------------------------------------------------
    // Nettoyage éventuel des ```json
    // ----------------------------------------------------------

    jsonText =
      jsonText
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

    let parsed;

    try {
      parsed =
        JSON.parse(
          jsonText
        );
    } catch (parseError) {
      console.error(
        '❌ JSON Claude invalide:',
        parseError.message
      );

      // Tentative de récupération
      const firstBrace =
        jsonText.indexOf('{');

      const lastBrace =
        jsonText.lastIndexOf('}');

      if (
        firstBrace !== -1 &&
        lastBrace !== -1 &&
        lastBrace > firstBrace
      ) {
        try {
          parsed =
            JSON.parse(
              jsonText.slice(
                firstBrace,
                lastBrace + 1
              )
            );
        } catch (secondError) {
          console.error(
            '❌ Impossible de récupérer le JSON Claude'
          );

          return [];
        }
      } else {
        return [];
      }
    }

    if (
      !parsed ||
      !Array.isArray(
        parsed.questions
      )
    ) {
      return [];
    }

    return parsed.questions;

  } catch (error) {
    console.error(
      '❌ Erreur Claude extraction:',
      error.response?.data ||
      error.message
    );

    return [];
  }
}

// ============================================================================
// VALIDATION DES QUESTIONS EXTRAITES
// ============================================================================

function validateExtractedQuestions(
  questions
) {
  if (
    !Array.isArray(questions)
  ) {
    return [];
  }

  return questions
    .map(question => {
      if (!question) {
        return null;
      }

      const text =
        String(
          question.question || ''
        ).trim();

      if (
        text.length < 5
      ) {
        return null;
      }

      const choices =
        Array.isArray(
          question.choices
        )
          ? question.choices
              .map(choice =>
                String(
                  choice || ''
                ).trim()
              )
              .filter(Boolean)
          : [];

      const startTime =
        Number(
          question.startTime
        );

      const endTime =
        Number(
          question.endTime
        );

      return {
        number:
          question.number ??
          null,

        section:
          question.section ??
          null,

        type:
          question.type ||
          'unknown',

        question:
          text,

        choices,

        startTime:
          Number.isFinite(
            startTime
          )
            ? startTime
            : null,

        endTime:
          Number.isFinite(
            endTime
          )
            ? endTime
            : null,

        startTimeFormatted:
          Number.isFinite(
            startTime
          )
            ? formatTime(
                startTime
              )
            : null,

        endTimeFormatted:
          Number.isFinite(
            endTime
          )
            ? formatTime(
                endTime
              )
            : null
      };
    })
    .filter(Boolean);
}

// ============================================================================
// ANALYSE RÉELLE D'UNE VIDÉO IELTS LISTENING
// ============================================================================

async function analyzeListeningVideo(
  video
) {
  console.log(
    `\n==================================================`
  );

  console.log(
    `🎧 ANALYSE IELTS LISTENING`
  );

  console.log(
    `🎬 ${video.videoId}`
  );

  console.log(
    `📌 ${video.title}`
  );

  console.log(
    `==================================================`
  );

  // ----------------------------------------------------------
  // 1. Transcript
  // ----------------------------------------------------------

  const transcript =
    await getTranscript(
      video.videoId
    );

  if (!transcript) {
    console.log(
      `🚫 Aucun transcript`
    );

    return null;
  }

  if (
    transcript.status &&
    transcript.status !== 'completed'
  ) {
    console.log(
      `🚫 Transcript non terminé: ${transcript.status}`
    );

    return null;
  }

  if (
    !transcript.text ||
    transcript.text.length < 50
  ) {
    console.log(
      `🚫 Transcript trop court`
    );

    return null;
  }

  console.log(
    `✅ Transcript disponible`
  );

  // ----------------------------------------------------------
  // 2. Détection des marqueurs
  // ----------------------------------------------------------

  const markerResult =
    hasQuestionMarkers(
      transcript.text
    );

  console.log(
    `🔎 Marqueurs trouvés: ${
      markerResult.found
    }`
  );

  console.log(
    `📌 Marqueurs: ${
      markerResult.markers.join(', ')
    }`
  );

  if (
    !markerResult.found
  ) {
    console.log(
      `🚫 Aucun marqueur IELTS Listening`
    );

    return null;
  }

  // ----------------------------------------------------------
  // 3. Zones de questions
  // ----------------------------------------------------------

  const questionZones =
    findQuestionSegments(
      transcript.segments
    );

  console.log(
    `🎯 Zones de questions: ${
      questionZones.length
    }`
  );

  for (
    const zone of questionZones
  ) {
    console.log(
      `   ⏱️ ${zone.startFormatted} → ${zone.endFormatted}`
    );

    console.log(
      `   📝 ${zone.markerText}`
    );
  }

  if (
    questionZones.length === 0
  ) {
    console.log(
      `🚫 Impossible de localiser les questions`
    );

    return null;
  }

  // ----------------------------------------------------------
  // 4. Extraction
  // ----------------------------------------------------------

  const extracted =
    await extractIeltsQuestions(
      video,
      transcript,
      questionZones
    );

  console.log(
    `📚 Questions extraites: ${
      extracted.length
    }`
  );

  // ----------------------------------------------------------
  // 5. Validation
  // ----------------------------------------------------------

  const questions =
    validateExtractedQuestions(
      extracted
    );

  console.log(
    `✅ Questions valides: ${
      questions.length
    }`
  );

  if (
    questions.length === 0
  ) {
    console.log(
      `🚫 Aucune question IELTS exploitable`
    );

    return null;
  }

  // ----------------------------------------------------------
  // Résultat
  // ----------------------------------------------------------

  return {
    ...video,

    ieltsVerified:
      true,

    transcriptAvailable:
      true,

    transcriptLanguage:
      transcript.language || 'en',

    questionMarkers:
      markerResult.markers,

    questionZones:
      questionZones.map(
        zone => ({
          start:
            zone.start,

          end:
            zone.end,

          startFormatted:
            zone.startFormatted,

          endFormatted:
            zone.endFormatted,

          marker:
            zone.markerText
        })
      ),

    questions,

    questionCount:
      questions.length
  };
}

// ============================================================================
// ROUTE PRINCIPALE IELTS
//
// Recherche plusieurs vidéos puis vérifie réellement leur transcript.
// Une vidéo sans questions IELTS est rejetée.
// ============================================================================

router.get(
  '/ielts',
  async (req, res) => {
    try {
      const skill =
        String(
          req.query.skill ||
          'listening'
        )
          .toLowerCase()
          .trim();

      // --------------------------------------------------------
      // Pour l'instant notre logique d'extraction réelle
      // concerne IELTS Listening.
      // --------------------------------------------------------

      if (
        skill !== 'listening'
      ) {
        return res.json({
          ok: true,

          skill,

          message:
            'La vérification réelle des questions est actuellement disponible pour IELTS Listening.',

          videos: []
        });
      }

      console.log(
        `\n==================================================`
      );

      console.log(
        `🎧 RECHERCHE IELTS LISTENING`
      );

      console.log(
        `==================================================`
      );

      // --------------------------------------------------------
      // Recherche
      // --------------------------------------------------------

      const allItems = [];

      for (
        const query of LISTENING_QUERIES
      ) {
        try {
          console.log(
            `🔎 Recherche: ${query}`
          );

          const items =
            await searchYouTube(
              query
            );

          allItems.push(
            ...items
          );

        } catch (error) {
          console.error(
            `❌ Recherche "${query}" échouée:`,
            error.response?.data ||
            error.message
          );
        }
      }

      // --------------------------------------------------------
      // Déduplication
      // --------------------------------------------------------

      const uniqueIds =
        [
          ...new Set(
            allItems
              .map(
                item =>
                  item.id?.videoId
              )
              .filter(Boolean)
          )
        ];

      console.log(
        `📊 Vidéos uniques trouvées: ${
          uniqueIds.length
        }`
      );

      if (
        uniqueIds.length === 0
      ) {
        return res.json({
          ok: true,

          skill: 'listening',

          videos: [],

          count: 0
        });
      }

      // --------------------------------------------------------
      // Détails YouTube
      // --------------------------------------------------------

      const details =
        await getVideoDetails(
          uniqueIds.slice(
            0,
            50
          )
        );

      const candidates =
        processVideos(
          details
        );

      console.log(
        `📋 Candidates après filtres: ${
          candidates.length
        }`
      );

      // --------------------------------------------------------
      // Analyse réelle
      //
      // On ne garde QUE les vidéos qui possèdent réellement
      // des questions IELTS Listening exploitables.
      // --------------------------------------------------------

      const verifiedVideos = [];

      // Limite volontaire pour éviter trop d'appels
      // transcript + Claude sur une seule requête.
      const candidatesToAnalyze =
        candidates.slice(
          0,
          15
        );

      for (
        const video of candidatesToAnalyze
      ) {
        try {
          const verified =
            await analyzeListeningVideo(
              video
            );

          if (verified) {
            verifiedVideos.push(
              verified
            );

            console.log(
              `✅ VIDÉO CONSERVÉE: ${video.videoId}`
            );

            // On peut arrêter lorsqu'on a assez
            // de vraies vidéos IELTS.
            if (
              verifiedVideos.length >= 5
            ) {
              break;
            }

          } else {
            console.log(
              `🚫 VIDÉO REJETÉE: ${video.videoId}`
            );
          }

        } catch (error) {
          console.error(
            `❌ Analyse ${video.videoId}:`,
            error.message
          );
        }
      }

      // --------------------------------------------------------
      // Tri
      // --------------------------------------------------------

      verifiedVideos.sort(
        (a, b) =>
          (
            b.quality || 0
          ) -
          (
            a.quality || 0
          )
      );

      console.log(
        `\n🎯 VIDÉOS IELTS VALIDÉES: ${
          verifiedVideos.length
        }`
      );

      return res.json({
        ok: true,

        skill: 'listening',

        videos:
          verifiedVideos,

        count:
          verifiedVideos.length
      });

    } catch (error) {
      console.error(
        '\n❌ ERREUR IELTS:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          'Erreur serveur IELTS'
      });
    }
  }
);

// ============================================================================
// TEST DIRECT D'UNE VIDÉO
//
// IMPORTANT
// ---------
// Cette route NE DOIT PAS utiliser processVideos().
//
// Elle prend directement une vidéo connue,
// récupère ses métadonnées,
// puis analyse son transcript.
// ============================================================================

router.get(
  '/ielts/test-video',
  async (req, res) => {
    try {
      const videoId =
        getVideoIdFromUrl(
          req.query.videoId
        );

      if (!videoId) {
        return res.status(400).json({
          ok: false,

          error:
            'videoId ou URL YouTube invalide'
        });
      }

      console.log(
        `\n==================================================`
      );

      console.log(
        `🧪 TEST DIRECT IELTS`
      );

      console.log(
        `==================================================`
      );

      console.log(
        `🎬 Video ID: ${videoId}`
      );

      // --------------------------------------------------------
      // IMPORTANT :
      // On récupère directement les détails YouTube.
      //
      // On NE FAIT PAS :
      //
      // processVideos()
      //
      // car cette fonction est réservée aux vidéos provenant
      // de la recherche.
      // --------------------------------------------------------

      const details =
        await getVideoDetails([
          videoId
        ]);

      if (
        !details ||
        details.length === 0
      ) {
        return res.status(404).json({
          ok: false,

          videoId,

          error:
            'Vidéo YouTube introuvable'
        });
      }

      const youtubeVideo =
        details[0];

      const snippet =
        youtubeVideo.snippet || {};

      const contentDetails =
        youtubeVideo.contentDetails ||
        {};

      const status =
        youtubeVideo.status || {};

      const statistics =
        youtubeVideo.statistics ||
        {};

      const title =
        snippet.title || '';

      const description =
        snippet.description || '';

      const durationSeconds =
        parseDuration(
          contentDetails.duration
        );

      const language =
        snippet.defaultLanguage ||
        snippet.defaultAudioLanguage ||
        '';

      console.log(
        `📌 Titre: ${title}`
      );

      console.log(
        `⏱️ Durée: ${durationSeconds}s`
      );

      console.log(
        `🌐 Langue déclarée: ${
          language || 'non renseignée'
        }`
      );

      console.log(
        `🔓 Privacy: ${
          status.privacyStatus ||
          'inconnue'
        }`
      );

      console.log(
        `📺 Embeddable: ${
          status.embeddable
        }`
      );

      // --------------------------------------------------------
      // Construction directe de l'objet vidéo
      // --------------------------------------------------------

      const video = {
        videoId,

        title,

        description,

        channelTitle:
          snippet.channelTitle || '',

        publishedAt:
          snippet.publishedAt || null,

        duration:
          contentDetails.duration ||
          null,

        durationSeconds,

        language:
          language || 'en',

        thumbnail:
          snippet.thumbnails?.high?.url ||
          snippet.thumbnails?.medium?.url ||
          snippet.thumbnails?.default?.url ||
          null,

        views:
          Number(
            statistics.viewCount || 0
          ),

        likes:
          Number(
            statistics.likeCount || 0
          ),

        // Pour un test direct, on ne fait pas dépendre
        // l'analyse du score de recherche.
        quality: 100,

        skill:
          'listening',

        privacyStatus:
          status.privacyStatus ||
          null,

        embeddable:
          status.embeddable !== false
      };

      // --------------------------------------------------------
      // Analyse réelle
      // --------------------------------------------------------

      console.log(
        `\n🎧 Début analyse réelle de la vidéo...`
      );

      const result =
        await analyzeListeningVideo(
          video
        );

      // --------------------------------------------------------
      // Vidéo rejetée
      // --------------------------------------------------------

      if (!result) {
        console.log(
          `\n🚫 VIDÉO REJETÉE`
        );

        return res.json({
          ok: false,

          videoId,

          title,

          error:
            'La vidéo ne contient pas de questions IELTS Listening exploitables'
        });
      }

      // --------------------------------------------------------
      // Vidéo validée
      // --------------------------------------------------------

      console.log(
        `\n==================================================`
      );

      console.log(
        `✅ VIDÉO IELTS VALIDÉE`
      );

      console.log(
        `🎯 Questions: ${
          result.questionCount
        }`
      );

      console.log(
        `==================================================`
      );

      return res.json({
        ok: true,

        video:
          result
      });

    } catch (error) {
      console.error(
        '\n❌ ERREUR TEST IELTS:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          'Erreur serveur'
      });
    }
  }
);

// ============================================================================
// ROUTE SIMPLE DE DIAGNOSTIC DU TRANSCRIPT
//
// Utile pour voir directement ce que renvoie l'API transcript.
// ============================================================================

router.get(
  '/ielts/test-transcript',
  async (req, res) => {
    try {
      const videoId =
        getVideoIdFromUrl(
          req.query.videoId
        );

      if (!videoId) {
        return res.status(400).json({
          ok: false,

          error:
            'videoId ou URL YouTube invalide'
        });
      }

      const transcript =
        await getTranscript(
          videoId
        );

      if (!transcript) {
        return res.json({
          ok: false,

          videoId,

          error:
            'Transcript indisponible'
        });
      }

      const markers =
        hasQuestionMarkers(
          transcript.text
        );

      const zones =
        findQuestionSegments(
          transcript.segments
        );

      return res.json({
        ok: true,

        videoId,

        status:
          transcript.status,

        language:
          transcript.language,

        textLength:
          transcript.text.length,

        segmentCount:
          transcript.segments.length,

        questionMarkers:
          markers,

        questionZones:
          zones,

        // On limite le texte retourné afin de ne pas
        // envoyer une réponse gigantesque.
        transcript:
          transcript.text.slice(
            0,
            20000
          ),

        segments:
          transcript.segments.slice(
            0,
            300
          )
      });

    } catch (error) {
      console.error(
        '❌ TEST TRANSCRIPT:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          'Erreur transcript'
      });
    }
  }
);

// ============================================================================
// EXPORT
// ============================================================================

module.exports = router;
