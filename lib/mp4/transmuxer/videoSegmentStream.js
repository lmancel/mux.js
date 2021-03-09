const Stream = require('../../utils/stream')
const VIDEO_PROPERTIES = require('../../constants/video-properties.js')
const trackDecodeInfo = require('../track-decode-info')
const frameUtils = require('../frame-utils')
const mp4 = require('../mp4-generator.js')

/**
 * Compare two arrays (even typed) for same-ness
 */
var arrayEquals = function(a, b) {
    var i

    if (a.length !== b.length) {
      return false
    }

    // compare the value of each element in the array
    for (i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false
      }
    }

    return true
}

const generateVideoSegmentTimingInfo = function(
    baseMediaDecodeTime,
    startDts,
    startPts,
    endDts,
    endPts,
    prependedContentDuration,
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
      prependedContentDuration,
      baseMediaDecodeTime,
    }
}

/**
 * Constructs a single-track, ISO BMFF media segment from H264 data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 * @param track {object} track metadata configuration
 * @param options {object} transmuxer options object
 * @param options.alignGopsAtEnd {boolean} If true, start from the end of the
 *        gopsToAlignWith list when attempting to align gop pts
 * @param options.keepOriginalTimestamps {boolean} If true, keep the timestamps
 *        in the source; false to adjust the first segment to start at 0.
 */
