import axios from 'axios';
import mitt from 'mitt';
import UAParser from 'ua-parser-js';

/* eslint-disable no-param-reassign */

const waitMs = time => new Promise(resolve => {
  setTimeout(resolve, time);
});

const handleRequestError = (result, {
  onError,
  retryTimes = 0
}) => result.catch(error => onError(error, {
  retry: () => handleRequestError(axios(error.config), {
    onError,
    retryTimes: retryTimes + 1
  }),
  retryTimes
}));

const ignoreMinorError = async (event, {
  retry,
  retryTimes
} = {}) => {
  var _event$response, _event$response2, _event$config;

  console.warn(event);

  if ((((_event$response = event.response) === null || _event$response === void 0 ? void 0 : _event$response.message) === 'Network Error' || /502|503/.test((_event$response2 = event.response) === null || _event$response2 === void 0 ? void 0 : _event$response2.status)) && retryTimes < 3) {
    await waitMs(3000);
    return retry();
  }

  if (/start$|info$|heartbeat$/.test((_event$config = event.config) === null || _event$config === void 0 ? void 0 : _event$config.url)) {
    return Promise.reject(event);
  }

  console.log('Ignore non-critical playback API fail', event);
  return new Promise(() => {});
};

const createApi = ({
  host,
  accessToken,
  deviceId,
  headers,
  params
}, {
  onError = ignoreMinorError
} = {}) => {
  const getHeaders = () => ({ ...(accessToken && {
      Authorization: accessToken
    }),
    ...(deviceId && {
      'X-Device-ID': deviceId
    }),
    'Content-type': 'application/json',
    ...headers
  });

  const request = (url, {
    method
  } = {}) => handleRequestError(axios(url, {
    method,
    headers: getHeaders(),
    params
  }), {
    onError
  }).then(response => response.data);

  const sessionRequest = (path, {
    method = 'POST',
    type,
    id,
    token
  }) => handleRequestError(axios(`${host}/sessions/${type}/${id}/playback/${deviceId}/${path}`, {
    method,
    headers: getHeaders(),
    params: { ...params,
      playback_token: token
    }
  }), {
    onError
  }).then(response => response.data);

  return {
    getContent: ({
      type,
      id
    }) => request(`${host}/${type}/${id}`, {}),
    startPlayback: ({
      type,
      id
    }) => request(`${host}/sessions/${type}/${id}/playback/${deviceId}/start`, {
      method: 'POST'
    }),
    getPlaybackInfo: ({
      type,
      id,
      token
    }) => sessionRequest('info', {
      method: 'GET',
      type,
      id,
      token
    }),
    heartbeat: ({
      type,
      id,
      token
    }) => sessionRequest('heartbeat', {
      type,
      id,
      token
    }),
    updateLastPlayed: ({
      type,
      id,
      token,
      time
    }) => sessionRequest(`position/${Math.floor(time)}`, {
      type,
      id,
      token
    }),
    endPlayback: ({
      type,
      id,
      token
    }) => sessionRequest('end', {
      type,
      id,
      token
    })
  };
};

const getStreamInfo = (sources = [], type = '') => {
  const activeSource = sources.find(source => source.type === type) || sources[0];
  return ((activeSource === null || activeSource === void 0 ? void 0 : activeSource.manifests) || []).reduce((data, manifest) => {
    const {
      url,
      ...info
    } = manifest;
    data.source[manifest.protocol] = url; // SSAI plugins need manifest.ssai, and for other extra data

    data.source.info[manifest.protocol] = info;
    data.quality[manifest.protocol] = info.resolutions.map(({
      height
    }) => ({
      label: height,
      value: height,
      options: {
        maxHeight: height
      }
    }));
    return data;
  }, {
    source: {
      info: {}
    },
    quality: {},
    thumbnailsUrl: activeSource === null || activeSource === void 0 ? void 0 : activeSource.thumbnail_seeking_url
  });
};

const getContentInfo = data => {
  var _data$time, _data$time2;

  return {
    title: data.title,
    channelTitle: data.subtitle,
    end: data.end,
    section: {
      id: data.section_id,
      start: data.start_time,
      end: data.end_time
    },
    previous: data.prev_video,
    next: data.next_video,
    startTime: (_data$time = data.time) === null || _data$time === void 0 ? void 0 : _data$time.last_position,
    chapters: [((_data$time2 = data.time) === null || _data$time2 === void 0 ? void 0 : _data$time2.end_start_position) && {
      type: 'ending',
      start: data.time.end_start_position
    }].filter(Boolean)
  };
};

