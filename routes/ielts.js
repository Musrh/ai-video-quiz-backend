const express = require('express');
const axios = require('axios');

const router = express.Router();

const YOUTUBE_API_URL =
  'https://www.googleapis.com/youtube/v3';

const MAX_RESULTS = 20;

const SKILL_QUERIES = {
  all: [
    'IELTS preparation',
    'IELTS Academic preparation',
    'IELTS English'
  ],
  listening: [
    'IELTS listening practice',
    'IELTS listening test',
    'IELTS listening preparation'
  ],
  speaking: [
    'IELTS speaking practice',
    'IELTS speaking test',
    'IELTS speaking preparation'
  ],
  reading: [
    'IELTS reading practice',
    'IELTS reading test',
    'IELTS reading preparation'
  ],
  writing: [
    'IELTS writing task 1',
    'IELTS writing task 2',
    'IELTS writing preparation'
  ],
  vocabulary: [
    'IELTS vocabulary',
    'IELTS grammar',
    'IELTS vocabulary grammar'
  ],
  tips: [
    'IELTS tips strategies',
    'IELTS exam tips',
    'IELTS preparation tips'
  ]
};

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
  'ielts listening',
  'ielts speaking',
  'ielts reading',
  'ielts writing',
  'ielts vocabulary',
  'ielts grammar',
  'ielts exam'
];

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

function parseDuration(isoDuration) {
  const match = String(isoDuration || '').match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );

  if (!match) {
    return 0;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds || 0);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

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

function normalizeLanguage(value) {
  return normalizeText(value).split('-')[0];
}

function isEnglishVideo(item) {
  const details = item.snippet || {};

  const defaultLanguage = normalizeLanguage(
    details.defaultLanguage
  );

  const defaultAudioLanguage = normalizeLanguage(
    details.defaultAudioLanguage
  );

  const englishLanguages = [
    'en',
    'eng',
    'english'
  ];

  if (
    defaultLanguage &&
    !englishLanguages.includes(defaultLanguage)
  ) {
    return false;
  }

  if (
    defaultAudioLanguage &&
    !englishLanguages.includes(defaultAudioLanguage)
  ) {
    return false;
  }

  return true;
}

function calculateQuality(item, durationSeconds) {
  const snippet = item.snippet || {};
  const details = item.contentDetails || {};
  const statistics = item.statistics || {};

  const title = normalizeText(snippet.title);
  const description = normalizeText(snippet.description);

  let score = 0;

  if (title.includes('ielts')) {
    score += 35;
  }

  if (
    title.includes('ielts listening') ||
    title.includes('ielts speaking') ||
    title.includes('ielts reading') ||
    title.includes('ielts writing')
  ) {
    score += 15;
  }

  if (description.includes('ielts')) {
    score += 20;
  }

  if (description.length >= 100) {
    score += 10;
  }

  if (durationSeconds >= 300) {
    score += 10;
  }

  if (durationSeconds >= 600) {
    score += 5;
  }

  if (details.caption === 'true') {
    score += 5;
  }

  if (Number(statistics.viewCount || 0) >= 10000) {
    score += 5;
  }

  return Math.min(score, 100);
}

