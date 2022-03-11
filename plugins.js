import mitt from 'mitt'
import axios from 'axios'

/** @param {string} m3u8Manifest */
const getManifestUrl = ({url, data}) => {
  const lines = data.split('\n')
  const i = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'))
  return i >= 0 ? new URL(lines[i + 1], url) : ''
}
/** @param {string} url */

const fetchManifests = async url => {
  if (!url.toString().split('?')[0].endsWith('.m3u8')) {
    return fetch(url)
  }

  const data = await fetch(url).then(result => result.text())
  const innerUrl = getManifestUrl({
    url,
    data,
  })
  return innerUrl && fetchManifests(innerUrl)
}

/* eslint-disable class-methods-use-this */

/* eslint-disable no-underscore-dangle */
const _IsNumber = value => typeof value === 'number' && value >= 0

const AD_TIME_EVENT_TYPE = [
  'impression',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
]

const doNothing = () => {}

const getSkipTimeOffset = ad => {
  var _ad$skipOffset, _ad$skipOffset$match, _ad$skipOffset2

  if (!ad.skipOffset) {
    return
  }

  const percentageOffset =
    (((_ad$skipOffset = ad.skipOffset) === null || _ad$skipOffset === void 0
      ? void 0
      : (_ad$skipOffset$match = _ad$skipOffset.match(/\d+/)) === null ||
        _ad$skipOffset$match === void 0
      ? void 0
      : _ad$skipOffset$match[0]) || 0) / 100 // 00:01:07 -> 67

  const timeOffset = (
    ((_ad$skipOffset2 = ad.skipOffset) === null || _ad$skipOffset2 === void 0
      ? void 0
      : _ad$skipOffset2.match(/(\d+):(\d+):(\d+)/)) || []
  )
    .slice(1, 4)
    .reduce((last, time) => last * 60 + +time, 0)
  return timeOffset + ad.durationInSeconds * percentageOffset
}

const inRange = ({startTimeInSeconds, durationInSeconds}, time) =>
  startTimeInSeconds <= time && time <= startTimeInSeconds + durationInSeconds

const getCurrentAd = (adBreak, streamTime) =>
  ((adBreak === null || adBreak === void 0 ? void 0 : adBreak.ads) || []).find(
    ad => inRange(ad, streamTime)
  ) || {}

const adEventData = (instance, ad) => {
  const streamTime = instance._common.currentPosition
  const currentAd = getCurrentAd(ad, streamTime)
  return {
    getAd: () => ({
      getSkipTimeOffset: () => getSkipTimeOffset(currentAd),
    }),
    getStreamData: () => {
      var _currentAd$trackingEv, _currentAd$trackingEv2

      const adItems = [].concat(
        ...instance.waitingForPlayAds.map(avail => avail.ads)
      )
      const adPosition =
        1 + adItems.findIndex(item => inRange(item, streamTime))
      const adProgressData = {
        adPosition,
        totalAds: adItems.length,
        currentTime: streamTime - currentAd.startTimeInSeconds,
        duration: currentAd.durationInSeconds,
        clickThroughUrl:
          (_currentAd$trackingEv = currentAd.trackingEvents) === null ||
          _currentAd$trackingEv === void 0
            ? void 0
            : (_currentAd$trackingEv2 = _currentAd$trackingEv.find(
                event => event.eventType === 'clickThrough'
              )) === null || _currentAd$trackingEv2 === void 0
            ? void 0
            : _currentAd$trackingEv2.beaconUrls[0],
      }
      return {
        adProgressData,
      }
    },
  }
}

class Impression {
  constructor({
    seek,
    onAdBreakStarted = doNothing,
    onAdProgress = doNothing,
    onAdBreakEnded = doNothing,
    onSkippableStateChanged = doNothing,
  } = {}) {
    this._common = {
      adBreaks: [],
      currentPosition: -1,
      seek,
      onAdBreakStarted,
      onAdProgress,
      onSkippableStateChanged,
      onAdBreakEnded,
    }
    this.currentAd = null
    this.waitingForPlayAds = []
    this.waitingForPlayAdIndex = null
    this.resumeUserSeekTime = null
    this.resumeAdStartTime = null
    this.isResumed = null
    this.checkAdEventProcess = null
  }
  /**
   * @description
   * @param {object[]} value
   */

  set adBreaks(value) {
    this._common.adBreaks = value
    if (_IsNumber(value.length)) this.checkAdCueTone()
  }
  /**
   * @description when position is updated, check if ad is started or ended
   * @param {number} value current position in seconds
   */

  set currentPosition(value) {
    this._common.currentPosition = value
    if (_IsNumber(this._common.adBreaks.length)) this.checkAdCueTone()
  } // TODO: send ad status (current ad index, count, total duration)