const deepEqual = (current, updated) => JSON.stringify(current) === JSON.stringify(updated);

const HEARTBEAT_INTERVAL_MS = 10000;
const UPDATE_INTERVAL_MS = 10000;

const startPlaybackSession = async (playbackApi, options = {}) => {
  var _options$cache, _options$cache$get, _options$cache2, _options$cache2$get;

  const emitter = mitt();
  const {
    type,
    id,
    getCurrentTime
  } = options;
  const {
    onChangeContent,
    onChangeStream,
    onInvalidToken,
    heartbeatTime = HEARTBEAT_INTERVAL_MS,
    updateTime = UPDATE_INTERVAL_MS
  } = options;
  const state = {};

  const updateContent = async contentInCache => {
    const content = !contentInCache || contentInCache.end_time * 1000 <= Date.now() ? await playbackApi.getContent({
      type,
      id
    }) : contentInCache;

    if (!deepEqual(content, state.content)) {
      state.content = content;
      onChangeContent === null || onChangeContent === void 0 ? void 0 : onChangeContent({
        type,
        ...content,
        sources: state.sources
      });
    }
  }; // get last playback time to start playback fast
  // getContent is not critical, so don't block playback if it hangs or fails(ignored in API logic)


  const loadContent = Promise.race([updateContent((_options$cache = options.cache) === null || _options$cache === void 0 ? void 0 : (_options$cache$get = _options$cache.get(`${type}/${id}`)) === null || _options$cache$get === void 0 ? void 0 : _options$cache$get.content), new Promise(resolve => {
    setTimeout(resolve, UPDATE_INTERVAL_MS);
  })]);
  const sessionInfo = await playbackApi.startPlayback({
    type,
    id
  });
  const requestParams = {
    type,
    id,
    token: sessionInfo.token
  };
  state.sources = (((_options$cache2 = options.cache) === null || _options$cache2 === void 0 ? void 0 : (_options$cache2$get = _options$cache2.get(`${type}/${id}`)) === null || _options$cache2$get === void 0 ? void 0 : _options$cache2$get.playbackInfo) || (await playbackApi.getPlaybackInfo(requestParams))).sources;
  onChangeStream === null || onChangeStream === void 0 ? void 0 : onChangeStream({
    type,
    ...state
  });
  let updateIntervalId;

  if (type === 'lives') {
    updateIntervalId = setInterval(updateContent, updateTime);
  }

  let lastPlayedTime;

  const updateLastPlayed = () => {
    const currentTime = getCurrentTime === null || getCurrentTime === void 0 ? void 0 : getCurrentTime();

    if (currentTime >= 0 && lastPlayedTime !== currentTime) {
      lastPlayedTime = currentTime;
      playbackApi.updateLastPlayed({ ...requestParams,
        time: currentTime
      });
    }
  };

  if (type === 'videos') {
    updateIntervalId = setInterval(updateLastPlayed, updateTime);
  }

  const heartbeatIntervalId = setInterval(() => playbackApi.heartbeat(requestParams).catch(error => {
    var _error$response;

    if (/4\d\d/.test((_error$response = error.response) === null || _error$response === void 0 ? void 0 : _error$response.status)) {
      clearInterval(heartbeatIntervalId);
      onInvalidToken === null || onInvalidToken === void 0 ? void 0 : onInvalidToken(error);
    }
  }), heartbeatTime);

  const end = () => {
    updateLastPlayed();
    clearInterval(updateIntervalId);
    clearInterval(heartbeatIntervalId);
    emitter.emit('playbackEnded');
    return playbackApi.endPlayback(requestParams);
  };

  await loadContent;
  return { ...state,
    token: sessionInfo.token,
    drmPortalUrl: sessionInfo.drm_portal_url,
    updateLastPlayed,
    end
  };
};

const on = (target, name, handler) => {
  target.addEventListener(name, handler);
  return () => target.removeEventListener(name, handler);
};

const once = (target, name, handler) => {
  const oneTime = (...args) => {
    handler(...args);
    target.removeEventListener(name, oneTime);
  };

  target.addEventListener(name, oneTime);
  return () => target.removeEventListener(name, oneTime);
};

/* eslint-disable no-bitwise */
const uuidv4 = () => {
  const crypto = window.crypto || window.msCrypto;
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
};