module.exports = class VideoSegmentStream extends Stream {

    constructor(track, options) {
        super()
        this.sequenceNumber = 0
        this.nalUnits = []
        this.gopsToAlignWith = []

        this.options = options || {}
        this.track = track
        this.init()

        delete track.minPTS

        this.gopCache_ = []
        this.waitForKeyFrame = true
    }

    /**
      * Constructs a ISO BMFF segment given H264 nalUnits
      * @param {Object} nalUnit A data event representing a nalUnit
      * @param {String} nalUnit.nalUnitType
      * @param {Object} nalUnit.config Properties for a mp4 track
      * @param {Uint8Array} nalUnit.data The nalUnit bytes
      * @see lib/codecs/h264.js
     **/
    push(nalUnit) {
      trackDecodeInfo.collectDtsInfo(this.track, nalUnit)

      // record the track config
      if (nalUnit.nalUnitType === 'seq_parameter_set_rbsp') {
        this.track.sps = [nalUnit.data]

        VIDEO_PROPERTIES.forEach((prop) => {
          this.track[prop] = nalUnit.config[prop]
        })
      }

      if (nalUnit.nalUnitType === 'pic_parameter_set_rbsp') {
        this.track.pps = [nalUnit.data]
      }

      // buffer video until flush() is called
      this.nalUnits.push(nalUnit)
    }

    /**
      * Pass constructed ISO BMFF track and boxes on to the
      * next stream in the pipeline
     **/
    flush() {
      var
        frames,
        gopForFusion,
        gops,
        moof,
        mdat,
        boxes,
        prependedContentDuration = 0,
        firstGop,
        lastGop

      // Throw away nalUnits at the start of the byte stream until
      // we find the first AUD
      // if first segment to send, also try to have a keyframe in
      if (this.waitForKeyFrame) {
        let firstAUD = -1
        const containsKeyFrame = this.nalUnits.some(function(nalUnit, index) {
          switch (nalUnit.nalUnitType) {
            case 'access_unit_delimiter_rbsp':
              if (firstAUD === -1) {
                firstAUD = index
              }
              break
              case 'slice_layer_without_partitioning_rbsp_idr':
                return firstAUD >= 0
          }
        })

        if (firstAUD >= 0) {
          this.nalUnits = this.nalUnits.slice(firstAUD)
        }

        if (!containsKeyFrame) {
          this.trigger('done', 'VideoSegmentStream')
          return
        }
      } else {
        while (this.nalUnits.length) {
          if (this.nalUnits[0].nalUnitType === 'access_unit_delimiter_rbsp') {
            break
          }
          this.nalUnits.shift()
        }
      }

      // Return early if no video data has been observed
      if (this.nalUnits.length === 0) {
        this.resetStream_()
        this.trigger('done', 'VideoSegmentStream')
        return
      }


      // Only pick nalus until the last AUD
      let lastIndex = 0

      for (let i = this.nalUnits.length - 1; i >= 0; i--) {
        const nalUnit = this.nalUnits[i]

        if (nalUnit.nalUnitType === 'access_unit_delimiter_rbsp') {
          lastIndex = i
          break
        }
      }

      if (lastIndex === 0) {
        this.trigger('done', 'VideoSegmentStream')
        return
      }

      const nalUnits = this.nalUnits.slice(0, lastIndex)

      // Organize the raw nal-units into arrays that represent
      // higher-level constructs such as frames and gops
      // (group-of-pictures)
      frames = frameUtils.groupNalsIntoFrames(nalUnits)
      gops = frameUtils.groupFramesIntoGops(frames)

      // If the first frame of this fragment is not a keyframe we have
      // a problem since MSE (on Chrome) requires a leading keyframe.
      //
      // We have two approaches to repairing this situation:
      // 1) GOP-FUSION:
      //    This is where we keep track of the GOPS (group-of-pictures)
      //    from previous fragments and attempt to find one that we can
      //    prepend to the current fragment in order to create a valid
      //    fragment.
      // 2) KEYFRAME-PULLING:
      //    Here we search for the first keyframe in the fragment and
      //    throw away all the frames between the start of the fragment
      //    and that keyframe. We then extend the duration and pull the
      //    PTS of the keyframe forward so that it covers the time range
      //    of the frames that were disposed of.
      //
      // #1 is far prefereable over #2 which can cause "stuttering" but
      // requires more things to be just right.

      if (this.waitForKeyFrame && !gops[0][0].keyFrame) {
        // Search for a gop for fusion from our gopCache
        gopForFusion = this.getGopForFusion_(nalUnits[0], this.track)

        if (gopForFusion) {
          // in order to provide more accurate timing information about the segment, save
          // the number of seconds prepended to the original segment due to GOP fusion
          prependedContentDuration = gopForFusion.duration

          gops.unshift(gopForFusion)
          // Adjust Gops' metadata to account for the inclusion of the
          // new gop at the beginning
          gops.byteLength += gopForFusion.byteLength
          gops.nalCount += gopForFusion.nalCount
          gops.pts = gopForFusion.pts
          gops.dts = gopForFusion.dts
          gops.duration += gopForFusion.duration
        } else {
          // If we didn't find a candidate gop fall back to keyframe-pulling
          gops = frameUtils.extendFirstKeyFrame(gops)
        }
      }
      this.waitForKeyFrame = false

      // Trim gops to align with gopsToAlignWith
      if (this.gopsToAlignWith.length) {
        var alignedGops

        if (this.options.alignGopsAtEnd) {
          alignedGops = this.alignGopsAtEnd_(gops)
        } else {
          alignedGops = this.alignGopsAtStart_(gops)
        }

        if (!alignedGops) {
          // save all the nals in the last GOP into the gop cache
          this.gopCache_.unshift({
            gop: gops.pop(),
            pps: this.track.pps,
            sps: this.track.sps,
          })

          // Keep a maximum of 6 GOPs in the cache
          this.gopCache_.length = Math.min(6, this.gopCache_.length)

          // Clear nalUnits
          this.nalUnits = this.nalUnits.slice(lastIndex)

          // return early no gops can be aligned with desired gopsToAlignWith
          this.resetStream_()
          this.trigger('done', 'VideoSegmentStream')
          return
        }

        // Some gops were trimmed. clear dts info so minSegmentDts and pts are correct
        // when recalculated before sending off to CoalesceStream
        trackDecodeInfo.clearDtsInfo(this.track)

        gops = alignedGops
      }

      trackDecodeInfo.collectDtsInfo(this.track, gops)

      // First, we have to build the index from byte locations to
      // samples (that is, frames) in the video data
      this.track.samples = frameUtils.generateSampleTable(gops)

      // Concatenate the video data and construct the mdat
      mdat = mp4.mdat(frameUtils.concatenateNalData(gops))

      this.track.baseMediaDecodeTime = trackDecodeInfo.calculateTrackBaseMediaDecodeTime(
        this.track, this.options.keepOriginalTimestamps)

      this.trigger('processedGopsInfo', gops.map(function(gop) {
        return {
          pts: gop.pts,
          dts: gop.dts,
          byteLength: gop.byteLength,
        }
      }))

      firstGop = gops[0]
      lastGop = gops[gops.length - 1]

      this.trigger(
        'segmentTimingInfo',
        generateVideoSegmentTimingInfo(
          this.track.baseMediaDecodeTime,
          firstGop.dts,
          firstGop.pts,
          lastGop.dts + lastGop.duration,
          lastGop.pts + lastGop.duration,
          prependedContentDuration))

      this.trigger('timingInfo', {
        start: gops[0].pts,
        end: gops[gops.length - 1].pts + gops[gops.length - 1].duration,
      })

      // save all the nals in the last GOP into the gop cache
      this.gopCache_.unshift({
        gop: gops.pop(),
        pps: this.track.pps,
        sps: this.track.sps,
      })

      // Keep a maximum of 6 GOPs in the cache
      this.gopCache_.length = Math.min(6, this.gopCache_.length)

      // Clear nalUnits
      this.nalUnits = this.nalUnits.slice(lastIndex)

      this.trigger('baseMediaDecodeTime', this.track.baseMediaDecodeTime)
      this.trigger('timelineStartInfo', this.track.timelineStartInfo)

      moof = mp4.moof(this.sequenceNumber, [this.track])

      // it would be great to allocate this array up front instead of
      // throwing away hundreds of media segment fragments
      boxes = new Uint8Array(moof.byteLength + mdat.byteLength)

      // Bump the sequence number for next time
      this.sequenceNumber++

      boxes.set(moof)
      boxes.set(mdat, moof.byteLength)

      this.trigger('data', {track: this.track, boxes: boxes})

      this.resetStream_()

      // Continue with the flush process now
      this.trigger('done', 'VideoSegmentStream')
    }

    reset() {
      this.waitForKeyFrame = true
      this.resetStream_()
      this.nalUnits = []
      this.gopCache_.length = 0
      this.gopsToAlignWith.length = 0
      this.trigger('reset')
    }

    resetStream_() {
      trackDecodeInfo.clearDtsInfo(this.track)
    }

    // Search for a candidate Gop for gop-fusion from the gop cache and
    // return it or return null if no good candidate was found
    getGopForFusion_(nalUnit) {
      var
        halfSecond = 45000, // Half-a-second in a 90khz clock
        allowableOverlap = 10000, // About 3 frames @ 30fps
        nearestDistance = Infinity,
        dtsDistance,
        nearestGopObj,
        currentGop,
        currentGopObj,
        i

      // Search for the GOP nearest to the beginning of this nal unit
      for (i = 0; i < this.gopCache_.length; i++) {
        currentGopObj = this.gopCache_[i]
        currentGop = currentGopObj.gop

        // Reject Gops with different SPS or PPS
        if (!(this.track.pps && arrayEquals(this.track.pps[0], currentGopObj.pps[0])) ||
            !(this.track.sps && arrayEquals(this.track.sps[0], currentGopObj.sps[0]))) {
          continue
        }

        // Reject Gops that would require a negative baseMediaDecodeTime
        if (currentGop.dts < this.track.timelineStartInfo.dts) {
          continue
        }

        // The distance between the end of the gop and the start of the nalUnit
        dtsDistance = (nalUnit.dts - currentGop.dts) - currentGop.duration

        // Only consider GOPS that start before the nal unit and end within
        // a half-second of the nal unit
        if (dtsDistance >= -allowableOverlap &&
            dtsDistance <= halfSecond) {

          // Always use the closest GOP we found if there is more than
          // one candidate
          if (!nearestGopObj ||
              nearestDistance > dtsDistance) {
            nearestGopObj = currentGopObj
            nearestDistance = dtsDistance
          }
        }
      }

      if (nearestGopObj) {
        return nearestGopObj.gop
      }
      return null
    }

    // trim gop list to the first gop found that has a matching pts with a gop in the list
    // of gopsToAlignWith starting from the START of the list
    alignGopsAtStart_(gops) {
      var alignIndex, gopIndex, align, gop, byteLength, nalCount, duration, alignedGops

      byteLength = gops.byteLength
      nalCount = gops.nalCount
      duration = gops.duration
      alignIndex = gopIndex = 0

      while (alignIndex < this.gopsToAlignWith.length && gopIndex < gops.length) {
        align = this.gopsToAlignWith[alignIndex]
        gop = gops[gopIndex]

        if (align.pts === gop.pts) {
          break
        }

        if (gop.pts > align.pts) {
          // this current gop starts after the current gop we want to align on, so increment
          // align index
          alignIndex++
          continue
        }

        // current gop starts before the current gop we want to align on. so increment gop
        // index
        gopIndex++
        byteLength -= gop.byteLength
        nalCount -= gop.nalCount
        duration -= gop.duration
      }

      if (gopIndex === 0) {
        // no gops to trim
        return gops
      }

      if (gopIndex === gops.length) {
        // all gops trimmed, skip appending all gops
        return null
      }

      alignedGops = gops.slice(gopIndex)
      alignedGops.byteLength = byteLength
      alignedGops.duration = duration
      alignedGops.nalCount = nalCount
      alignedGops.pts = alignedGops[0].pts
      alignedGops.dts = alignedGops[0].dts

      return alignedGops
    }

    // trim gop list to the first gop found that has a matching pts with a gop in the list
    // of gopsToAlignWith starting from the END of the list
    alignGopsAtEnd_(gops) {
      var alignIndex, gopIndex, align, gop, alignEndIndex, matchFound

      alignIndex = this.gopsToAlignWith.length - 1
      gopIndex = gops.length - 1
      alignEndIndex = null
      matchFound = false

      while (alignIndex >= 0 && gopIndex >= 0) {
        align = this.gopsToAlignWith[alignIndex]
        gop = gops[gopIndex]

        if (align.pts === gop.pts) {
          matchFound = true
          break
        }

        if (align.pts > gop.pts) {
          alignIndex--
          continue
        }

        if (alignIndex === this.gopsToAlignWith.length - 1) {
          // gop.pts is greater than the last alignment candidate. If no match is found
          // by the end of this loop, we still want to append gops that come after this
          // point
          alignEndIndex = gopIndex
        }

        gopIndex--
      }

      if (!matchFound && alignEndIndex === null) {
        return null
      }

      var trimIndex

      if (matchFound) {
        trimIndex = gopIndex
      } else {
        trimIndex = alignEndIndex
      }

      if (trimIndex === 0) {
        return gops
      }

      var alignedGops = gops.slice(trimIndex)
      var metadata = alignedGops.reduce(function(total, gop) {
        total.byteLength += gop.byteLength
        total.duration += gop.duration
        total.nalCount += gop.nalCount
        return total
      }, { byteLength: 0, duration: 0, nalCount: 0 })

      alignedGops.byteLength = metadata.byteLength
      alignedGops.duration = metadata.duration
      alignedGops.nalCount = metadata.nalCount
      alignedGops.pts = alignedGops[0].pts
      alignedGops.dts = alignedGops[0].dts

      return alignedGops
    }

    alignGopsWith(newGopsToAlignWith) {
      this.gopsToAlignWith = newGopsToAlignWith
    }
}
