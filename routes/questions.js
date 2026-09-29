const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY;

const TRANSCRIPT_API_KEY =
  process.env.YOUTUBE_TRANSCRIPT_API_KEY;

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY;

const TRANSCRIPT_API_URL =
  'https://www.youtubetranscript.dev/api/v2/transcribe';

const ANTHROPIC_API_URL =
  'https://api.anthropic.com/v1/messages';

const CLAUDE_MODEL =
  'claude-sonnet-5';

const MIN_TRANSCRIPT_LENGTH = 500;

const SUPPORTED_LANGUAGES = [
  'fr',
  'en',
  'ar'
];


// ============================================================
// Language name
// ============================================================

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

  return 'French';
}


// ============================================================
// Extract JSON from Claude response
// ============================================================

function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error(
      'Claude returned an empty response'
    );
  }

  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
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
      return JSON.parse(objectText);
    } catch (error) {
    }
  }

  const firstArray =
    cleaned.indexOf('[');

  const lastArray =
    cleaned.lastIndexOf(']');

  if (
    firstArray !== -1 &&
    lastArray > firstArray
  ) {
    const arrayText =
      cleaned.substring(
        firstArray,
        lastArray + 1
      );

    try {
      return JSON.parse(arrayText);
    } catch (error) {
    }
  }

  throw new Error(
    'Unable to parse Claude JSON response'
  );
}


// ============================================================
// Validate questions
// ============================================================

function validateQuestions(data) {
  if (!data) {
    throw new Error(
      'Claude returned no question data'
    );
  }

  const questions =
    Array.isArray(data)
      ? data
      : data.questions;

  if (!Array.isArray(questions)) {
    throw new Error(
      'Claude response does not contain a questions array'
    );
  }

  if (questions.length !== 4) {
    throw new Error(
      'Claude must return exactly 4 questions'
    );
  }

  const validated = [];

  for (
    let i = 0;
    i < questions.length;
    i++
  ) {
    const item = questions[i];

    if (
      !item ||
      typeof item !== 'object'
    ) {
      throw new Error(
        'Invalid question at index ' + i
      );
    }

    const question =
      typeof item.question === 'string'
        ? item.question.trim()
        : '';

    if (!question) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' has no question text'
      );
    }

    if (!Array.isArray(item.choices)) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' must contain choices'
      );
    }

    if (item.choices.length !== 4) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' must have exactly 4 choices'
      );
    }

    const choices =
      item.choices.map(
        function (choice) {
          return String(choice).trim();
        }
      );

    if (
      choices.some(
        function (choice) {
          return !choice;
        }
      )
    ) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' contains an empty choice'
      );
    }

    const correctAnswer =
      Number(item.correctAnswer);

    if (
      !Number.isInteger(
        correctAnswer
      ) ||
      correctAnswer < 0 ||
      correctAnswer > 3
    ) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' has an invalid correctAnswer'
      );
    }

    const normalizedChoices =
      choices.map(
        function (choice) {
          return choice.toLowerCase();
        }
      );

    const uniqueChoices =
      new Set(
        normalizedChoices
      );

    if (
      uniqueChoices.size !== 4
    ) {
      throw new Error(
        'Question ' +
        (i + 1) +
        ' contains duplicate choices'
      );
    }

    validated.push({
      question: question,
      choices: choices,
      correctAnswer:
        correctAnswer
    });
  }

  return validated;
}


// ============================================================
// Main question generation function
// ============================================================

