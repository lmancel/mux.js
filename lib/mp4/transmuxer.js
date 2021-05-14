'use strict'

/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * A stream-based mp2t to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */

const Stream = require('../utils/stream.js')
const trackDecodeInfo = require('./track-decode-info')
const m2ts = require('../m2ts/m2ts.js')
const AdtsStream = require('../codecs/adts.js')
const H264Stream = require('../codecs/h264').H264Stream
const AUDIO_PROPERTIES = require('../constants/audio-properties.js')
const VIDEO_PROPERTIES = require('../constants/video-properties.js')
const AudioSegmentStream = require('./transmuxer/audioSegmentStream.js')
const VideoSegmentStream = require('./transmuxer/videoSegmentStream.js')
const CoalesceStream = require('./transmuxer/coalesceStream.js')
const streamEventTypes = require('../m2ts/stream-event-types.js')

/**
 * A Stream that expects MP2T binary data as input and produces
 * corresponding media segments, suitable for use with Media Source
 * Extension (MSE) implementations that support the ISO BMFF byte
 * stream format, like Chrome.
 */
class Transmuxer extends Stream {
  constructor(options) {
    super()
    this.hasFlushed = true
    this.videoTrack = undefined
    this.audioTracks = []

    this.init()

    this.options = options || {}
    this.baseMediaDecodeTime = options.baseMediaDecodeTime || 0
    this.transmuxPipeline_ = {}
  }

  setupTsPipeline() {
    const pipeline = {}

    this.transmuxPipeline_ = pipeline

    pipeline.type = 'ts'
    pipeline.metadataStream = new m2ts.MetadataStream()

    // set up the parsing pipeline
    pipeline.packetStream = new m2ts.TransportPacketStream()
    pipeline.parseStream = new m2ts.TransportParseStream()
    pipeline.elementaryStream = new m2ts.ElementaryStream()
    pipeline.timestampRolloverStream = new m2ts.TimestampRolloverStream()
    pipeline.adtsStream = new AdtsStream()
    pipeline.h264Stream = new H264Stream()
    pipeline.captionStream = new m2ts.CaptionStream(this.options)
    pipeline.coalesceStream = new CoalesceStream(this.options, pipeline.metadataStream)
    pipeline.headOfPipeline = pipeline.packetStream

    // disassemble MPEG2-TS packets into elementary streams
    pipeline.packetStream
      .pipe(pipeline.parseStream)
      .pipe(pipeline.elementaryStream)
      .pipe(pipeline.timestampRolloverStream)

    // !!THIS ORDER IS IMPORTANT!!
    // demux the streams
    pipeline.timestampRolloverStream
      .pipe(pipeline.h264Stream)

    pipeline.timestampRolloverStream
      .pipe(pipeline.adtsStream)

    pipeline.timestampRolloverStream
      .pipe(pipeline.metadataStream)
      .pipe(pipeline.coalesceStream)

    // Hook up CEA-608/708 caption stream
    pipeline.h264Stream.pipe(pipeline.captionStream)
      .pipe(pipeline.coalesceStream)

    pipeline.elementaryStream.on('data', ({ type, tracks }) => {
      if (type === streamEventTypes.METADATA && !this.audioTracks.length) {
        const subtitles = []

        // scan the tracks listed in the metadata
        tracks.forEach(track => {
          if (track.type === 'audio') {
            this.audioTracks.push(track)
            pipeline.coalesceStream.addTrack('audio', track.pid)
          } else if (!this.videoTrack && track.type === 'video') {
            this.videoTrack = track
            this.videoTrack.timelineStartInfo.baseMediaDecodeTime = this.baseMediaDecodeTime
            pipeline.coalesceStream.addTrack('video', track.pid)
          } else if (track.type === 'subtitles') {
            subtitles.push(track)
          }
        })

        // hook up the video segment stream to the first track with h264 data
        if (this.videoTrack && !pipeline.videoSegmentStream) {
          pipeline.videoSegmentStream = new VideoSegmentStream(this.videoTrack, this.options)

          pipeline.videoSegmentStream.on('timelineStartInfo', (timelineStartInfo) => {
            // When video emits timelineStartInfo data after a flush, we forward that
            // info to the AudioSegmentStream, if it exists, because video timeline
            // data takes precedence.  Do not do this if keepOriginalTimestamps is set,
            // because this is a particularly subtle form of timestamp alteration.
            if (this.audioTracks.length && !this.options.keepOriginalTimestamps) {
              this.audioTracks.forEach(audioTrack => {
                audioTrack.timelineStartInfo = timelineStartInfo
              })

              // On the first segment we trim AAC frames that exist before the
              // very earliest DTS we have seen in video because Chrome will
              // interpret any video track with a baseMediaDecodeTime that is
              // non-zero as a gap.
              pipeline.audioSegmentStream.setEarliestDts(timelineStartInfo.dts - this.baseMediaDecodeTime)
            }
          })

          pipeline.videoSegmentStream.on('processedGopsInfo',
            this.trigger.bind(this, 'gopInfo'))
          pipeline.videoSegmentStream.on('segmentTimingInfo',
            this.trigger.bind(this, 'videoSegmentTimingInfo'))

          pipeline.videoSegmentStream.on('baseMediaDecodeTime', (baseMediaDecodeTime) => {
            if (this.audioTracks.length) {
              pipeline.audioSegmentStream.setVideoBaseMediaDecodeTime(baseMediaDecodeTime)
            }
          })

          pipeline.videoSegmentStream.on('timingInfo',
            this.trigger.bind(this, 'videoTimingInfo'))

          // Set up the final part of the video pipeline
          pipeline.h264Stream
            .pipe(pipeline.videoSegmentStream)
            .pipe(pipeline.coalesceStream)
        }

        if (this.audioTracks.length && !pipeline.audioSegmentStream) {
          // hook up the audio segment stream to the first track with aac data
          pipeline.audioSegmentStream = new AudioSegmentStream(this.audioTracks, this.options)

          pipeline.audioSegmentStream.on('timingInfo',
            this.trigger.bind(this, 'audioTimingInfo'))
          pipeline.audioSegmentStream.on('segmentTimingInfo',
            this.trigger.bind(this, 'audioSegmentTimingInfo'))

          // Set up the final part of the audio pipeline
          pipeline.adtsStream
            .pipe(pipeline.audioSegmentStream)
            .pipe(pipeline.coalesceStream)
        }

        if (this.pendingAudioTrack) {
          pipeline.coalesceStream.currentAudioPid = this.pendingAudioTrack
          this.pendingAudioTrack = undefined
        }

        // emit pmt info
        this.trigger('trackinfo', {
          audio: this.audioTracks,
          video: this.videoTrack,
          subtitles,
        })
      }
    })

    // Re-emit any data coming from the coalesce stream to the outside world
    pipeline.coalesceStream.on('data', this.trigger.bind(this, 'data'))
    pipeline.coalesceStream.on('id3Frame', (id3Frame) => {
      id3Frame.dispatchType = pipeline.metadataStream.dispatchType

      this.trigger('id3Frame', id3Frame)
    })
    pipeline.coalesceStream.on('caption', this.trigger.bind(this, 'caption'))
    // Let the consumer know we have finished flushing the entire pipeline
    pipeline.coalesceStream.on('done', this.trigger.bind(this, 'done'))
  }