  getAdIndex(target) {
    if (!target) return null
    return this._common.adBreaks.findIndex(ad => ad.availId === target.availId)
  } // 取得播放時間是在哪個廣告區間

  getActiveAdIndex(time) {
    var _adBreaks$index

    const {adBreaks = []} = this._common
    const index = adBreaks.findIndex(ad => {
      const {startTime, endTime} = this.getAdTimingInfo(ad)
      return time >= startTime && time <= endTime
    })
    const position = (
      ((_adBreaks$index = adBreaks[index]) === null ||
      _adBreaks$index === void 0
        ? void 0
        : _adBreaks$index.ads) || []
    ).findIndex(ad => inRange(ad, time))
    return {
      index,
      position,
    }
  } // 檢查播放時間是否在所提供的區間

  isWithinTimeRange(target, startTime, endTime) {
    return target >= startTime && target <= endTime
  } // 取得該廣告的起始/結束時間

  getAdTimingInfo(adInfo = {}) {
    const adStartTime = adInfo.startTimeInSeconds || 0
    const adDuration = adInfo.durationInSeconds || 0
    return {
      startTime: adStartTime,
      endTime: adStartTime + adDuration,
    }
  } // 取得跳過的廣告

  getSkippedAds(time) {
    return this._common.adBreaks.filter(
      ad =>
        this._common.currentPosition <= ad.startTimeInSeconds &&
        ad.startTimeInSeconds <= time &&
        !ad.isFired
    )
  }

  setAdIsFiredByIndex() {}

  checkAdCueTone() {
    const {adBreaks, currentPosition, seek} = this._common
    const {index: activeAdIndex, position} =
      this.getActiveAdIndex(currentPosition)

    if (this.currentAd) {
      if (!this.checkAdEventProcess) {
        this.checkAdEventProcess = this.checkAdEvent()
      }

      this.checkAdEventProcess({
        index: activeAdIndex,
        position,
      })
    }

    if (this.waitingForPlayAds.length > 0) {
      const {startTime: currentAdStartTime, endTime: currentAdEndTime} =
        this.getAdTimingInfo(this.currentAd)
      const isAdStillPlaying = this.isWithinTimeRange(
        currentPosition,
        currentAdStartTime,
        currentAdEndTime
      )

      if (!isAdStillPlaying) {
        // Ad finished
        const nextAd =
          this.waitingForPlayAds[`${this.waitingForPlayAdIndex + 1}`]
        if (
          currentPosition <
          this.currentAd.startTimeInSeconds + this.currentAd.durationInSeconds
        )
          return

        if (nextAd) {
          // have non-played & skipped Ad
          const adIndex = this.getAdIndex(this.currentAd)
          const {startTime: nextAdStartTime} = this.getAdTimingInfo(nextAd)
          this.setAdIsFiredByIndex(adIndex)
          this.updateWaitingForPlayIndex(this.waitingForPlayAdIndex + 1)
          this.updateCurrentAd(nextAd)
          seek === null || seek === void 0 ? void 0 : seek(nextAdStartTime)
        } else {
          // don't have non-played Ad
          const adIndex = this.getAdIndex(this.currentAd)
          this.setAdIsFiredByIndex(adIndex)
          this.updateWaitingForPlayAds([])
          this.updateWaitingForPlayIndex(null)
          this.updateCurrentAd(null)
          _IsNumber(this.resumeUserSeekTime) &&
            (seek === null || seek === void 0
              ? void 0
              : seek(this.resumeUserSeekTime))
          this.resumeUserSeekTime = null
        }
      }
    } else if (activeAdIndex !== -1) {
      if (!adBreaks[activeAdIndex].isFired) {
        this.updateWaitingForPlayIndex(0)
        this.updateWaitingForPlayAds(
          adBreaks.slice(activeAdIndex, activeAdIndex + 1)
        )
        this.updateCurrentAd(adBreaks[activeAdIndex])
      } else {
        // in Ad duration but Ad was played
        this.updateCurrentAd(adBreaks[`${activeAdIndex}`] || {})
      }
    } else {
      // not in Ad duration
      this.updateCurrentAd(null)
    }
  }

