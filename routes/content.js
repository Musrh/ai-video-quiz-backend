const express = require('express');
const axios = require('axios');
const { fetchTranscript } = require('youtube-transcript');

const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

function cleanTranscript(items) {
  if (!Array.isArray(items)) {
    return '';
  }

  return items
    .map(function (item) {
      return item && item.text ? String(item.text).trim() : '';
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

router.get('/content', async function (req, res) {
  try {
    const videoId = String(req.query.videoId || '').trim();

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

    console.log('Content request for video: ' + videoId);

    // ------------------------------------------------------------
    // 1. Verify video with YouTube Data API
    // ------------------------------------------------------------

    const response = await axios.get(
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
      response.data.items &&
      response.data.items[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        videoId: videoId,
        error: 'Video not found or not accessible'
      });
    }

    const snippet = item.snippet || {};
    const contentDetails =
      item.contentDetails || {};
    const status = item.status || {};

    const captionAvailable =
      contentDetails.caption === 'true';

    // ------------------------------------------------------------
    // 2. Try to retrieve transcript
    // ------------------------------------------------------------

    console.log(
      'Trying transcript extraction for: ' +
      videoId
    );

    let transcriptItems = [];
    let transcriptText = '';
    let transcriptError = null;

    try {
      transcriptItems = await fetchTranscript(videoId);

      transcriptText =
        cleanTranscript(transcriptItems);

      console.log(
        'Transcript segments: ' +
        transcriptItems.length
      );

      console.log(
        'Transcript characters: ' +
        transcriptText.length
      );

    } catch (error) {
      transcriptError =
        error && error.message
          ? error.message
          : String(error);

      console.error(
        'Transcript extraction failed: ' +
        transcriptError
      );
    }

    // ------------------------------------------------------------
    // 3. Validate transcript
    // ------------------------------------------------------------

    const transcriptRetrieved =
      transcriptText.length >= 200;

    if (!transcriptRetrieved) {
      return res.status(422).json({
        ok: false,
        videoId: videoId,

        video: {
          title: snippet.title || '',
          description: snippet.description || '',
          channelTitle:
            snippet.channelTitle || '',
          publishedAt:
            snippet.publishedAt || null
        },

        language: {
          defaultLanguage:
            snippet.defaultLanguage || null,
          defaultAudioLanguage:
            snippet.defaultAudioLanguage || null
        },

        availability: {
          captionAvailable:
            captionAvailable,
          embeddable:
            status.embeddable === true,
          public:
            status.privacyStatus === 'public',
          privacyStatus:
            status.privacyStatus || null
        },

        textAccess: {
          transcriptRetrieved: false,
          transcriptCharacters:
            transcriptText.length,
          transcriptSegments:
            Array.isArray(transcriptItems)
              ? transcriptItems.length
              : 0,
          transcript: null,
          error: transcriptError,
          message:
            'No usable transcript was retrieved.'
        }
      });
    }

    // ------------------------------------------------------------
    // 4. Return transcript
    // ------------------------------------------------------------

    return res.json({
      ok: true,
      videoId: videoId,

      video: {
        title: snippet.title || '',
        description: snippet.description || '',
        channelTitle:
          snippet.channelTitle || '',
        publishedAt:
          snippet.publishedAt || null
      },

      language: {
        defaultLanguage:
          snippet.defaultLanguage || null,
        defaultAudioLanguage:
          snippet.defaultAudioLanguage || null
      },

      availability: {
        captionAvailable:
          captionAvailable,
        embeddable:
          status.embeddable === true,
        public:
          status.privacyStatus === 'public',
        privacyStatus:
          status.privacyStatus || null
      },

      textAccess: {
        transcriptRetrieved: true,
        transcriptCharacters:
          transcriptText.length,
        transcriptSegments:
          transcriptItems.length,
        transcript: transcriptText,
        error: null
      }
    });

  } catch (error) {
    console.error(
      'Content route error:',
      error.message
    );

    return res.status(500).json({
      ok: false,
      error: 'Content extraction failed',
      details: error.message
    });
  }
});

module.exports = router;