const modes = {
  videos: 'video',
  lives: 'live'
};
const logEventNames = {
  playbackBegan: 'video_playback_began',
  playbackStarted: 'video_playback_started',
  playbackStopped: 'video_playback_stopped',
  playbackEnded: 'video_playback_ended',
  bufferingStarted: 'video_buffering_started',
  bufferingEnded: 'video_buffering_ended',
  seeked: 'video_seeking_ended',
  playbackError: 'video_playback_error_occurred',
  playing: 'play',
  paused: 'pause',
  rewind: 'rewind',
  forward: 'forward',
  previousEpisode: 'previous_episode',
  nextEpisode: 'next_episode',
  openSettings: 'setting_page_entered',
  closeSettings: 'setting_page_exited',
  adPlaybackStarted: 'ad_playback_started',
  adPlaybackStopped: 'ad_playback_stopped'
};

const mapLogEvents = ({
  video,
  session = video,
  version,
  playerName,
  getPlaybackStatus = () => video
}) => {
  var _session$getContent;

  const emitter = mitt();
  const state = {
    status: 'init',
    seeking: false,
    playerStartTime: Date.now(),
    moduleStartTime: Date.now(),
    content: ((_session$getContent = session.getContent) === null || _session$getContent === void 0 ? void 0 : _session$getContent.call(session)) || {}
  };

  const commonPropties = () => {
    var _state$content$sectio;

    return {
      player_name: playerName,
      playback_module_version: version,
      playback_mode: modes[state.content.type],
      playback_session_id: state.sessionId,
      id: state.content.id,
      name: state.content.title,
      ...(state.content.type === 'videos' && {
        current_position: state.currentTime,
        video_total_duration: state.duration
      }),
      ...(state.content.type === 'lives' && {
        section_id: (_state$content$sectio = state.content.section) === null || _state$content$sectio === void 0 ? void 0 : _state$content$sectio.id,
        name_2: state.content.channelName
      }),
      SSAI: state.ssaiProvider || 'None'
    };
  };

  const dispatchStart = () => {
    if (state.status === 'started') {
      return;
    }

    state.status = 'started';
    state.lastStartTime = Date.now();
    const eventName = state.isPlayingAd ? 'adPlaybackStarted' : 'playbackStarted';
    emitter.emit(eventName, commonPropties());
  };

  const dispatchStop = () => {
    if (state.status !== 'started') {
      return;
    }

    state.status = 'stopped';
    const played = (Date.now() - state.lastStartTime) / 1000;

    if (state.isPlayingAd) {
      state.adPlayedDuration += played;
    } else {
      state.playedDuration += played;
    }

    const eventName = state.isPlayingAd ? 'adPlaybackStopped' : 'playbackStopped';
    emitter.emit(eventName, { ...commonPropties(),
      ...(state.isPlayingAd && {
        ad_played_duration: played
      })
    });
  };

  const registered = [on(video, 'error', event => {
    var _event$error, _event$error2, _event$error2$data;

    emitter.emit('playbackError', {
      module_error_code: ((_event$error = event.error) === null || _event$error === void 0 ? void 0 : _event$error.code) || ((_event$error2 = event.error) === null || _event$error2 === void 0 ? void 0 : (_event$error2$data = _event$error2.data) === null || _event$error2$data === void 0 ? void 0 : _event$error2$data.code),
      ...commonPropties()
    });
  }), once(video, 'playerStarted', () => {
    state.playerStartTime = Date.now();
  }), on(video, 'durationchange', () => {
    // duration may change when playing an ad stitched stream, take only initial value
    if (!state.duration) {
      state.duration = getPlaybackStatus().duration;
    }
  }), once(video, 'canplay', () => {
    state.status = 'began';
    state.sessionId = uuidv4();
    state.playedDuration = 0;
    emitter.emit('playbackBegan', {
      player_startup_time: (state.playerStartTime - state.moduleStartTime) / 1000,
      video_startup_time: (Date.now() - state.moduleStartTime) / 1000,
      ...commonPropties()
    });
  }), on(video, 'playing', dispatchStart), on(video, 'waiting', () => {
    if (!state.bufferingStartTime) {
      emitter.emit('bufferingStarted', commonPropties());
      state.bufferingStartTime = Date.now();
    }
  }), on(video, 'timeupdate', () => {
    state.currentTime = getPlaybackStatus().currentTime;

    if (state.bufferingStartTime) {
      emitter.emit('bufferingEnded', {
        buffering_second: (Date.now() - state.bufferingStartTime) / 1000,
        ...commonPropties()
      });
      state.bufferingStartTime = undefined;
    }
  }), on(video, 'pause', dispatchStop), on(video, 'seeking', () => {
    state.seekingFrom = state.currentTime;
  }), on(session, 'userSeeking', () => {
    state.seeking = true;
  }), on(video, 'seeked', () => {
    if (state.seeking) {
      emitter.emit('seeked', {
        seeking_from: state.seekingFrom,
        seeking_to: video.currentTime,
        ...commonPropties()
      });
    }

    state.seeking = false;
  }), on(session, 'sectionChange', () => {
    dispatchStop();
    state.content = session.getContent();
    dispatchStart();
  }), once(video, 'emptied', () => {
    if (state.status === 'started') {
      dispatchStop();
    }

    state.status = 'init';
    emitter.emit('playbackEnded', {
      video_playback_ended_at_percentage: state.currentTime / state.duration,
      video_total_played_duration: state.playedDuration,
      ...(state.ssaiProvider && {
        ad_total_played_duration: state.adPlayedDuration
      }),
      ...commonPropties()
    });
  }), once(video, 'loadedAdMetadata', event => {
    state.ssaiProvider = event.data.provider;
    state.adPlayedDuration = 0;
  }), on(session, 'adBreakStarted', () => {
    dispatchStop();
    state.isPlayingAd = true;

    if (!state.seeking) {
      dispatchStart();
    }
  }), on(session, 'adBreakEnded', () => {
    dispatchStop();
    state.isPlayingAd = false;

    if (!state.seeking) {
      dispatchStart();
    }
  })];
  return {
    addEventListener: (name, handler) => emitter.on(name, handler),
    all: handler => emitter.on('*', handler),
    emit: (name, {
      currentTime
    }) => {
      emitter.emit(name, {
        current_position: currentTime,
        ...commonPropties()
      });
    },
    updateContent: content => {
      state.content = content;
    },
    reset: () => registered.forEach(off => off())
  };
};