  checkAdEvent() {
    const state = {
      lastPosition: undefined,
      isSkippableEventFired: false,
    }
    return ({index, position}) => {
      var _currentAd$trackingEv3, _currentAd$trackingEv4

      const streamTime = this._common.currentPosition
      const currentBreak = this._common.adBreaks[index]
      const currentAd =
        currentBreak === null || currentBreak === void 0
          ? void 0
          : currentBreak.ads[position]

      if (!currentAd) {
        return
      }

      if (position !== state.lastPosition) {
        var _this$_common$onAdPro, _this$_common

        ;(_this$_common$onAdPro = (_this$_common = this._common)
          .onAdProgress) === null || _this$_common$onAdPro === void 0
          ? void 0
          : _this$_common$onAdPro.call(
              _this$_common,
              adEventData(this, currentBreak)
            )
        Object.assign(state, {
          lastPosition: position,
          isSkippableEventFired: false,
          trackingTypes: AD_TIME_EVENT_TYPE.slice(),
        })
      }

      if (
        !state.isSkippableEventFired &&
        streamTime >=
          currentAd.startTimeInSeconds + getSkipTimeOffset(currentAd)
      ) {
        state.isSkippableEventFired = true

        this._common.onSkippableStateChanged({
          getAd: () => ({
            isSkippable: () => true,
          }),
        })
      }

      if (
        !_IsNumber(streamTime) ||
        ((_currentAd$trackingEv3 = currentAd.trackingEvents) === null ||
        _currentAd$trackingEv3 === void 0
          ? void 0
          : _currentAd$trackingEv3.length) <= 0
      )
        return
      ;(_currentAd$trackingEv4 = currentAd.trackingEvents) === null ||
      _currentAd$trackingEv4 === void 0
        ? void 0
        : _currentAd$trackingEv4.forEach(e => {
            const {
              eventType = '',
              beaconUrls = [],
              startTimeInSeconds = 0,
              isFired,
            } = e
            const adEventIndex = state.trackingTypes.findIndex(
              type => type === eventType
            )

            if (
              !isFired &&
              beaconUrls.length > 0 &&
              streamTime >= startTimeInSeconds &&
              adEventIndex !== -1
            ) {
              beaconUrls.forEach(url => {
                fetch(url)
              })
              state.trackingTypes.splice(adEventIndex, 1)
            }
          })
    }
  }
  /**
   * @description To snapback if seeking over some ads
   * @param {number} to
   */

  onSeek(to) {
    const {adBreaks} = this._common
    const skippedAds = this.getSkippedAds(to)
    const seekTargetAdIndex = this.getActiveAdIndex(to)
    if (!adBreaks || adBreaks.length <= 0) return

    if (this.currentAd);
    else if (skippedAds.length > 0) {
      this.updateWaitingForPlayAds(skippedAds)
      this.updateWaitingForPlayIndex(0)
      this.resumeUserSeekTime = seekTargetAdIndex === -1 ? to : null
    } else if (
      seekTargetAdIndex !== -1 &&
      !_IsNumber(this.resumeAdStartTime) &&
      !this.isResumed
    ) {
      const {startTime} = this.getAdTimingInfo(adBreaks[seekTargetAdIndex])
      this.resumeAdStartTime = startTime
    }
  }
  /** @description to seek to next ad after snapback */

  onSeeked() {
    const {adBreaks, seek} = this._common
    if (!adBreaks || adBreaks.length <= 0) return

    if (this.waitingForPlayAds.length > 0 && !this.currentAd) {
      const nextAd =
        this.waitingForPlayAds[`${this.waitingForPlayAdIndex}`] || {}
      const {startTime: nextAdStartTime} = this.getAdTimingInfo(nextAd)
      seek === null || seek === void 0 ? void 0 : seek(nextAdStartTime)
      this.updateCurrentAd(nextAd)
    } else if (this.currentAd);
    else if (_IsNumber(this.resumeAdStartTime)) {
      _IsNumber(this.resumeAdStartTime) &&
        (seek === null || seek === void 0
          ? void 0
          : seek(this.resumeAdStartTime))
      this.resumeAdStartTime = null
      this.isResumed = true
    } else {
      this.isResumed = false
    }
  }

  updateCurrentAd(ad) {
    if (!this.currentAd && ad) {
      var _this$_common$onAdBre, _this$_common2

      ;(_this$_common$onAdBre = (_this$_common2 = this._common)
        .onAdBreakStarted) === null || _this$_common$onAdBre === void 0
        ? void 0
        : _this$_common$onAdBre.call(_this$_common2, adEventData(this, ad))
    } else if (this.currentAd && !ad) {
      var _this$_common$onAdBre2, _this$_common3

      ;(_this$_common$onAdBre2 = (_this$_common3 = this._common)
        .onAdBreakEnded) === null || _this$_common$onAdBre2 === void 0
        ? void 0
        : _this$_common$onAdBre2.call(_this$_common3, {
            getStreamData: () => this.getStreamData(),
          })
    }

    this.currentAd = ad

    if (!ad) {
      this.checkAdEventProcess = null
    }
  }

  updateWaitingForPlayAds(ads) {
    this.waitingForPlayAds = ads.slice()
  }

