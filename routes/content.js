const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const TRANSCRIPT_API_KEY =
  process.env.YOUTUBE_TRANSCRIPT_API_KEY;

router.get('/content', async function (req, res) {
  try {
    const videoId =
      String(req.query.videoId || '').trim();

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
    // 1. Verify video
    // ------------------------------------------------------------

    const youtubeResponse = await axios.get(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          part: 'snippet,contentDetails,status',
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

    // ------------------------------------------------------------
    // 2. Request transcript service
    // ------------------------------------------------------------

    console.log(
      'Requesting external transcript for ' +
      videoId
    );

    const transcriptResponse = await axios.post(
      'https://www.youtubetranscript.dev/api/v2/transcribe',
      {
        video: videoId,
        language: 'fr',
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

    const data = transcriptResponse.data;

    console.log(
      'Transcript API response received'
    );

    // ------------------------------------------------------------
    // 3. Return raw service response for diagnosis
    // ------------------------------------------------------------

    return res.json({
      ok: true,
      videoId: videoId,

      video: {
        title: snippet.title || '',
        channelTitle:
          snippet.channelTitle || '',
        defaultLanguage:
          snippet.defaultLanguage || null,
        defaultAudioLanguage:
          snippet.defaultAudioLanguage || null
      },

      availability: {
        captionAvailable:
          contentDetails.caption === 'true',
        embeddable:
          status.embeddable === true,
        public:
          status.privacyStatus === 'public'
      },

      transcriptService: {
        ok: true,
        response: data
      }
    });

  } catch (error) {
    console.error(
      'Transcript service error:',
      error.message
    );

    if (error.response) {
      console.error(
        'HTTP status:',
        error.response.status
      );

      console.error(
        'Response:',
        JSON.stringify(
          error.response.data
        )
      );
    }

    return res.status(500).json({
      ok: false,
      error: 'Transcript service request failed',
      httpStatus:
        error.response
          ? error.response.status
          : null,
      details:
        error.response &&
        error.response.data
          ? error.response.data
          : error.message
    });
  }
});

module.exports = router;