/* eslint-disable no-plusplus */
new UAParser();
function needNativeHls() {
  // Don't let Android phones play HLS, even if some of them report supported
  // This covers Samsung & OPPO special cases
  const isAndroid = /android/i.test(navigator.userAgent); // canPlayType isn't reliable across all iOS verion / device combinations, so also check user agent

  const isSafari = /^((?!chrome|android).)*(safari|iPad|iPhone)/i.test(navigator.userAgent); // ref: https://stackoverflow.com/a/12905122/4578017
  // none of our supported browsers other than Safari response to this

  const canPlayHls = document.createElement('video').canPlayType('application/vnd.apple.mpegURL');
  return isAndroid || /firefox/i.test(navigator.userAgent) ? '' : isSafari ? 'maybe' : canPlayHls;
}

const matchAll = (input, pattern) => {
  const flags = [pattern.global && 'g', pattern.ignoreCase && 'i', pattern.multiline && 'm'].filter(Boolean).join('');
  const clone = new RegExp(pattern, flags);
  return Array.from(function* () {
    let matched = true;

    while (1) {
      matched = clone.exec(input);

      if (!matched) {
        return;
      }

      yield matched;
    }
  }());
};

const rewriteUrls = (manifest, sourceUrl) => manifest.replace(/((#EXT-X-MEDIA:.*URI=")([^"]*))|((#EXT-X-STREAM-INF.*\n)(.*)(?=\n))/g, (...matches) => [matches[2], matches[5], new URL(matches[3] || matches[6], sourceUrl)].filter(Boolean).join(''));

const filterHlsManifestQualities = (manifest, filter) => {
  if (!filter) {
    return;
  }

  const profiles = matchAll(manifest, /RESOLUTION=(\d+)x(\d+)/g).map(([, width, height]) => ({
    width: +width,
    height: +height
  }));
  const allowed = filter(profiles) || profiles;
  const newManifest = manifest.replace(/#EXT-X-STREAM-INF.*RESOLUTION=(\d+)x(\d+).*\n.*\n/g, (item, width, height) => allowed.some(p => p.width === +width && p.height === +height) ? item : '');
  return newManifest !== manifest && newManifest;
};

const meetRestriction = (quality, {
  minHeight,
  maxHeight
} = {}) => !(quality.height < minHeight || quality.height > maxHeight);

const selectHlsQualities = async (source, restrictions) => {
  if (!needNativeHls() || !(source !== null && source !== void 0 && source.hls)) {
    return source;
  }

  const filtered = filterHlsManifestQualities((await axios.get(source.hls)).data, items => items.filter(item => meetRestriction(item, restrictions)));

  if (filtered) {
    const newManifest = new Blob([rewriteUrls(filtered, source.hls)], {
      type: 'application/x-mpegURL'
    });
    return { ...source,
      hls: URL.createObjectURL(newManifest)
    };
  }

  return source;
};
 // for unit test

export { createApi, getContentInfo, getStreamInfo, logEventNames, mapLogEvents, selectHlsQualities, startPlaybackSession as startSession };
