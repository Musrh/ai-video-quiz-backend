const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

router.get('/content', async (req, res) => {
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

    console.log('Content diagnostic for video: ' + videoId);

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

    const item = response.data.items && response.data.items[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        videoId: videoId,
        error: 'Video not found or not accessible'
      });
    }

    const snippet = item.snippet || {};
    const contentDetails = item.contentDetails || {};
    const status = item.status || {};

    const title = snippet.title || '';
    const description = snippet.description || '';
    const defaultLanguage = snippet.defaultLanguage || null;
    const defaultAudioLanguage =
      snippet.defaultAudioLanguage || null;

    const captionAvailable =
      contentDetails.caption === 'true';

    const embeddable =
      status.embeddable === true;

    const publicStatus =
      status.privacyStatus === 'public';

    return res.json({
      ok: true,
      videoId: videoId,

      video: {
        title: title,
        description: description,
        channelTitle: snippet.channelTitle || '',
        publishedAt: snippet.publishedAt || null
      },

      language: {
        defaultLanguage: defaultLanguage,
        defaultAudioLanguage: defaultAudioLanguage
      },

      availability: {
        captionAvailable: captionAvailable,
        embeddable: embeddable,
        public: publicStatus,
        privacyStatus: status.privacyStatus || null
      },

      textAccess: {
        transcriptRetrieved: false,
        transcript: null,
        message: captionAvailable
          ? 'Captions are reported as available, but their text has not been retrieved.'
          : 'No captions are reported for this video.'
      }
    });

  } catch (error) {
    console.error('Content diagnostic error:', error.message);

    if (error.response) {
      console.error(
        'YouTube API response:',
        JSON.stringify(error.response.data)
      );
    }

    return res.status(500).json({
      ok: false,
      error: 'YouTube API request failed',
      details:
        error.response &&
        error.response.data &&
        error.response.data.error
          ? error.response.data.error.message
          : error.message
    });
  }
});

module.exports = router;
