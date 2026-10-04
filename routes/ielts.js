const express = require('express');
const axios = require('axios');

const router = express.Router();

// ============================================================================
// CONFIGURATION
// ============================================================================

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';

const TRANSCRIPT_API_URL =
  'https://www.youtubetranscript.dev/api/v2/transcribe';

const ANTHROPIC_URL =
  'https://api.anthropic.com/v1/messages';

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// ============================================================================
// REQUÊTES IELTS
// ============================================================================

const SKILL_QUERIES = {
  all: [
    'IELTS practice',
    'IELTS test',
    'IELTS preparation',
    'IELTS Academic',
    'IELTS General Training'
  ],

  listening: [
    'IELTS Listening test with questions',
    'IELTS Listening practice test questions',
    'IELTS Listening full test questions',
    'IELTS Listening practice Cambridge questions',
    'IELTS Listening test section 1 2 3 4'
  ],

  speaking: [
    'IELTS Speaking practice',
    'IELTS Speaking test',
    'IELTS Speaking questions'
  ],

  reading: [
    'IELTS Reading practice',
    'IELTS Reading test',
    'IELTS Reading questions'
  ],

  writing: [
    'IELTS Writing practice',
    'IELTS Writing task 1',
    'IELTS Writing task 2'
  ],

  vocabulary: [
    'IELTS vocabulary',
    'IELTS vocabulary practice',
    'IELTS vocabulary preparation'
  ],

  tips: [
    'IELTS tips',
    'IELTS preparation tips',
    'IELTS strategies'
  ]
};

// ============================================================================
// FILTRES
// ============================================================================

const EXCLUDED_TERMS = [
  'shorts',
  'music video',
  'lyrics',
  'lyric',
  'karaoke',
  'remix',
  'trailer',
  'teaser',
  'livestream',
  'live stream',
  'reaction',
  'reacts',
  'song',
  'songs',
  'movie',
  'film',
  'podcast',
  'funny',
  'meme'
];

const IELTS_TERMS = [
  'ielts',
  'ielts academic',
  'ielts general training',
  'ielts preparation',
  'ielts test',
  'ielts practice',
  'ielts listening',
  'ielts speaking',
  'ielts reading',
  'ielts writing',
  'ielts exam',
  'ielts section'
];

// ============================================================================
// UTILITAIRES
// ============================================================================

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
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

function getVideoIdFromUrl(value) {
  if (!value) {
    return null;
  }

  const input = String(value).trim();

  if (
    /^[a-zA-Z0-9_-]{11}$/.test(input)
  ) {
    return input;
  }

  try {
    const url = new URL(input);

    if (
      url.hostname.includes('youtu.be')
    ) {
      return url.pathname
        .replace('/', '')
        .substring(0, 11);
    }

    if (
      url.hostname.includes('youtube.com') ||
      url.hostname.includes('m.youtube.com')
    ) {
      const id =
        url.searchParams.get('v');

      if (id) {
        return id.substring(0, 11);
      }
    }
  } catch (_) {
    return null;
  }

  return null;
}

// ============================================================================
// TIMESTAMP
// ============================================================================

function formatTimestamp(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return '00:00';
  }

  /*
   * Selon la réponse reçue, la valeur peut être en secondes
   * ou en millisecondes.
   */
  const seconds =
    number > 100000
      ? number / 1000
      : number;

  const totalSeconds =
    Math.max(
      0,
      Math.floor(seconds)
    );

  const hours =
    Math.floor(
      totalSeconds / 3600
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const secs =
    totalSeconds % 60;

  if (hours > 0) {
    return [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(secs).padStart(2, '0')
    ].join(':');
  }

  return [
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].join(':');
}

// ============================================================================
// YOUTUBE SEARCH
// ============================================================================

async function searchYouTube(query) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error(
      'YOUTUBE_API_KEY est manquante'
    );
  }

  const response = await axios.get(
    `${YOUTUBE_API_URL}/search`,
    {
      params: {
        part: 'snippet',

        q: query,

        key:
          process.env.YOUTUBE_API_KEY,

        type: 'video',

        maxResults: 50,

        /*
         * IMPORTANT :
         * Pour le Listening, on ne veut pas
         * exclure les vidéos courtes ou longues
         * avant de les analyser.
         */
        videoDuration: 'any',

        videoEmbeddable: 'true',

        videoSyndicated: 'true',

        relevanceLanguage: 'en',

        regionCode: 'US'
      },

      timeout: 30000
    }
  );

  return response.data.items || [];
}