  // hook up the segment streams once track metadata is delivered
  setBaseMediaDecodeTime(baseMediaDecodeTime) {
    const pipeline = this.transmuxPipeline_

    if (!this.options.keepOriginalTimestamps) {
      this.baseMediaDecodeTime = baseMediaDecodeTime
    }

    this.audioTracks.forEach(audioTrack => {
      audioTrack.timelineStartInfo.dts = undefined
      audioTrack.timelineStartInfo.pts = undefined
      trackDecodeInfo.clearDtsInfo(audioTrack)
      if (pipeline.audioTimestampRolloverStream) {
        pipeline.audioTimestampRolloverStream.discontinuity()
      }
    })
    if (this.videoTrack) {
      if (pipeline.videoSegmentStream) {
        pipeline.videoSegmentStream.gopCache_ = []
      }
      this.videoTrack.timelineStartInfo.dts = undefined
      this.videoTrack.timelineStartInfo.pts = undefined
      trackDecodeInfo.clearDtsInfo(this.videoTrack)
      pipeline.captionStream.reset()
    }

    if (pipeline.timestampRolloverStream) {
      pipeline.timestampRolloverStream.discontinuity()
    }
  }

  setAudioAppendStart(timestamp) {
    if (this.audioTracks.length) {
      this.transmuxPipeline_.audioSegmentStream.setAudioAppendStart(timestamp)
    }
  }

  setRemux(val) {
    const pipeline = this.transmuxPipeline_

    this.options.remux = val

    if (pipeline && pipeline.coalesceStream) {
      pipeline.coalesceStream.setRemux(val)
    }
  }

  alignGopsWith(gopsToAlignWith) {
    if (this.videoTrack && this.transmuxPipeline_.videoSegmentStream) {
      this.transmuxPipeline_.videoSegmentStream.alignGopsWith(gopsToAlignWith)
    }
  }

  // feed incoming data to the front of the parsing pipeline
  push(data) {
    if (this.hasFlushed) {
      if (this.transmuxPipeline_.type !== 'ts') {
        this.setupTsPipeline()
      }
      this.hasFlushed = false
    }
    this.transmuxPipeline_.headOfPipeline.push(data)
  }

  // flush any buffered data
  flush() {
    if (this.transmuxPipeline_.headOfPipeline) {
      this.hasFlushed = true
      // Start at the top of the pipeline and flush all pending work
      this.transmuxPipeline_.headOfPipeline.flush()
    }
  }

  endTimeline() {
    this.transmuxPipeline_.headOfPipeline.endTimeline()
  }

  reset() {
    if (this.transmuxPipeline_.headOfPipeline) {
      this.transmuxPipeline_.headOfPipeline.reset()
    }
    this.transmuxPipeline_ = {}

    this.hasFlushed = true
    this.videoTrack = undefined
    this.audioTracks = []
    this.baseMediaDecodeTime = 0
    this.pendingAudioTrack = undefined
  }

  // Caption data has to be reset when seeking outside buffered range
  resetCaptions() {
    if (this.transmuxPipeline_.captionStream) {
      this.transmuxPipeline_.captionStream.reset()
    }
  }

  setAudioTrackFromPid(pid) {
    if (this.transmuxPipeline_.coalesceStream) {
      this.transmuxPipeline_.coalesceStream.currentAudioPid = pid
    } else {
      this.pendingAudioTrack = pid
    }
  }

  canFlush() {
    return !!this.transmuxPipeline_ &&
      !!this.transmuxPipeline_.videoSegmentStream &&
      this.transmuxPipeline_.videoSegmentStream.canFlush()
  }
}

module.exports = {
  Transmuxer: Transmuxer,
  VideoSegmentStream: VideoSegmentStream,
  AudioSegmentStream: AudioSegmentStream,
  AUDIO_PROPERTIES: AUDIO_PROPERTIES,
  VIDEO_PROPERTIES: VIDEO_PROPERTIES,
}