async function youtubeRequest(endpoint, params) {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error(
      'YOUTUBE_API_KEY is missing'
    );
  }

  const response = await axios.get(
    YOUTUBE_API_URL + endpoint,
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

async function searchYouTube(query) {
  return youtubeRequest('/search', {
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: 50,
    videoDuration: 'medium',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    relevanceLanguage: 'en',
    regionCode: 'US'
  });
}

async function getVideoDetails(videoIds) {
  if (!videoIds.length) {
    return {
      items: []
    };
  }

  return youtubeRequest('/videos', {
    part: 'snippet,contentDetails,status,statistics',
    id: videoIds.join(',')
  });
}

function processVideos(items, skill) {
  const results = [];
  const seen = new Set();

  for (const item of items) {
    const videoId = item.id;

    if (!videoId) {
      continue;
    }

    if (seen.has(videoId)) {
      continue;
    }

    seen.add(videoId);

    const snippet = item.snippet || {};
    const contentDetails = item.contentDetails || {};
    const status = item.status || {};
    const statistics = item.statistics || {};

    const title = String(snippet.title || '');
    const description = String(snippet.description || '');

    const combinedText =
      title + ' ' + description;

    if (!hasIeltsTerm(combinedText)) {
      continue;
    }

    if (containsExcludedTerm(combinedText)) {
      continue;
    }

    if (
      status.privacyStatus &&
      status.privacyStatus !== 'public'
    ) {
      continue;
    }

    if (
      status.uploadStatus &&
      status.uploadStatus !== 'processed'
    ) {
      continue;
    }

    if (status.embeddable === false) {
      continue;
    }

    if (!isEnglishVideo(item)) {
      continue;
    }

    if (title.length < 8) {
      continue;
    }

    if (description.length < 20) {
      continue;
    }

    const durationSeconds =
      parseDuration(contentDetails.duration);

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

    if (quality < 30) {
      continue;
    }

    const thumbnail =
      snippet.thumbnails &&
      (
        snippet.thumbnails.high ||
        snippet.thumbnails.medium ||
        snippet.thumbnails.default
      );

    results.push({
      videoId: videoId,
      title: title,
      description: description,
      channelTitle: snippet.channelTitle || '',
      channelId: snippet.channelId || '',
      publishedAt: snippet.publishedAt || null,

      defaultLanguage:
        snippet.defaultLanguage || null,

      defaultAudioLanguage:
        snippet.defaultAudioLanguage || null,

      duration: contentDetails.duration || null,

      durationSeconds: durationSeconds,

      durationFormatted:
        formatDuration(durationSeconds),

      captionAvailable:
        contentDetails.caption === 'true',

      embeddable:
        status.embeddable !== false,

      privacyStatus:
        status.privacyStatus || 'public',

      uploadStatus:
        status.uploadStatus || 'processed',

      viewCount:
        Number(statistics.viewCount || 0),

      thumbnail:
        thumbnail ? thumbnail.url : null,

      quality: quality,

      skill: skill
    });
  }

  results.sort(function(a, b) {
    return b.quality - a.quality;
  });

  return results.slice(0, MAX_RESULTS);
}

router.get('/ielts', async function(req, res) {
  try {
    const requestedSkill =
      normalizeText(req.query.skill || 'all');

    const allowedSkills = Object.keys(
      SKILL_QUERIES
    );

    const skill =
      allowedSkills.includes(requestedSkill)
        ? requestedSkill
        : 'all';

    const queries =
      SKILL_QUERIES[skill];

    let allItems = [];

    for (const query of queries) {
      try {
        const searchResult =
          await searchYouTube(query);

        if (
          searchResult &&
          Array.isArray(searchResult.items)
        ) {
          allItems =
            allItems.concat(
              searchResult.items
            );
        }
      } catch (searchError) {
        console.error(
          'IELTS YouTube search error:',
          searchError.message
        );
      }
    }

    const ids = [];

    for (const item of allItems) {
      if (
        item &&
        item.id &&
        item.id.videoId &&
        !ids.includes(item.id.videoId)
      ) {
        ids.push(item.id.videoId);
      }
    }

    if (!ids.length) {
      return res.json({
        ok: true,
        version: 'v1',
        language: 'en',
        languageName: 'English',
        section: 'ielts',
        skill: skill,
        searched: 0,
        accepted: 0,
        returned: 0,
        videos: []
      });
    }

    const chunks = [];

    for (
      let i = 0;
      i < ids.length;
      i += 50
    ) {
      chunks.push(
        ids.slice(i, i + 50)
      );
    }

    let detailedItems = [];

    for (const chunk of chunks) {
      const details =
        await getVideoDetails(chunk);

      if (
        details &&
        Array.isArray(details.items)
      ) {
        detailedItems =
          detailedItems.concat(
            details.items
          );
      }
    }

    const videos =
      processVideos(
        detailedItems,
        skill
      );

    return res.json({
      ok: true,
      version: 'v1',
      language: 'en',
      languageName: 'English',
      section: 'ielts',
      skill: skill,
      searched: detailedItems.length,
      accepted: videos.length,
      returned: videos.length,
      videos: videos
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
      error: 'IELTS video search failed',
      message: error.message
    });
  }
});

module.exports = router;