async function generateQuestions(
  req,
  res
) {
  try {
    const body =
      req.body || {};

    const videoId =
      String(
        body.videoId ||
        req.query.videoId ||
        ''
      ).trim();

    const requestedLanguage =
      String(
        body.language ||
        req.query.language ||
        'fr'
      )
        .trim()
        .toLowerCase();

    // --------------------------------------------------------
    // Validate input
    // --------------------------------------------------------

    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error:
          'videoId is required'
      });
    }

    if (
      !SUPPORTED_LANGUAGES.includes(
        requestedLanguage
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Unsupported language. Use fr, en or ar.'
      });
    }

    // --------------------------------------------------------
    // Validate environment
    // --------------------------------------------------------

    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error:
          'YOUTUBE_API_KEY is missing'
      });
    }

    if (!TRANSCRIPT_API_KEY) {
      return res.status(500).json({
        ok: false,
        error:
          'YOUTUBE_TRANSCRIPT_API_KEY is missing'
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({
        ok: false,
        error:
          'ANTHROPIC_API_KEY is missing'
      });
    }

    console.log(
      'Generating quiz for video ' +
      videoId +
      ' language=' +
      requestedLanguage
    );

    // --------------------------------------------------------
    // 1. Get YouTube information
    // --------------------------------------------------------

    const youtubeResponse =
      await axios.get(
        'https://www.googleapis.com/youtube/v3/videos',
        {
          params: {
            part:
              'snippet,contentDetails,status,statistics',

            id:
              videoId,

            key:
              YOUTUBE_API_KEY
          },

          timeout: 15000
        }
      );

    const item =
      youtubeResponse.data.items &&
      youtubeResponse.data.items[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        videoId:
          videoId,
        error:
          'Video not found'
      });
    }

    const snippet =
      item.snippet || {};

    const contentDetails =
      item.contentDetails || {};

    const status =
      item.status || {};

    const statistics =
      item.statistics || {};

    const isPublic =
      status.privacyStatus ===
      'public';

    const isEmbeddable =
      status.embeddable === true;

    if (!isPublic) {
      return res.status(400).json({
        ok: false,
        videoId:
          videoId,
        error:
          'Video is not public'
      });
    }

    if (!isEmbeddable) {
      return res.status(400).json({
        ok: false,
        videoId:
          videoId,
        error:
          'Video is not embeddable'
      });
    }

    // --------------------------------------------------------
    // 2. Get transcript
    // --------------------------------------------------------

    console.log(
      'Requesting transcript for ' +
      videoId +
      ' language=' +
      requestedLanguage
    );

    const transcriptResponse =
      await axios.post(
        TRANSCRIPT_API_URL,
        {
          video:
            videoId,

          language:
            requestedLanguage,

          source:
            'auto'
        },
        {
          headers: {
            Authorization:
              'Bearer ' +
              TRANSCRIPT_API_KEY,

            'Content-Type':
              'application/json'
          },

          timeout: 30000
        }
      );

    const transcriptData =
      transcriptResponse.data ||
      {};

    if (
      transcriptData.status !==
      'completed'
    ) {
      return res.status(422).json({
        ok: false,
        videoId:
          videoId,
        error:
          'Transcript was not completed',

        transcriptStatus:
          transcriptData.status ||
          null
      });
    }

    const transcriptObject =
      transcriptData.data &&
      transcriptData.data.transcript
        ? transcriptData.data.transcript
        : null;

    const transcriptText =
      transcriptObject &&
      typeof transcriptObject.text ===
        'string'
        ? transcriptObject.text.trim()
        : '';

    const transcriptLanguage =
      transcriptObject &&
      transcriptObject.language
        ? transcriptObject.language
        : null;

    if (!transcriptText) {
      return res.status(422).json({
        ok: false,
        videoId:
          videoId,
        error:
          'No transcript text returned'
      });
    }

    if (
      transcriptText.length <
      MIN_TRANSCRIPT_LENGTH
    ) {
      return res.status(422).json({
        ok: false,
        videoId:
          videoId,

        error:
          'Transcript is too short',

        transcriptCharacters:
          transcriptText.length,

        minimumCharacters:
          MIN_TRANSCRIPT_LENGTH
      });
    }

    console.log(
      'Transcript received: ' +
      transcriptText.length +
      ' characters'
    );

    // --------------------------------------------------------
    // 3. Claude prompt
    // --------------------------------------------------------

    const languageName =
      getLanguageName(
        requestedLanguage
      );

    const systemPrompt =
      'You are an expert educational quiz generator. ' +
      'Create a quiz strictly from the supplied video transcript. ' +
      'Do not use outside knowledge. ' +
      'Do not invent facts. ' +
      'Every question must be answerable directly from the transcript. ' +
      'Create exactly 4 questions. ' +
      'Each question must have exactly 4 different answer choices. ' +
      'There must be exactly one correct answer. ' +
      'The quiz language must be ' +
      languageName +
      '. ' +
      'Return ONLY valid JSON. ' +
      'Do not use markdown. ' +
      'Do not add explanations outside the JSON.';

    const userPrompt =
      'Generate exactly 4 multiple-choice questions ' +
      'from the following YouTube video transcript.\n\n' +

      'VIDEO TITLE:\n' +
      (snippet.title || '') +
      '\n\n' +

      'TRANSCRIPT:\n' +
      '<transcript>\n' +
      transcriptText +
      '\n</transcript>\n\n' +

      'Return exactly this JSON structure:\n' +

      '{\n' +
      '  "questions": [\n' +
      '    {\n' +
      '      "question": "Question text",\n' +
      '      "choices": [\n' +
      '        "Answer A",\n' +
      '        "Answer B",\n' +
      '        "Answer C",\n' +
      '        "Answer D"\n' +
      '      ],\n' +
      '      "correctAnswer": 0\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +

      'Important rules:\n' +
      '- Exactly 4 questions.\n' +
      '- Exactly 4 choices per question.\n' +
      '- correctAnswer must be 0, 1, 2 or 3.\n' +
      '- Only one choice can be correct.\n' +
      '- Questions should cover different parts or ideas of the transcript.\n' +
      '- Avoid duplicate questions.\n' +
      '- Avoid questions whose answer can be guessed from the wording.\n' +
      '- Do not use information that is not present in the transcript.\n' +
      '- Write everything in ' +
      languageName +
      '.';

    // --------------------------------------------------------
    // 4. Call Claude
    // --------------------------------------------------------

    console.log(
      'Calling Anthropic ' +
      CLAUDE_MODEL
    );

    const claudeResponse =
      await axios.post(
        ANTHROPIC_API_URL,
        {
          model:
            CLAUDE_MODEL,

          max_tokens:
            2500,

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
              ANTHROPIC_API_KEY,

            'anthropic-version':
              '2023-06-01',

            'content-type':
              'application/json'
          },

          timeout: 120000
        }
      );

    // --------------------------------------------------------
    // 5. Extract Claude text
    // --------------------------------------------------------

    const claudeData =
      claudeResponse.data ||
      {};

    const content =
      Array.isArray(
        claudeData.content
      )
        ? claudeData.content
        : [];

    const textBlocks =
      content.filter(
        function (block) {
          return (
            block &&
            block.type === 'text' &&
            typeof block.text ===
              'string'
          );
        }
      );

    const claudeText =
      textBlocks
        .map(
          function (block) {
            return block.text;
          }
        )
        .join('\n')
        .trim();

    if (!claudeText) {
      return res.status(502).json({
        ok: false,
        videoId:
          videoId,
        error:
          'Claude returned no text'
      });
    }

    console.log(
      'Claude response received'
    );

    // --------------------------------------------------------
    // 6. Parse JSON
    // --------------------------------------------------------

    let parsed;

    try {
      parsed =
        extractJson(
          claudeText
        );
    } catch (parseError) {
      console.error(
        'Claude JSON parsing error:',
        parseError.message
      );

      return res.status(502).json({
        ok: false,

        videoId:
          videoId,

        error:
          'Claude returned invalid JSON',

        details:
          parseError.message
      });
    }

    // --------------------------------------------------------
    // 7. Validate questions
    // --------------------------------------------------------

    let questions;

    try {
      questions =
        validateQuestions(
          parsed
        );
    } catch (validationError) {
      console.error(
        'Question validation error:',
        validationError.message
      );

      return res.status(502).json({
        ok: false,

        videoId:
          videoId,

        error:
          'Generated questions are invalid',

        details:
          validationError.message
      });
    }

    // --------------------------------------------------------
    // 8. Final response
    // --------------------------------------------------------

    console.log(
      'Quiz generated successfully for ' +
      videoId
    );

    return res.json({
      ok: true,

      videoId:
        videoId,

      language:
        requestedLanguage,

      transcript: {
        language:
          transcriptLanguage,

        characters:
          transcriptText.length
      },

      video: {
        title:
          snippet.title || '',

        channelTitle:
          snippet.channelTitle || '',

        publishedAt:
          snippet.publishedAt ||
          null,

        duration:
          contentDetails.duration ||
          null,

        viewCount:
          statistics.viewCount
            ? Number(
                statistics.viewCount
              )
            : 0
      },

      questions:
        questions
    });

  } catch (error) {
    console.error(
      'Questions route error:',
      error.message
    );

    if (error.response) {
      console.error(
        'HTTP status:',
        error.response.status
      );

      console.error(
        'API response:',
        JSON.stringify(
          error.response.data
        )
      );

      return res.status(
        error.response.status >= 400 &&
        error.response.status < 600
          ? error.response.status
          : 500
      ).json({
        ok: false,

        error:
          'Question generation request failed',

        httpStatus:
          error.response.status,

        details:
          error.response.data ||
          null
      });
    }

    return res.status(500).json({
      ok: false,

      error:
        'Unable to generate questions',

      details:
        error.message
    });
  }
}


// ============================================================
// GET
// Browser test
// ============================================================

router.get(
  '/questions',
  generateQuestions
);


// ============================================================
// POST
// Frontend / API
// ============================================================

router.post(
  '/questions',
  generateQuestions
);


module.exports = router;
