const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const TRANSCRIPT_API_KEY =
  process.env.YOUTUBE_TRANSCRIPT_API_KEY;

const TRANSCRIPT_API_URL =
  'https://www.youtubetranscript.dev/api/v2/transcribe';

const MIN_TRANSCRIPT_LENGTH = 500;

router.get('/content', async function (req, res) {
  try {
    const videoId =
      String(req.query.videoId || '').trim();

    const requestedLanguage =
      String(req.query.language || 'fr')
        .trim()
        .toLowerCase();

    // ------------------------------------------------------------
    // 1. Validation
    // ------------------------------------------------------------

    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error: 'videoId is required'
      });
    }

    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'YOUTUBE_API_KEY is missing'
      });
    }

    if (!TRANSCRIPT_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'YOUTUBE_TRANSCRIPT_API_KEY is missing'
      });
    }

    // ------------------------------------------------------------
    // 2. Get YouTube video information
    // ------------------------------------------------------------

    const youtubeResponse = await axios.get(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          part: 'snippet,contentDetails,status,statistics',
          id: videoId,
          key: YOUTUBE_API_KEY
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
        videoId: videoId,
        error: 'Video not found'
      });
    }

    const snippet = item.snippet || {};
    const contentDetails =
      item.contentDetails || {};
    const status = item.status || {};
    const statistics = item.statistics || {};

    // ------------------------------------------------------------
    // 3. Basic availability checks
    // ------------------------------------------------------------

    const isPublic =
      status.privacyStatus === 'public';

    const isEmbeddable =
      status.embeddable === true;

    const captionAvailable =
      contentDetails.caption === 'true';

    if (!isPublic) {
      return res.status(400).json({
        ok: false,
        videoId: videoId,
        error: 'Video is not public'
      });
    }

    if (!isEmbeddable) {
      return res.status(400).json({
        ok: false,
        videoId: videoId,
        error: 'Video is not embeddable'
      });
    }

    // ------------------------------------------------------------
    // 4. Request transcript
    // ------------------------------------------------------------

    console.log(
      'Requesting transcript for video ' +
      videoId +
      ' language=' +
      requestedLanguage
    );

    const transcriptResponse = await axios.post(
      TRANSCRIPT_API_URL,
      {
        video: videoId,
        language: requestedLanguage,
        source: 'auto'
      },
      {
        headers: {
          Authorization:
            'Bearer ' + TRANSCRIPT_API_KEY,
          'Content-Type':
            'application/json'
        },
        timeout: 30000
      }
    );

    const transcriptData =
      transcriptResponse.data || {};

    // ------------------------------------------------------------
    // 5. Check service status
    // ------------------------------------------------------------

    if (
      transcriptData.status !== 'completed'
    ) {
      return res.status(422).json({
        ok: false,
        videoId: videoId,
        error: 'Transcript was not completed',
        transcriptStatus:
          transcriptData.status || null
      });
    }

    // ------------------------------------------------------------
    // 6. Extract transcript
    // ------------------------------------------------------------

    const transcriptObject =
      transcriptData.data &&
      transcriptData.data.transcript
        ? transcriptData.data.transcript
        : null;

    const transcriptText =
      transcriptObject &&
      typeof transcriptObject.text === 'string'
        ? transcriptObject.text.trim()
        : '';

    const transcriptLanguage =
      transcriptObject &&
      transcriptObject.language
        ? transcriptObject.language
        : null;

    const transcriptSource =
      transcriptObject &&
      transcriptObject.source
        ? transcriptObject.source
        : null;

    // ------------------------------------------------------------
    // 7. Validate transcript
    // ------------------------------------------------------------

    if (!transcriptText) {
      return res.status(422).json({
        ok: false,
        videoId: videoId,
        error: 'No transcript text returned',
        captionAvailable: captionAvailable
      });
    }

    if (
      transcriptText.length <
      MIN_TRANSCRIPT_LENGTH
    ) {
      return res.status(422).json({
        ok: false,
        videoId: videoId,
        error: 'Transcript is too short',
        transcriptCharacters:
          transcriptText.length,
        minimumCharacters:
          MIN_TRANSCRIPT_LENGTH
      });
    }

    // ------------------------------------------------------------
    // 8. Prepare clean result
    // ------------------------------------------------------------

    const result = {
      ok: true,

      videoId: videoId,

      video: {
        title:
          snippet.title || '',
        description:
          snippet.description || '',
        channelTitle:
          snippet.channelTitle || '',
        publishedAt:
          snippet.publishedAt || null,

        defaultLanguage:
          snippet.defaultLanguage || null,

        defaultAudioLanguage:
          snippet.defaultAudioLanguage || null,

        categoryId:
          snippet.categoryId || null,

        duration:
          contentDetails.duration || null,

        viewCount:
          statistics.viewCount
            ? Number(statistics.viewCount)
            : 0
      },

      availability: {
        public: isPublic,
        embeddable: isEmbeddable,
        captionAvailable:
          captionAvailable
      },

      transcript: {
        retrieved: true,

        language:
          transcriptLanguage,

        source:
          transcriptSource,

        characters:
          transcriptText.length,

        text:
          transcriptText
      }
    };

    console.log(
      'Transcript retrieved successfully: ' +
      videoId +
      ' (' +
      transcriptText.length +
      ' characters)'
    );

    return res.json(result);

  } catch (error) {
    console.error(
      'Content route error:',
      error.message
    );

    // ------------------------------------------------------------
    // External API error
    // ------------------------------------------------------------

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
          'Transcript service request failed',

        httpStatus:
          error.response.status,

        details:
          error.response.data || null
      });
    }

    // ------------------------------------------------------------
    // Network / timeout error
    // ------------------------------------------------------------

    return res.status(500).json({
      ok: false,

      error:
        'Unable to contact transcript service',

      details:
        error.message
    });
  }
});

module.exports = router;
