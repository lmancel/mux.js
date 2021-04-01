const Stream = require('../../utils/stream')
const mp4 = require('../mp4-generator.js')
const audioFrameUtils = require('../audio-frame-utils')
const trackDecodeInfo = require('../track-decode-info')
const clock = require('../../utils/clock')
const AUDIO_PROPERTIES = require('../../constants/audio-properties.js')

const generateSegmentTimingInfo = function(
  baseMediaDecodeTime,
  startDts,
  startPts,
  endDts,
  endPts,
  prependedContentDuration
) {
  const ptsOffsetFromDts = startPts - startDts
  const decodeDuration = endDts - startDts
  const presentationDuration = endPts - startPts

  // The PTS and DTS values are based on the actual stream times from the segment,
  // however, the player time values will reflect a start from the baseMediaDecodeTime.
  // In order to provide relevant values for the player times, base timing info on the
  // baseMediaDecodeTime and the DTS and PTS durations of the segment.
  return {
    start: {
      dts: baseMediaDecodeTime,
      pts: baseMediaDecodeTime + ptsOffsetFromDts,
    },
    end: {
      dts: baseMediaDecodeTime + decodeDuration,
      pts: baseMediaDecodeTime + presentationDuration,
    },
    prependedContentDuration: prependedContentDuration,
    baseMediaDecodeTime: baseMediaDecodeTime,
  }
}

/**
 * Constructs a single-track, ISO BMFF media segment from AAC data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 * @param track {object} track metadata configuration
 * @param options {object} transmuxer options object
 * @param options.keepOriginalTimestamps {boolean} If true, keep the timestamps
 *        in the source; false to adjust the first segment to start at 0.
 */
module.exports = class extends Stream {
  constructor(track, options = {}) {
    super()
    this.track = track
    this.options = options
    this.adtsFrames = []
    this.sequenceNumber = 0
    this.earliestAllowedDts = 0
    this.audioAppendStartTs = 0
    this.videoBaseMediaDecodeTime = Infinity

    this.init()
  }

  push(data) {
    trackDecodeInfo.collectDtsInfo(this.track, data)

    if (this.track) {
      AUDIO_PROPERTIES.forEach((prop) => {
        this.track[prop] = data[prop]
      })
    }

    // buffer audio data until end() is called
    this.adtsFrames.push(data)
  }

  setEarliestDts(earliestDts) {
    this.earliestAllowedDts = earliestDts
  }

  setVideoBaseMediaDecodeTime(baseMediaDecodeTime) {
    this.videoBaseMediaDecodeTime = baseMediaDecodeTime
  }

  setAudioAppendStart(timestamp) {
    this.audioAppendStartTs = timestamp
  }

  flush() {
    let
      frames,
      moof,
      mdat,
      boxes,
      frameDuration,
      segmentDuration,
      videoClockCyclesOfSilencePrefixed

    // return early if no audio data has been observed
    if (this.adtsFrames.length === 0) {
      this.trigger('done', 'AudioSegmentStream')
      return
    }

    frames = audioFrameUtils.trimAdtsFramesByEarliestDts(
      this.adtsFrames, this.track, this.earliestAllowedDts
    )
    this.track.baseMediaDecodeTime =
      trackDecodeInfo.calculateTrackBaseMediaDecodeTime(
        this.track, this.options.keepOriginalTimestamps
      )

    // amount of audio filled but the value is in video clock rather than audio clock
    videoClockCyclesOfSilencePrefixed = audioFrameUtils.prefixWithSilence(
      this.track, frames, this.audioAppendStartTs, this.videoBaseMediaDecodeTime)

    // we have to build the index from byte locations to
    // samples (that is, adts frames) in the audio data
    this.track.samples = audioFrameUtils.generateSampleTable(frames)

    // concatenate the audio data to constuct the mdat
    mdat = mp4.mdat(audioFrameUtils.concatenateFrameData(frames))

    this.adtsFrames = []

    moof = mp4.moof(this.sequenceNumber, [this.track])
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength)

    // bump the sequence number for next time
    this.sequenceNumber++

    boxes.set(moof)
    boxes.set(mdat, moof.byteLength)

    trackDecodeInfo.clearDtsInfo(this.track)

    frameDuration = Math.ceil(clock.ONE_SECOND_IN_TS * 1024 / this.track.samplerate)

    // TODO this check was added to maintain backwards compatibility (particularly with
    // tests) on adding the timingInfo event. However, it seems unlikely that there's a
    // valid use-case where an init segment/data should be triggered without associated
    // frames. Leaving for now, but should be looked into.
    if (frames.length) {
      segmentDuration = frames.length * frameDuration

      this.trigger(
        'segmentTimingInfo',
        generateSegmentTimingInfo(
          // The audio track's baseMediaDecodeTime is in audio clock cycles, but the
          // frame info is in video clock cycles. Convert to match expectation of
          // listeners (that all timestamps will be based on video clock cycles).
          clock.audioTsToVideoTs(this.track.baseMediaDecodeTime, this.track.samplerate),
          // frame times are already in video clock, as is segment duration
          frames[0].dts,
          frames[0].pts,
          frames[0].dts + segmentDuration,
          frames[0].pts + segmentDuration,
          videoClockCyclesOfSilencePrefixed || 0,
        )
      )

      this.trigger('timingInfo', {
        start: frames[0].pts,
        end: frames[0].pts + segmentDuration,
      })
    }
    this.trigger('data', {track: this.track, boxes: boxes})
    this.trigger('done', 'AudioSegmentStream')
  }

  reset() {
    trackDecodeInfo.clearDtsInfo(this.track)
    this.adtsFrames = []
    this.trigger('reset')
  }
}
