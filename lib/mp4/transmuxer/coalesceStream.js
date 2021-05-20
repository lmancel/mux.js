const Stream = require('../../utils/stream.js')
const AUDIO_PROPERTIES = require('../../constants/audio-properties.js')
const VIDEO_PROPERTIES = require('../../constants/video-properties.js')
const clock = require('../../utils/clock')
const mp4 = require('../mp4-generator.js')
const { getTrackCodec, tracks: getTracks } = require('../probe.js')
const findBox = require('../find-box.js')
const TRACK_TYPE = {
    AUDIO: 'audio',
    INIT_SEGMENT: 'initSegment',
    VIDEO: 'video',
}

/**
* A Stream that can combine multiple streams (ie. audio & video)
* into a single output segment for MSE. Also supports audio-only
* and video-only streams.
* @param options {object} transmuxer options object
* @param options.keepOriginalTimestamps {boolean} If true, keep the timestamps
*      in the source; false to adjust the first segment to start at media timeline start.
*/
module.exports = class extends Stream {
    constructor(options, metadataStream) {
        super()
        options = options || {}
        this.metadataStream = metadataStream

        if (typeof options.remux !== 'undefined') {
            this.remuxTracks = !!options.remux
        } else {
            this.remuxTracks = true
        }

        if (typeof options.keepOriginalTimestamps === 'boolean') {
            this.keepOriginalTimestamps = options.keepOriginalTimestamps
        } else {
            this.keepOriginalTimestamps = false
        }

        // Number of Tracks per output segment
        // If greater than 1, we combine multiple
        // tracks into a single segment
        this.trackIds = new Set()
        this.videoTrack = null
        this.audioTracksByPid = {}
        this.pendingCaptions = []
        this.pendingMetadata = []
        this.emittedTracks = 0

        this.trackData = []
        this.bufferedTrackIds = new Set()

        this.init()
    }

    // Take output from multiple
    push(output) {
        // buffer incoming captions until the associated video segment
        // finishes
        if (output.text) {
            return this.pendingCaptions.push(output)
        }
        // buffer incoming id3 tags until the final flush
        if (output.frames) {
            return this.pendingMetadata.push(output)
        }

        // Add this track to the list of pending tracks and store
        // important information required for the construction of
        // the final segment

        const { track, boxes } = output

        this.trackData.push({ track, boxes })
        this.bufferedTrackIds.add(track.pid)

        if (track.type === 'video') {
            this.videoTrack = track
        }
        if (track.type === 'audio') {
            this.audioTracksByPid[track.pid] = track
        }
    }

    flush(flushSource) {
        if (this.bufferedTrackIds.size < this.trackIds.size) {
            if (flushSource !== 'VideoSegmentStream' &&
            flushSource !== 'AudioSegmentStream') {
                // Return because we haven't received a flush from a data-generating
                // portion of the segment (meaning that we have only recieved meta-data
                // or captions.)
                return
            } else if (this.remuxTracks) {
                // Return until we have enough tracks from the pipeline to remux (if we
                // are remuxing audio and video into a single MP4)
                return
            } else if (this.trackData.length === 0) {
                // In the case where we receive a flush without any data having been
                // received we consider it an emitted track for the purposes of coalescing
                // `done` events.
                // We do this for the case where there is an audio and video track in the
                // segment but no audio data. (seen in several playlists with alternate
                // audio tracks and no audio present in the main TS segments.)
                this.emittedTracks++

                if (this.emittedTracks >= this.trackIds.size) {
                    this.trigger('done')
                    this.emittedTracks = 0
                }
                return
            }
        }

        let timelineStartPts = 0
        const audioTracks = Object.values(this.audioTracksByPid)

        if (this.videoTrack) {
            timelineStartPts = this.videoTrack.timelineStartInfo.pts
        } else if (audioTracks.length) {
            timelineStartPts = audioTracks[0].timelineStartInfo.pts
        }

        if (this.trackData.length) {
            this.groupSendTracks(this.trackData)
            // this.sendTracksData(this.trackData)

            // Reset stream state
            this.trackData.length = 0
            this.bufferedTrackIds.clear()
            this.videoTrack = null
            this.audioTracksByPid = {}

            // Emit each caption to the outside world
            // Ideally, this would happen immediately on parsing captions,
            // but we need to ensure that video data is sent back first
            // so that caption timing can be adjusted to match video timing
            for (let i = 0; i < this.pendingCaptions.length; i++) {
                const caption = this.pendingCaptions[i]

                caption.startTime = clock.metadataTsToSeconds(
                    caption.startPts, timelineStartPts, this.keepOriginalTimestamps)
                caption.endTime = clock.metadataTsToSeconds(
                    caption.endPts, timelineStartPts, this.keepOriginalTimestamps)

                this.trigger('caption', caption)
            }
            this.pendingCaptions.length = 0

            // Translate ID3 frame PTS times into second offsets to match the
            // video timeline for the segment
            // Emit each id3 tag to the outside world
            // Ideally, this would happen immediately on parsing the tag,
            // but we need to ensure that video data is sent back first
            // so that ID3 frame timing can be adjusted to match video timing
            for (let i = 0; i < this.pendingMetadata.length; i++) {
                const id3 = this.pendingMetadata[i]

                id3.cueTime = clock.metadataTsToSeconds(
                    id3.pts, timelineStartPts, this.keepOriginalTimestamps)
                this.trigger('id3Frame', id3)
            }
            this.pendingMetadata.length = 0
        }

        // Only emit `done` if all tracks have been flushed and emitted
        if (this.emittedTracks >= this.trackIds.size) {
            this.trigger('done')
            this.emittedTracks = 0
        }
    }

    findTrackCodec(initSegment) {
      const traks = findBox(initSegment, ['moov', 'trak'])

      for (let i = 0; i < traks.length; i++) {
        const trakCodec = getTrackCodec(traks[i])

        if (trakCodec) {
          return trakCodec
        }
      }
    }

    groupSendTracks(tracksData) {
      const tracks = []
      const audio = this.audioTracksByPid[this.currentAudioPid]

      if (audio) {
        tracks.push(audio)
      }
      const video = this.videoTrack

      if (video) {
        tracks.push(video)
      }

      if (!tracks.length) {
        // like waaaat ?
        throw Error('No track to merge, something\'s wrong.')
      }
      let bytes = 0
      const tracksDataToKeep = tracksData.filter(({ track, boxes }) => {
        if (track.type === 'video' || (track.type === 'audio' && track.pid === this.currentAudioPid)) {
          bytes += boxes.byteLength
          return true
        }
      })

      if (bytes === 0) {
        // like waaaat ?
        throw Error('No bytes buffered, something\'s wrong.')
      }

      const data = Buffer.alloc(bytes)
      const type = video ? 'video' : 'audio'
      const initSegment = mp4.initSegment(tracks)
      const traks = getTracks(initSegment)
      const codec = traks.reduce((cc, t) => cc ? `${cc},${t.codec}` : t.codec, '')

      let offset = 0

      tracksDataToKeep.forEach(({ boxes }) => {
        data.set(boxes, offset)
        offset += boxes.byteLength
      })

      const event = {
        initSegment,
        data,
        type,
        codec,
        pid: this.currentAudioPid,
      }

      this.trigger('data', event)
      this.emittedTracks = this.trackIds.size
    }

    buildTrackData({track, boxes}) {
      // Create an init segment containing a moov
      // and track definitions
      const initSegment = mp4.initSegment([track])
      const info = {}

      if (track.type === TRACK_TYPE.VIDEO) {
        VIDEO_PROPERTIES.forEach(function(prop) {
              info[prop] = this.videoTrack[prop]
          }, this)
      } else if (track.type === TRACK_TYPE.AUDIO) {
          AUDIO_PROPERTIES.forEach(function(prop) {
              info[prop] = this.audioTracksByPid[track.pid][prop]
          }, this)
      }

      // Create a new typed array to hold the data
      const data = Buffer.alloc(boxes.byteLength)

      data.set(boxes)

      return {
          pid: track.pid,
          type: track.type,
          info,
          initSegment,
          data,
          metadata: {
            // We add this to every single emitted segment even though we only need
            // it for the first
            dispatchType: this.metadataStream.dispatchType,
          },
          codec: this.findTrackCodec(initSegment),
      }
    }

    sendTracksData(tracksData) {
      const combinedEvent = {
        type: 'separated',
        audio: [],
        video: undefined,
      }

      tracksData.forEach(trackData => {
        const builtTrack = this.buildTrackData(trackData)

        if (trackData.track.type === 'audio') {
          combinedEvent.audio.push(builtTrack)
        } else if (trackData.track.type === 'video') {
          combinedEvent.video = builtTrack
        }
      })

      // Emit the built segment
      this.trigger('data', combinedEvent)
      this.emittedTracks += tracksData.length
    }

    setRemux(val) {
      this.remuxTracks = val
    }

    reset(flushSource) {
      this.trackIds.clear()
      super.reset(flushSource)
    }

    addTrack(type, pid) {
      this.trackIds.add(`${type}-${pid}`)

      if (type === 'audio') {
        this.currentAudioPid = this.currentAudioPid ?
          Math.min(this.currentAudioPid, pid) : pid
      }
    }
}