  updateWaitingForPlayIndex(index) {
    this.waitingForPlayAdIndex = index
  }
  /** @description mark all ads as played */

  setAllAdsFired() {
    this._common.adBreaks = this._common.adBreaks.map(ad => ({
      ...ad,
      isFired: true,
    }))
    this.updateWaitingForPlayAds([])
    this.updateWaitingForPlayIndex(null)
    this.updateCurrentAd(null)
  }
  /** @description clear data */

  reset() {
    this._common = {
      adBreaks: [],
      currentPosition: -1,
      seek: null,
    }
    this.currentAd = null
    this.waitingForPlayAds = []
    this.waitingForPlayAdIndex = null
    this.resumeUserSeekTime = null
    this.resumeAdStartTime = null
    this.isResumed = null
    this.checkAdEventProcess = null
  }
  /** @description clear ad status */

  resetSession() {
    this._common = {...this._common, currentPosition: 0}
    this.resumeUserSeekTime = null
    this.resumeAdStartTime = null
    this.isResumed = null
    this.updateWaitingForPlayAds([])
    this.updateWaitingForPlayIndex(null)
    this.updateCurrentAd(null)
  }
}

const getLastAd = (avails, streamTime) =>
  avails.reduce(
    (current, item) =>
      current.startTimeInSeconds <= item.startTimeInSeconds &&
      item.startTimeInSeconds <= streamTime
        ? item
        : current,
    {
      startTimeInSeconds: 0,
      durationInSeconds: 0,
    }
  )

const getStreamTime = (avails, contentTime) =>
  avails.reduce(
    (time, item) =>
      time + (time > item.startTimeInSeconds ? item.durationInSeconds : 0),
    contentTime
  )

const getContentTime = (avails, streamTime) =>
  streamTime -
  avails
    .filter(item => item.startTimeInSeconds <= streamTime)
    .map(item =>
      Math.min(streamTime - item.startTimeInSeconds, item.durationInSeconds)
    )
    .reduce((a, b) => a + b, 0)

const seekingHandler = handleSeeking => {
  const ref = {}
  return video => {
    if (
      !(Math.abs(video.currentTime - ref.originTime) > 0.5) ||
      video.webkitPresentationMode !== 'fullscreen'
    ) {
      ref.originTime = video.currentTime
      return
    }

    handleSeeking({
      originTime: ref.originTime,
      seekTime: video.currentTime,
    })
    ref.originTime = video.currentTime
  }
}

const once$1 = (target, name, handler) => {
  const oneTime = (...args) => {
    handler(...args)
    target.removeEventListener(name, oneTime)
  }

  target.addEventListener(name, oneTime)
  return () => target.removeEventListener(name, oneTime)
}

const snapback = ({streamManager, originTime, seekTime, seek}) => {
  const cuePoint =
    streamManager === null || streamManager === void 0
      ? void 0
      : streamManager.previousCuePointForStreamTime(seekTime)

  if (
    (cuePoint === null || cuePoint === void 0 ? void 0 : cuePoint.start) >=
    originTime
  ) {
    once$1(streamManager, 'adBreakEnded', async () => {
      // wait for ad playing flag to clear before resuming, TODO seek earlier
      await new Promise(resolve => setTimeout(resolve, 20))
      seek(seekTime)
    })
  }

  seek(
    (cuePoint === null || cuePoint === void 0 ? void 0 : cuePoint.start) >=
      originTime
      ? cuePoint.start
      : seekTime
  )
}

const addFetchPolyfill = () => {
  window.fetch = async (url, {method} = {}) => {
    const result = await axios(url, {
      method,
    })
    return Promise.resolve({
      json: () => result.data,
    })
  }
}

const fetchStreamInfo = async (url, adsParams) =>
  fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      adsParams,
    }),
  }).then(result => result.json())

const on = (eventTarget, eventName, handler) => {
  eventTarget.addEventListener(eventName, handler)
  return () => eventTarget.removeEventListener(eventName, handler)
}

const once = (eventTarget, eventName, handler) => {
  const listener = (...args) => {
    eventTarget.removeEventListener(eventName, listener)
    return handler(...args)
  }

  eventTarget.addEventListener(eventName, listener)
}

const seekVideo = (videoElement, streamTime) => {
  // eslint-disable-next-line no-param-reassign
  videoElement.currentTime = streamTime
}

const initialState = {
  currentTime: 0,
  adBreaks: [],
  mpdStartTime: 0,
  isUserSkipAd: false,
  skipAdEndTime: 0,
}

const getAdEndTime = (streamData, videoElement) => {
  const {currentTime, duration} = streamData.adProgressData
  return videoElement.currentTime + duration - currentTime
}

