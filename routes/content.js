const express = require('express');
const axios = require('axios');

const {
  YouTubeTranscriptApi,
  RequestBlocked,
  TranscriptsDisabled,
  NoTranscriptFound
} = require('@hallelx/youtube-transcript');

const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const transcriptApi = new YouTubeTranscriptApi();

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

    console.log('Content request: ' + videoId);

    // ------------------------------------------------------------
    // 1. Verify the video with YouTube Data API
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
    // 2. Retrieve transcript
    // ------------------------------------------------------------

    console.log(
      'Trying @hallelx/youtube-transcript...'
    );

    let transcript = null;
    let transcriptError = null;
    let errorType = null;

    try {
      transcript = await transcriptApi.fetch(
        videoId,
        {
          languages: ['fr', 'en', 'ar']
        }
      );

      console.log(
        'Transcript language: ' +
        transcript.languageCode
      );

      console.log(
        'Transcript generated: ' +
        transcript.isGenerated
      );

      console.log(
        'Transcript snippets: ' +
        transcript.snippets.length
      );

    } catch (error) {
      transcriptError =
        error && error.message
          ? error.message
          : String(error);

      errorType =
        error && error.constructor
          ? error.constructor.name
          : 'UnknownError';

      console.error(
        'Transcript error: ' +
        transcriptError
      );

      console.error(
        'Transcript error type: ' +
        errorType
      );
    }

    // ------------------------------------------------------------
    // 3. Convert transcript to plain text
    // ------------------------------------------------------------

    let transcriptText = '';

    if (transcript) {
      transcriptText = transcript.snippets
        .map(function (snippet) {
          return snippet &&
            snippet.text
            ? String(snippet.text).trim()
            : '';
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const transcriptCharacters =
      transcriptText.length;

    const transcriptSegments =
      transcript
        ? transcript.snippets.length
        : 0;

    const transcriptRetrieved =
      transcriptCharacters >= 200;

    // ------------------------------------------------------------
    // 4. Handle failure
    // ------------------------------------------------------------

    if (!transcriptRetrieved) {
      let message =
        'No usable transcript was retrieved.';

      if (errorType === 'RequestBlocked') {
        message =
          'YouTube blocked the transcript request from the Railway server IP.';
      }

      if (errorType === 'TranscriptsDisabled') {
        message =
          'Transcripts are disabled for this video.';
      }

      if (errorType === 'NoTranscriptFound') {
        message =
          'No transcript was found in the requested languages.';
      }

      return res.status(422).json({
        ok: false,
        videoId: videoId,

        video: {
          title: snippet.title || '',
          description:
            snippet.description || '',
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
            transcriptCharacters,
          transcriptSegments:
            transcriptSegments,
          transcriptLanguage:
            transcript
              ? transcript.languageCode
              : null,
          transcriptGenerated:
            transcript
              ? transcript.isGenerated
              : null,
          transcript: null,
          error: transcriptError,
          errorType: errorType,
          message: message
        }
      });
    }

    // ------------------------------------------------------------
    // 5. Success
    // ------------------------------------------------------------

    return res.json({
      ok: true,
      videoId: videoId,

      video: {
        title: snippet.title || '',
        description:
          snippet.description || '',
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
          transcriptCharacters,
        transcriptSegments:
          transcriptSegments,
        transcriptLanguage:
          transcript.languageCode,
        transcriptGenerated:
          transcript.isGenerated,
        transcript: transcriptText,
        error: null,
        errorType: null,
        message:
          'Transcript successfully retrieved.'
      }
    });

  } catch (error) {
    console.error(
      'Content route fatal error:',
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
