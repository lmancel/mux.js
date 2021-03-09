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
const AacStream = require('../aac')
const isLikelyAacData = require('../aac/utils').isLikelyAacData
const AUDIO_PROPERTIES = require('../constants/audio-properties.js')
const VIDEO_PROPERTIES = require('../constants/video-properties.js')
const AudioSegmentStream = require('./transmuxer/audioSegmentStream.js')
const VideoSegmentStream = require('./transmuxer/videoSegmentStream.js')
const CoalesceStream = require('./transmuxer/coalesceStream.js')

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
    this.audioTrack = undefined

    this.init()

    this.options = options || {}
    this.baseMediaDecodeTime = options.baseMediaDecodeTime || 0
    this.transmuxPipeline_ = {}
  }

  setupAacPipeline() {
    const pipeline = {}

    this.transmuxPipeline_ = pipeline

    pipeline.type = 'aac'
    pipeline.metadataStream = new m2ts.MetadataStream()

    // set up the parsing pipeline
    pipeline.aacStream = new AacStream()
    pipeline.audioTimestampRolloverStream = new m2ts.TimestampRolloverStream('audio')
    pipeline.timedMetadataTimestampRolloverStream = new m2ts.TimestampRolloverStream('timed-metadata')
    pipeline.adtsStream = new AdtsStream()
    pipeline.coalesceStream = new CoalesceStream(this.options, pipeline.metadataStream)
    pipeline.headOfPipeline = pipeline.aacStream

    pipeline.aacStream
      .pipe(pipeline.audioTimestampRolloverStream)
      .pipe(pipeline.adtsStream)
    pipeline.aacStream
      .pipe(pipeline.timedMetadataTimestampRolloverStream)
      .pipe(pipeline.metadataStream)
      .pipe(pipeline.coalesceStream)

    pipeline.metadataStream.on('timestamp', (frame) => {
      pipeline.aacStream.setTimestamp(frame.timeStamp)
    })

    pipeline.aacStream.on('data', (data) => {
      if ((data.type !== 'timed-metadata' && data.type !== 'audio') || pipeline.audioSegmentStream) {
        return
      }

      this.audioTrack = this.audioTrack || {
        timelineStartInfo: {
          baseMediaDecodeTime: this.baseMediaDecodeTime,
        },
        codec: 'adts',
        type: 'audio',
      }
      // hook up the audio segment stream to the first track with aac data
      pipeline.coalesceStream.numberOfTracks++
      pipeline.audioSegmentStream = new AudioSegmentStream(this.audioTrack, this.options)

      pipeline.audioSegmentStream.on('timingInfo',
        this.trigger.bind(this, 'audioTimingInfo'))

      // Set up the final part of the audio pipeline
      pipeline.adtsStream
        .pipe(pipeline.audioSegmentStream)
        .pipe(pipeline.coalesceStream)

      // emit pmt info
      this.trigger('trackinfo', {
        hasAudio: !!this.audioTrack,
        hasVideo: !!this.videoTrack,
      })
    })

    // Re-emit any data coming from the coalesce stream to the outside world
    pipeline.coalesceStream.on('data', this.trigger.bind(this, 'data'))
    // Let the consumer know we have finished flushing the entire pipeline
    pipeline.coalesceStream.on('done', this.trigger.bind(this, 'done'))
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

    pipeline.elementaryStream.on('data', (data) => {
      let i

      if (data.type === 'metadata') {
        i = data.tracks.length

        // scan the tracks listed in the metadata
        while (i--) {
          if (!this.videoTrack && data.tracks[i].type === 'video') {
            this.videoTrack = data.tracks[i]
            this.videoTrack.timelineStartInfo.baseMediaDecodeTime = this.baseMediaDecodeTime
          } else if (!this.audioTrack && data.tracks[i].type === 'audio') {
            this.audioTrack = data.tracks[i]
            this.audioTrack.timelineStartInfo.baseMediaDecodeTime = this.baseMediaDecodeTime
          }
        }

        // hook up the video segment stream to the first track with h264 data
        if (this.videoTrack && !pipeline.videoSegmentStream) {
          pipeline.coalesceStream.numberOfTracks++
          pipeline.videoSegmentStream = new VideoSegmentStream(this.videoTrack, this.options)

          pipeline.videoSegmentStream.on('timelineStartInfo', (timelineStartInfo) => {
            // When video emits timelineStartInfo data after a flush, we forward that
            // info to the AudioSegmentStream, if it exists, because video timeline
            // data takes precedence.  Do not do this if keepOriginalTimestamps is set,
            // because this is a particularly subtle form of timestamp alteration.
            if (this.audioTrack && !this.options.keepOriginalTimestamps) {
              this.audioTrack.timelineStartInfo = timelineStartInfo
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
            if (this.audioTrack) {
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

        if (this.audioTrack && !pipeline.audioSegmentStream) {
          // hook up the audio segment stream to the first track with aac data
          pipeline.coalesceStream.numberOfTracks++
          pipeline.audioSegmentStream = new AudioSegmentStream(this.audioTrack, this.options)

          pipeline.audioSegmentStream.on('timingInfo',
            this.trigger.bind(this, 'audioTimingInfo'))
          pipeline.audioSegmentStream.on('segmentTimingInfo',
            this.trigger.bind(this, 'audioSegmentTimingInfo'))

          // Set up the final part of the audio pipeline
          pipeline.adtsStream
            .pipe(pipeline.audioSegmentStream)
            .pipe(pipeline.coalesceStream)
        }

        // emit pmt info
        this.trigger('trackinfo', {
          hasAudio: !!this.audioTrack,
          hasVideo: !!this.videoTrack,
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

    if (this.audioTrack) {
      this.audioTrack.timelineStartInfo.dts = undefined
      this.audioTrack.timelineStartInfo.pts = undefined
      trackDecodeInfo.clearDtsInfo(this.audioTrack)
      if (pipeline.audioTimestampRolloverStream) {
        pipeline.audioTimestampRolloverStream.discontinuity()
      }
    }
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
    if (this.audioTrack) {
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
      const isAac = isLikelyAacData(data)

      if (isAac && this.transmuxPipeline_.type !== 'aac') {
        this.setupAacPipeline()
      } else if (!isAac && this.transmuxPipeline_.type !== 'ts') {
        this.setupTsPipeline()
      }
      this.hasFlushed = false
    }
    this.transmuxPipeline_.headOfPipeline.push(data)
  }

  // flush any buffered data
  flush() {
    this.hasFlushed = true
    // Start at the top of the pipeline and flush all pending work
    this.transmuxPipeline_.headOfPipeline.flush()
  }

  endTimeline() {
    this.transmuxPipeline_.headOfPipeline.endTimeline()
  }

  reset() {
    if (this.transmuxPipeline_.headOfPipeline) {
      this.transmuxPipeline_.headOfPipeline.reset()
    }
  }

  // Caption data has to be reset when seeking outside buffered range
  resetCaptions() {
    if (this.transmuxPipeline_.captionStream) {
      this.transmuxPipeline_.captionStream.reset()
    }
  }

  setVideoBufferThreshold(threshold) {
    if (this.transmuxPipeline_.videoSegmentStream) {
      this.transmuxPipeline_.videoSegmentStream.setBufferThreshold(threshold)
    }
  }
}

module.exports = {
  Transmuxer: Transmuxer,
  VideoSegmentStream: VideoSegmentStream,
  AudioSegmentStream: AudioSegmentStream,
  AUDIO_PROPERTIES: AUDIO_PROPERTIES,
  VIDEO_PROPERTIES: VIDEO_PROPERTIES,
}