const pipeEvent = (emitter, type) => event =>
  emitter.emit(type, {
    type,
    getAd: () => event.getAd(),
    getStreamData: () => event.getStreamData(),
  })

const getMpdStartTime = manifest => {
  const mpdDocument = new DOMParser().parseFromString(manifest, 'text/xml')
  const availabilityStartTime = mpdDocument.firstChild.getAttribute(
    'availabilityStartTime'
  )
  return new Date(availabilityStartTime).getTime() / 1000
} // Align to Google DAI StreamManager

const createStreamManager = (videoElement, {player, emitter}) => {
  let state = initialState
  const streamData = {}
  const impression = new Impression({
    seek: streamTime => seekVideo(videoElement, streamTime),
    onAdBreakStarted: pipeEvent(emitter, 'adBreakStarted'),
    onAdProgress: event => {
      state.adEndTime = getAdEndTime(event.getStreamData(), videoElement)
      pipeEvent(emitter, 'adProgress')(event)
    },
    onSkippableStateChanged: pipeEvent(emitter, 'skippableStateChanged'),
    onAdBreakEnded: pipeEvent(emitter, 'adBreakEnded'),
  })

  const previousCuePointForStreamTime = streamTime => {
    const ad = getLastAd(state.adBreaks, streamTime - 0.1 - state.mpdStartTime)

    if (ad.durationInSeconds > 0) {
      const start = ad.startTimeInSeconds
      const end = start + ad.durationInSeconds
      return {
        start,
        end,
        played: state.played[ad.availId],
      }
    }

    return undefined
  }

  emitter.on('adBreakEnded', () => {
    state.adEndTime = -1
    const ad = getLastAd(state.adBreaks, videoElement.currentTime)
    state.played[ad.availId] = true
  })

  const refreshTrackingData = async () => {
    if (!streamData.trackingUrl) {
      return
    }

    const trackingData = (await fetch(streamData.trackingUrl).then(result =>
      result.json()
    )) || {
      avails: [],
    }
    state.adBreaks = trackingData.avails || []

    if (trackingData.avails.length > 0) {
      impression.adBreaks = state.adBreaks
      emitter.emit('cuepointsChanged', {
        cuepoints: state.adBreaks.map(item => ({
          start: getContentTime(state.adBreaks, item.startTimeInSeconds),
        })),
      })
    }
  }

  const handleTimeUpdate = streamTime => {
    // TODO get tracking events with actual buffer length
    if (!Number.isFinite(streamTime)) {
      return
    }

    if (player.isLive() && streamTime > state.currentTime + 5) {
      state.currentTime = streamTime
      refreshTrackingData()
    } // workaround_OTP_2813

    if (state.isUserSkipAd) {
      // 0.1 is magic number for float-point
      if (state.skipAdEndTime + 0.1 >= streamTime) {
        return
      }

      state.isUserSkipAd = false
      state.skipAdEndTime = -1
    }

    impression.currentPosition = streamTime - state.mpdStartTime
  }

  const streamManager = {
    requestStream: async (options = {}) => {
      const reportingUrl = options.client_side_reporting_url
      const info = await fetchStreamInfo(reportingUrl, options.adParams).catch(
        error => ({
          error,
        })
      )

      if (!info || info.error) {
        return
      }

      streamData.trackingUrl = new URL(
        info.trackingUrl,
        reportingUrl
      ).toString()
      streamData.url = new URL(info.manifestUrl, reportingUrl).toString() // tracking events are available only after manifests are requested

      await fetchManifests(streamData.url)
      await refreshTrackingData()
      emitter.emit('loaded', {
        getStreamData: () => streamData,
      })
      state.played = {}
    },
    addEventListener: (eventName, handler) => emitter.on(eventName, handler),
    removeEventListener: (eventName, handler) =>
      emitter.off(eventName, handler),
    streamTimeForContentTime: contentTime =>
      getStreamTime(state.adBreaks, contentTime),
    contentTimeForStreamTime: streamTime =>
      getContentTime(state.adBreaks, streamTime),
    previousCuePointForStreamTime,
    skipAd: () => {
      if (state.adEndTime > 0) {
        // workaround_OTP_2813
        const seekTime = state.adEndTime
        handleTimeUpdate(state.adEndTime)
        state.isUserSkipAd = true
        state.skipAdEndTime = seekTime
        player === null || player === void 0
          ? void 0
          : player.seek(seekTime, 'internal')
      }
    },
    setMpdStartTime: time => {
      state.mpdStartTime = time
    },
    getVastAvails: () => state.adBreaks,
    reset: () => {
      state.registered.forEach(removeListener => removeListener())
      impression.reset()
      state = initialState
      streamData.trackingUrl = ''
    },
  }
  const handleSeeking = seekingHandler(({originTime, seekTime}) => {
    if (state.adEndTime > 0) {
      seekVideo(videoElement, originTime)
      return
    }

    const diff = seekTime - originTime

    if (Math.abs(diff + 15) <= 0.25) {
      seekVideo(
        videoElement,
        getStreamTime(
          state.adBreaks,
          getContentTime(state.adBreaks, originTime) + diff
        )
      )
      return
    }

    snapback({
      streamManager,
      originTime,
      seekTime,
      seek: streamTime => {
        if (Math.abs(videoElement.currentTime - streamTime) > 0.5) {
          seekVideo(videoElement, streamTime)
        }
      },
    })
  })
  state.registered = [
    on(videoElement, 'timeupdate', () => {
      handleSeeking(videoElement)

      if (!videoElement.paused) {
        handleTimeUpdate(videoElement.currentTime)
      }
    }),
    on(videoElement, 'ended', () => handleTimeUpdate(Infinity)),
  ]
  return streamManager
}