// ============================================================================
// DÉTAILS VIDÉOS
// ============================================================================

async function getVideoDetails(videoIds) {
  if (
    !videoIds ||
    videoIds.length === 0
  ) {
    return [];
  }

  const uniqueIds = [
    ...new Set(videoIds)
  ];

  const response = await axios.get(
    `${YOUTUBE_API_URL}/videos`,
    {
      params: {
        part:
          'snippet,contentDetails,status,statistics',

        id:
          uniqueIds.join(','),

        key:
          process.env.YOUTUBE_API_KEY
      },

      timeout: 30000
    }
  );

  return response.data.items || [];
}

// ============================================================================
// DURÉE
// ============================================================================

function parseDuration(isoDuration) {
  if (!isoDuration) {
    return 0;
  }

  const match =
    isoDuration.match(
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

// ============================================================================
// FILTRAGE DES VIDÉOS
// ============================================================================

function processVideos(items, skill) {
  const processed = [];

  for (const video of items) {
    const snippet =
      video.snippet || {};

    const status =
      video.status || {};

    const statistics =
      video.statistics || {};

    const contentDetails =
      video.contentDetails || {};

    const videoId =
      video.id;

    if (!videoId) {
      continue;
    }

    const title =
      snippet.title || '';

    const description =
      snippet.description || '';

    const combinedText =
      `${title} ${description}`;

    const normalizedTitle =
      normalizeText(title);

    const normalizedDescription =
      normalizeText(description);

    // ================================================================
    // IELTS obligatoire
    // ================================================================

    if (
      !containsAny(
        combinedText,
        IELTS_TERMS
      )
    ) {
      console.log(
        `⏭️ ${videoId}: pas de terme IELTS`
      );

      continue;
    }

    // ================================================================
    // Exclusions
    // ================================================================

    if (
      containsAny(
        `${normalizedTitle} ${normalizedDescription}`,
        EXCLUDED_TERMS
      )
    ) {
      console.log(
        `⏭️ ${videoId}: terme exclu`
      );

      continue;
    }

    // ================================================================
    // Confidentialité
    // ================================================================

    if (
      status.privacyStatus &&
      status.privacyStatus !== 'public'
    ) {
      console.log(
        `⏭️ ${videoId}: vidéo non publique`
      );

      continue;
    }

    // ================================================================
    // Embeddable
    // ================================================================

    if (
      status.embeddable === false
    ) {
      console.log(
        `⏭️ ${videoId}: non embeddable`
      );

      continue;
    }

    // ================================================================
    // LANGUE
    // ================================================================

    const language =
      snippet.defaultLanguage ||
      snippet.defaultAudioLanguage ||
      '';

    /*
     * Pour IELTS Listening :
     *
     * on ne rejette PAS une vidéo simplement
     * parce que YouTube n'a pas renseigné
     * la langue.
     *
     * Si une langue est explicitement déclarée
     * et n'est pas anglaise, on la rejette.
     */

    if (
      language &&
      !language
        .toLowerCase()
        .startsWith('en')
    ) {
      console.log(
        `⏭️ ${videoId}: langue déclarée non anglaise (${language})`
      );

      continue;
    }

    // ================================================================
    // TITRE
    // ================================================================

    if (
      title.trim().length < 8
    ) {
      continue;
    }

    // ================================================================
    // DESCRIPTION
    // ================================================================

    /*
     * IMPORTANT :
     * Pour Listening, une description courte
     * ne doit PAS éliminer la vidéo.
     *
     * Une vidéo IELTS peut avoir une description
     * très courte tout en contenant réellement
     * les questions.
     */

    if (
      skill !== 'listening' &&
      description.trim().length < 20
    ) {
      continue;
    }

    // ================================================================
    // DURÉE
    // ================================================================

    const durationSeconds =
      parseDuration(
        contentDetails.duration
      );

    /*
     * Pour Listening :
     *
     * on accepte une plage beaucoup plus large.
     * La vraie validation se fera avec le transcript.
     *
     * Cela permet de ne pas perdre une vidéo
     * simplement parce que sa durée est différente.
     */

    if (
      skill !== 'listening'
    ) {
      if (
        durationSeconds < 120 ||
        durationSeconds > 3600
      ) {
        continue;
      }
    } else {
      /*
       * Sécurité minimale :
       * on élimine seulement les vidéos
       * totalement aberrantes.
       */
      if (
        durationSeconds > 0 &&
        durationSeconds > 7200
      ) {
        console.log(
          `⏭️ ${videoId}: vidéo de plus de 2 heures`
        );

        continue;
      }
    }

    // ================================================================
    // SCORE
    // ================================================================

    const views =
      Number(
        statistics.viewCount || 0
      );

    const likes =
      Number(
        statistics.likeCount || 0
      );

    let quality = 30;

    quality += Math.min(
      25,
      Math.log10(
        views + 1
      ) * 5
    );

    quality += Math.min(
      15,
      Math.log10(
        likes + 1
      ) * 5
    );

    if (
      normalizedTitle.includes(
        'listening'
      )
    ) {
      quality += 15;
    }

    if (
      normalizedTitle.includes(
        'test'
      )
    ) {
      quality += 10;
    }

    if (
      normalizedTitle.includes(
        'practice'
      )
    ) {
      quality += 5;
    }

    if (
      normalizedTitle.includes(
        'questions'
      )
    ) {
      quality += 10;
    }

    if (
      normalizedTitle.includes(
        'section'
      )
    ) {
      quality += 5;
    }

    processed.push({
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

      views,

      likes,

      quality:
        Math.round(quality),

      skill
    });
  }

  processed.sort(
    (a, b) =>
      b.quality - a.quality
  );

  return processed;
}

// ============================================================================
// TRANSCRIPT COMPLET + TIMESTAMPS
// ============================================================================

async function getTranscript(videoId) {
  try {
    if (
      !process.env.YOUTUBE_TRANSCRIPT_API_KEY
    ) {
      console.error(
        '❌ YOUTUBE_TRANSCRIPT_API_KEY est manquante'
      );

      return null;
    }

    console.log(
      `📝 Demande transcript: ${videoId}`
    );

    const response =
      await axios.post(
        TRANSCRIPT_API_URL,
        {
          video: videoId,

          language: 'en',

          source: 'auto',

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

    const result =
      response.data;

    if (!result) {
      console.log(
        `⚠️ Réponse transcript vide: ${videoId}`
      );

      return null;
    }

    if (
      result.status !== 'completed'
    ) {
      console.log(
        `⚠️ Transcript non terminé: ${videoId}`,
        result.status
      );

      return null;
    }

    const transcript =
      result.data?.transcript;

    if (!transcript) {
      console.log(
        `⚠️ Aucun transcript: ${videoId}`
      );

      return null;
    }

    const text =
      transcript.text || '';

    const rawSegments =
      Array.isArray(
        transcript.segments
      )
        ? transcript.segments
        : [];

    console.log(
      `📝 Transcript ${videoId}: ` +
      `${text.length} caractères`
    );

    console.log(
      `⏱️ ${rawSegments.length} segments reçus`
    );

    const segments =
      rawSegments
        .map(
          (segment, index) => {
            const start =
              Number(
                segment.start
              );

            const end =
              Number(
                segment.end
              );

            return {
              index,

              text:
                String(
                  segment.text || ''
                ).trim(),

              start:
                Number.isFinite(start)
                  ? start
                  : null,

              end:
                Number.isFinite(end)
                  ? end
                  : null,

              startFormatted:
                formatTimestamp(start),

              endFormatted:
                formatTimestamp(end)
            };
          }
        )
        .filter(
          segment =>
            segment.text.length > 0
        );

    if (
      segments.length > 0
    ) {
      console.log(
        '⏱️ Premier segment:',
        segments[0]
      );

      console.log(
        '⏱️ Dernier segment:',
        segments[
          segments.length - 1
        ]
      );
    } else {
      console.log(
        `⚠️ Aucun segment horodaté pour ${videoId}`
      );
    }

    return {
      videoId,

      text,

      segments,

      language:
        transcript.language ||
        'en',

      source:
        transcript.source ||
        'auto'
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
// MARQUEURS IELTS
// ============================================================================

function hasQuestionMarkers(
  transcriptText
) {
  const text =
    normalizeText(
      transcriptText
    );

  const markers = [
    /questions?\s+\d+/i,

    /questions?\s+\d+\s*[-–]\s*\d+/i,

    /questions?\s+\d+\s+to\s+\d+/i,

    /choose the correct answer/i,

    /choose the correct letter/i,

    /choose two answers/i,

    /choose two letters/i,

    /complete the form/i,

    /complete the notes/i,

    /complete the table/i,

    /complete the sentence/i,

    /complete the summary/i,

    /write one word/i,

    /write no more than one word/i,

    /write no more than two words/i,

    /write no more than three words/i,

    /match/i
  ];

  return markers.some(
    pattern =>
      pattern.test(text)
  );
}

// ============================================================================
// LOCALISATION DES SEGMENTS DE QUESTIONS
// ============================================================================

function findQuestionSegments(
  segments
) {
  if (
    !Array.isArray(segments) ||
    segments.length === 0
  ) {
    return [];
  }

  const markers = [
    /questions?\s+\d+/i,

    /questions?\s+\d+\s*[-–]\s*\d+/i,

    /questions?\s+\d+\s+to\s+\d+/i,

    /choose the correct answer/i,

    /choose the correct letter/i,

    /choose two answers/i,

    /choose two letters/i,

    /complete the form/i,

    /complete the notes/i,

    /complete the table/i,

    /complete the sentence/i,

    /complete the summary/i,

    /write one word/i,

    /write no more than one word/i,

    /write no more than two words/i,

    /write no more than three words/i,

    /match/i
  ];

  return segments.filter(
    segment => {
      const text =
        normalizeText(
          segment.text
        );

      return markers.some(
        pattern =>
          pattern.test(text)
      );
    }
  );
}

// ============================================================================
// EXTRACTION DES QUESTIONS AVEC CLAUDE
// ============================================================================

async function extractIeltsQuestions(
  video,
  transcript
) {
  if (
    !process.env.ANTHROPIC_API_KEY
  ) {
    throw new Error(
      'ANTHROPIC_API_KEY est manquante'
    );
  }

  const transcriptText =
    transcript.text || '';

  if (
    transcriptText
      .trim()
      .length < 100
  ) {
    return [];
  }

  const prompt = `
You are an IELTS Listening question extraction system.

Your task is EXTRACTION ONLY.

Do NOT generate new questions.

Do NOT invent questions.

Do NOT transform normal conversation into questions.

Use ONLY the transcript supplied below.

The goal is to identify IELTS Listening questions that are
actually present in the video transcript.

If the transcript does not contain identifiable IELTS Listening
questions, return an empty array.

Preserve the wording as closely as possible.

Do not invent answer choices.

If answer choices are explicitly present in the transcript,
extract them.

If answer choices are not present, return an empty choices array.

Return ONLY valid JSON.

Expected format:

{
  "questions": [
    {
      "number": 1,
      "question": "Question text",
      "choices": [
        {
          "label": "A",
          "text": "..."
        },
        {
          "label": "B",
          "text": "..."
        },
        {
          "label": "C",
          "text": "..."
        }
      ],
      "answer": null,
      "sourceText": "Exact relevant source text"
    }
  ]
}

IMPORTANT:

- Extraction only.
- No invention.
- No generated questions.
- No guessed answers.
- Keep original wording.
- If there are no real IELTS Listening questions, return:
  {"questions":[]}

VIDEO TITLE:
${video.title}

TRANSCRIPT:
${transcriptText}
`;

  const response =
    await axios.post(
      ANTHROPIC_URL,
      {
        model:
          ANTHROPIC_MODEL,

        max_tokens: 5000,

        system:
          'You extract existing IELTS Listening questions only. Never invent questions.',

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

          'content-type':
            'application/json'
        },

        timeout: 120000
      }
    );

  const content =
    response.data?.content
      ?.map(
        item =>
          item.text || ''
      )
      .join('')
      .trim() || '';

  if (!content) {
    return [];
  }

  let jsonText =
    content;

  if (
    jsonText.startsWith(
      '```'
    )
  ) {
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
  }

  let parsed;

  try {
    parsed =
      JSON.parse(
        jsonText
      );
  } catch (error) {
    console.error(
      '❌ JSON Claude invalide:',
      content
    );

    return [];
  }

  if (
    !parsed ||
    !Array.isArray(
      parsed.questions
    )
  ) {
    return [];
  }

  const questions =
    parsed.questions
      .filter(
        question => {
          if (!question) {
            return false;
          }

          if (
            !question.question ||
            String(
              question.question
            ).trim().length < 3
          ) {
            return false;
          }

          return true;
        }
      )
      .map(
        (question, index) => {
          const choices =
            Array.isArray(
              question.choices
            )
              ? question.choices
                  .filter(
                    choice =>
                      choice &&
                      choice.text
                  )
                  .map(
                    choice => ({
                      label:
                        choice.label ||
                        null,

                      text:
                        String(
                          choice.text
                        ).trim()
                    })
                  )
              : [];

          return {
            number:
              Number.isFinite(
                Number(
                  question.number
                )
              )
                ? Number(
                    question.number
                  )
                : index + 1,

            question:
              String(
                question.question
              ).trim(),

            choices,

            answer:
              question.answer ??
              null,

            sourceText:
              question.sourceText
                ? String(
                    question.sourceText
                  ).trim()
                : ''
          };
        }
      );

  return questions;
}

// ============================================================================
// ANALYSE D'UNE VIDÉO LISTENING
// ============================================================================

async function analyzeListeningVideo(
  video
) {
  console.log(
    `\n🎧 Analyse IELTS Listening: ${video.videoId}`
  );

  console.log(
    `📌 ${video.title}`
  );

  console.log(
    `⏱️ Durée: ${video.durationSeconds}s`
  );

  // --------------------------------------------------------------------------
  // 1. Transcript COMPLET
  // --------------------------------------------------------------------------

  const transcript =
    await getTranscript(
      video.videoId
    );

  if (!transcript) {
    console.log(
      `❌ ${video.videoId}: transcript indisponible`
    );

    return null;
  }

  if (
    !transcript.text ||
    transcript.text.length < 500
  ) {
    console.log(
      `❌ ${video.videoId}: transcript trop court`
    );

    return null;
  }

  // --------------------------------------------------------------------------
  // 2. Analyse de TOUT le transcript
  // --------------------------------------------------------------------------

  console.log(
    `🔎 Analyse complète du transcript...`
  );

  if (
    !hasQuestionMarkers(
      transcript.text
    )
  ) {
    console.log(
      `❌ ${video.videoId}: aucun marqueur IELTS Listening`
    );

    return null;
  }

  // --------------------------------------------------------------------------
  // 3. Localisation temporelle
  // --------------------------------------------------------------------------

  const questionSegments =
    findQuestionSegments(
      transcript.segments
    );

  console.log(
    `🔎 ${questionSegments.length} segment(s) potentiellement liés aux questions`
  );

  for (
    const segment of questionSegments.slice(
      0,
      50
    )
  ) {
    console.log(
      `   ⏱️ ${segment.startFormatted} → ${segment.endFormatted} | ${segment.text}`
    );
  }

  // --------------------------------------------------------------------------
  // 4. Extraction
  // --------------------------------------------------------------------------

  const questions =
    await extractIeltsQuestions(
      video,
      transcript
    );

  if (
    !questions ||
    questions.length === 0
  ) {
    console.log(
      `❌ ${video.videoId}: aucune question IELTS exploitable`
    );

    return null;
  }

  console.log(
    `✅ ${video.videoId}: ${questions.length} question(s) trouvée(s)`
  );

  // --------------------------------------------------------------------------
  // 5. VIDÉO VALIDÉE
  // --------------------------------------------------------------------------

  return {
    ...video,

    ieltsVerified:
      true,

    questionCount:
      questions.length,

    questions,

    transcript: {
      text:
        transcript.text,

      language:
        transcript.language,

      source:
        transcript.source,

      segments:
        transcript.segments,

      questionSegments
    }
  };
}

// ============================================================================
// GET /ielts
// ============================================================================

router.get(
  '/ielts',
  async (req, res) => {
    try {
      const skill =
        String(
          req.query.skill ||
          'all'
        ).toLowerCase();

      const validSkills =
        Object.keys(
          SKILL_QUERIES
        );

      if (
        !validSkills.includes(
          skill
        )
      ) {
        return res.status(400).json({
          ok: false,

          error:
            `Skill invalide. Valeurs: ${validSkills.join(', ')}`
        });
      }

      console.log(
        `\n🔎 Recherche IELTS: ${skill}`
      );

      const queries =
        SKILL_QUERIES[skill];

      // ----------------------------------------------------------------------
      // Recherche
      // ----------------------------------------------------------------------

      let searchResults = [];

      for (
        const query of queries
      ) {
        try {
          console.log(
            `🔍 YouTube: ${query}`
          );

          const results =
            await searchYouTube(
              query
            );

          searchResults.push(
            ...results
          );
        } catch (error) {
          console.error(
            `❌ Erreur recherche "${query}":`,
            error.response?.data ||
            error.message
          );
        }
      }

      // ----------------------------------------------------------------------
      // Déduplication
      // ----------------------------------------------------------------------

      const uniqueVideos =
        new Map();

      for (
        const item of searchResults
      ) {
        const videoId =
          item.id?.videoId;

        if (
          videoId &&
          !uniqueVideos.has(
            videoId
          )
        ) {
          uniqueVideos.set(
            videoId,
            videoId
          );
        }
      }

      const videoIds =
        [
          ...uniqueVideos.values()
        ];

      console.log(
        `📹 ${videoIds.length} vidéos candidates après recherche`
      );

      if (
        videoIds.length === 0
      ) {
        return res.json({
          ok: true,
          skill,
          count: 0,
          videos: []
        });
      }

      // ----------------------------------------------------------------------
      // Détails
      // ----------------------------------------------------------------------

      const details =
        await getVideoDetails(
          videoIds
        );

      // ----------------------------------------------------------------------
      // Filtrage
      // ----------------------------------------------------------------------

      const candidates =
        processVideos(
          details,
          skill
        );

      console.log(
        `📋 ${candidates.length} vidéos après filtrage`
      );

      // ----------------------------------------------------------------------
      // IELTS LISTENING
      // ----------------------------------------------------------------------

      if (
        skill === 'listening'
      ) {
        const acceptedVideos =
          [];

        /*
         * On analyse les candidates une par une.
         *
         * Une vidéo n'est conservée que si son contenu
         * permet réellement d'identifier des questions IELTS.
         */

        for (
          const video of candidates
        ) {
          if (
            acceptedVideos.length >= 20
          ) {
            break;
          }

          try {
            const analyzed =
              await analyzeListeningVideo(
                video
              );

            if (analyzed) {
              acceptedVideos.push(
                analyzed
              );

              console.log(
                `🎯 VIDÉO ACCEPTÉE: ${video.videoId}`
              );
            } else {
              console.log(
                `🚫 VIDÉO REJETÉE: ${video.videoId}`
              );
            }

          } catch (error) {
            console.error(
              `❌ Erreur analyse ${video.videoId}:`,
              error.response?.data ||
              error.message
            );
          }
        }

        console.log(
          `\n🎯 IELTS Listening validé: ${acceptedVideos.length} vidéo(s)`
        );

        return res.json({
          ok: true,

          skill,

          count:
            acceptedVideos.length,

          videos:
            acceptedVideos
        });
      }

      // ----------------------------------------------------------------------
      // AUTRES SKILLS
      // ----------------------------------------------------------------------

      return res.json({
        ok: true,

        skill,

        count:
          candidates.length,

        videos:
          candidates.slice(
            0,
            20
          )
      });

    } catch (error) {
      console.error(
        '❌ Erreur /ielts:',
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
// TEST DIRECT D'UNE VIDÉO
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
        `\n🧪 TEST DIRECT IELTS: ${videoId}`
      );

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

          error:
            'Vidéo YouTube introuvable'
        });
      }

      /*
       * IMPORTANT :
       *
       * On utilise maintenant le filtre assoupli
       * du mode listening.
       */
      const candidates =
        processVideos(
          details,
          'listening'
        );

      if (
        candidates.length === 0
      ) {
        return res.json({
          ok: false,

          videoId,

          error:
            'La vidéo ne passe toujours pas les filtres minimaux IELTS Listening'
        });
      }

      console.log(
        `✅ ${videoId} passe les filtres minimaux`
      );

      const result =
        await analyzeListeningVideo(
          candidates[0]
        );

      if (!result) {
        return res.json({
          ok: false,

          videoId,

          error:
            'La vidéo passe les filtres mais ne contient pas de questions IELTS Listening exploitables'
        });
      }

      return res.json({
        ok: true,

        video:
          result
      });

    } catch (error) {
      console.error(
        '❌ Erreur test IELTS:',
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
// EXPORT
// ============================================================================

module.exports = router;