const init = (options, {skipWatched}) => {
  var _player$on

  const {player, video, streamManager} = options
  const ref = {
    player,
    video,
    streamManager,
  }
  streamManager.addEventListener('adProgress', event => {
    ref.adEndTime = getAdEndTime(event.getStreamData(), ref.video)
  })
  streamManager.addEventListener('adBreakEnded', () => {
    ref.adEndTime = -1
  })
  player === null || player === void 0
    ? void 0
    : (_player$on = player.on) === null || _player$on === void 0
    ? void 0
    : _player$on.call(player, 'sourceloaded', () => {
        ref.isLive = player.isLive()

        if (player.manifest.dash && player.isLive()) {
          // ad start / end time is based on availabilityStartTime in MPD manifest
          streamManager.setMpdStartTime(getMpdStartTime(player.getManifest()))
        }
      })

  if (skipWatched) {
    video.addEventListener('timeupdate', () => {
      const streamTime = video.currentTime
      const cuePoint = streamManager.previousCuePointForStreamTime(
        streamTime + 0.5
      )

      if (
        (cuePoint === null || cuePoint === void 0 ? void 0 : cuePoint.end) >
          streamTime &&
        cuePoint.played
      ) {
        player === null || player === void 0
          ? void 0
          : player.seek(cuePoint.end, 'internal')
      }
    })
  }

  return ref
}

const MediaTailorPlugin = ({adParams, skipWatched} = {}) => {
  const emitter = mitt()
  let ref = {}
  let options = {
    adParams,
  }
  return {
    isActive: () => !!ref.streamManager,
    load: async (manifestItem, {player, video, source = {}} = {}) => {
      var _ref$streamManager, _manifestItem$ssai, _source$options

      if (typeof fetch !== 'function') {
        addFetchPolyfill()
      }

      ;(_ref$streamManager = ref.streamManager) === null ||
      _ref$streamManager === void 0
        ? void 0
        : _ref$streamManager.reset()
      const mediaTailorOptions =
        (_manifestItem$ssai = manifestItem.ssai) === null ||
        _manifestItem$ssai === void 0
          ? void 0
          : _manifestItem$ssai.media_tailor

      if (!mediaTailorOptions) {
        return
      }

      mediaTailorOptions.adParams = options.adParams
      const streamManager = createStreamManager(video, {
        player,
        emitter,
      })
      ref = init(
        {
          player,
          video,
          streamManager,
        },
        {
          skipWatched,
        }
      )
      streamManager.requestStream(mediaTailorOptions)
      const {url} = await new Promise(resolve => {
        once(streamManager, 'loaded', event => resolve(event.getStreamData()))
      })

      if (!url) {
        console.warn('Ad stream is not available, use fallback stream instead')
        return manifestItem
      }

      return {
        ...manifestItem,
        ssaiProvider: 'AWS',
        url,
        vastAvails: streamManager.getVastAvails(),
        startTime: streamManager.streamTimeForContentTime(
          (_source$options = source.options) === null ||
            _source$options === void 0
            ? void 0
            : _source$options.startTime
        ),
      }
    },
    handleSeek: (contentTime, seek) => {
      snapback({
        streamManager: ref.streamManager,
        originTime: ref.video.currentTime,
        seekTime: ref.streamManager.streamTimeForContentTime(contentTime),
        seek,
      })
    },
    skipAd: () => ref.streamManager.skipAd(),
    getPlaybackStatus: () =>
      ref.streamManager && {
        ...(!ref.isLive && {
          currentTime: ref.streamManager.contentTimeForStreamTime(
            ref.video.currentTime
          ),
          duration: ref.streamManager.contentTimeForStreamTime(
            ref.video.duration
          ),
        }),
        ...(ref.adEndTime > 0 && {
          adRemainingTime: ref.adEndTime - ref.video.currentTime,
        }),
      },
    on: (name, listener) => emitter.on(name, listener),
    reset: () => {
      var _ref$streamManager2

      ;(_ref$streamManager2 = ref.streamManager) === null ||
      _ref$streamManager2 === void 0
        ? void 0
        : _ref$streamManager2.reset()
      ref.streamManager = undefined
    },
    setOptions: updatedOptions => {
      options = updatedOptions
    },
  }
}

const pipeEvents = (source, target, types) => {
  const registered = types.map(name => {
    const pipe = event => target.emit(name, event)

    source.addEventListener(name, pipe)
    return () => source.removeEventListener(name, pipe)
  })
  return () =>
    [].concat(...registered).forEach(removeListener => removeListener())
}

const loadScript = url =>
  new Promise(resolve => {
    const script = Object.assign(document.createElement('script'), {
      async: true,
      src: url,
    })
    script.addEventListener('load', resolve)
    document.body.appendChild(script)
  })

const GOOGLE_DAI_SDK_URL =
  'https://imasdk.googleapis.com/js/sdkloader/ima3_dai.js'

const ensureDaiApi = async () => {
  var _window$google,
    _window$google$ima,
    _window$google$ima$da,
    _window$google$ima$da2

  if (
    !(
      (_window$google = window.google) !== null &&
      _window$google !== void 0 &&
      (_window$google$ima = _window$google.ima) !== null &&
      _window$google$ima !== void 0 &&
      (_window$google$ima$da = _window$google$ima.dai) !== null &&
      _window$google$ima$da !== void 0 &&
      (_window$google$ima$da2 = _window$google$ima$da.api) !== null &&
      _window$google$ima$da2 !== void 0 &&
      _window$google$ima$da2.StreamManager
    )
  ) {
    await loadScript(GOOGLE_DAI_SDK_URL)
  }

  return window.google.ima.dai.api
}

const ImaDaiPlugin = () => {
  const emitter = mitt()
  const ref = {}

  const reset = () => {
    var _ref$streamManager

    ref.progress = undefined
    ;(_ref$streamManager = ref.streamManager) === null ||
    _ref$streamManager === void 0
      ? void 0
      : _ref$streamManager.reset()
    ref.streamManager = undefined
    ref.video = undefined
  }

  const getStartTime = startTime => {
    var _earliestCuepoint$sta, _earliestCuepoint

    const startTimeInStreamTime =
      ref.streamManager.streamTimeForContentTime(startTime)
    let earliestCuepoint = {
      start: startTimeInStreamTime,
    } // Find if there is a pre-roll ad. Note that we need to handle multiple mid-roll ads in phase 2.
    // The possible solution is storing the cuepoints in a stack and pop it while finishing an ad.

    while (earliestCuepoint !== null && earliestCuepoint.start !== 0) {
      earliestCuepoint = ref.streamManager.previousCuePointForStreamTime(
        earliestCuepoint.start
      )
    }

    return (_earliestCuepoint$sta =
      (_earliestCuepoint = earliestCuepoint) === null ||
      _earliestCuepoint === void 0
        ? void 0
        : _earliestCuepoint.start) !== null && _earliestCuepoint$sta !== void 0
      ? _earliestCuepoint$sta
      : startTimeInStreamTime
  }

  return {
    isActive: () => !!ref.streamManager,
    load: async (manifestItem, {player, video, streamFormat, startTime}) => {
      var _manifestItem$ssai

      reset()

      if (
        !(
          (_manifestItem$ssai = manifestItem.ssai) !== null &&
          _manifestItem$ssai !== void 0 &&
          _manifestItem$ssai.google_dai
        )
      ) {
        return
      }

      ref.video = video
      const {live: liveOptions, vod: vodOptions} = manifestItem.ssai.google_dai
      const daiApi = await ensureDaiApi()

      if (!ref.adContainer) {
        // eslint-disable-next-line no-console
        console.warn(
          `The 'adContainer' is '${ref.adContainer}'. Please provide it using 'ImaDai.setAdContainer', or the DAI SDK won't request skippable ADs. See: https://developers.google.com/interactive-media-ads/docs/sdks/html5/dai/reference/js/StreamManager#StreamManager`
        )
      }

      ref.streamManager = new daiApi.StreamManager(video, ref.adContainer)
      pipeEvents(ref.streamManager, emitter, ['skippableStateChanged'])
      /**
       * To align with the MideaTailor, convert the cuepoint.start from the stream time to content time.
       */

      ref.streamManager.addEventListener(
        daiApi.StreamEvent.Type.CUEPOINTS_CHANGED,
        event => {
          const cuepointsInContentTime = event
            .getStreamData()
            .cuepoints.map(cuepoint => ({
              start: ref.streamManager.contentTimeForStreamTime(cuepoint.start),
            }))
          emitter.emit('cuepointsChanged', {
            cuepoints: cuepointsInContentTime,
          })
        }
      )
      /**
       * We can't get the adProgressData from the event adBreakStarted, so we map the first call of adProgress to adBreakStarted.
       */

      let isFirstAdProgressCalled = true
      ref.streamManager.addEventListener('adProgress', event => {
        if (isFirstAdProgressCalled) {
          emitter.emit('adBreakStarted', event)
          isFirstAdProgressCalled = false
        } else {
          emitter.emit('adProgress', event)
        }
      })
      ref.streamManager.addEventListener('adBreakEnded', event => {
        emitter.emit('adBreakEnded', event)
        isFirstAdProgressCalled = true
      })
      const requestOptions = {
        apiKey:
          (liveOptions === null || liveOptions === void 0
            ? void 0
            : liveOptions.api_key) ||
          (vodOptions === null || vodOptions === void 0
            ? void 0
            : vodOptions.api_key),
        contentSourceId:
          vodOptions === null || vodOptions === void 0
            ? void 0
            : vodOptions.content_source_id,
        videoId:
          vodOptions === null || vodOptions === void 0
            ? void 0
            : vodOptions.video_id,
        assetKey:
          liveOptions === null || liveOptions === void 0
            ? void 0
            : liveOptions.asset_key,
        format: streamFormat,
      }
      const streamRequest = Object.assign(
        liveOptions
          ? new daiApi.LiveStreamRequest()
          : new daiApi.VODStreamRequest(),
        requestOptions
      )
      const url = await new Promise(resolve => {
        ref.streamManager.addEventListener(daiApi.StreamEvent.Type.LOADED, e =>
          resolve(e.getStreamData().url)
        )
        ref.streamManager.requestStream(streamRequest)
      })
      player.on('metadata', ({metadata}) => {
        const TXXX = metadata.TXXX || metadata.properties.messageData
        ref.streamManager.onTimedMetadata({
          TXXX,
        })
      })
      ref.streamManager.addEventListener(
        daiApi.StreamEvent.Type.AD_PROGRESS,
        e => {
          ref.progress = e.getStreamData().adProgressData
        }
      )
      return {
        ssaiProvider: 'DAI',
        url,
        startTime: getStartTime(startTime),
      }
    },
    getPlaybackStatus: () =>
      ref.streamManager &&
      ref.video && {
        currentTime: ref.streamManager.contentTimeForStreamTime(
          ref.video.currentTime
        ),
        duration: ref.streamManager.contentTimeForStreamTime(
          ref.video.duration
        ),
        ...(ref.progress && {
          adRemainingTime: ref.progress.duration - ref.progress.currentTime,
        }),
      },
    on: (name, listener) => emitter.on(name, listener),
    reset,
    handleSeek: (contentTime, seek) => {
      snapback({
        streamManager: ref.streamManager,
        originTime: ref.video.currentTime,
        seekTime: ref.streamManager.streamTimeForContentTime(contentTime),
        seek,
      })
    },
    setAdContainer: adContainer => {
      ref.adContainer = adContainer
    },
  }
}

const wallTimeSeconds = () => Date.now() / 1000

const StallReloadPlugin = ({stallThresholdSeconds = 10} = {}) => {
  const state = {
    lastVideoTime: 0,
    lastTimer: 0,
    lastUpdateSeconds: wallTimeSeconds(),
  }

  const load = (_, {player, video, source}) => {
    clearInterval(state.lastTimer)

    const checkStall = async () => {
      if (
        video.paused ||
        video.playbackRate === 0 ||
        state.lastVideoTime !== video.currentTime ||
        !(video.currentTime > 0)
      ) {
        state.lastUpdateSeconds = wallTimeSeconds()
        state.lastVideoTime = video.currentTime
        return
      }

      if (wallTimeSeconds() - state.lastUpdateSeconds > stallThresholdSeconds) {
        console.warn('Stall detected, reload to resume')
        await player.load(source)
        player.play()
      }
    }

    state.lastVideoTime = video.currentTime
    state.lastTimer = setInterval(
      checkStall,
      (stallThresholdSeconds / 8) * 1000
    )
    video.addEventListener('play', () => {
      state.lastUpdateSeconds = wallTimeSeconds()
    })
  }

  return {
    load,
  }
}

export {ImaDaiPlugin, MediaTailorPlugin, StallReloadPlugin}
