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
const { ProgramSpecificInformation } = require('@taktik/mpegts-tools')
const Stream = require('../utils/stream.js')
const CaptionStream = require('./caption-stream')
const { isAudioStream, isVideoStream, StreamTypes } = require('./stream-types')
const SubtitlesTypes = require('./subtitles-types')
const TimestampRolloverStream = require('./timestamp-rollover-stream').TimestampRolloverStream
const StreamEventTypes = require('./stream-event-types')

// object types
var TransportPacketStream, TransportParseStream, ElementaryStream

// constants
var
  MP2T_PACKET_LENGTH = 188, // bytes
  SYNC_BYTE = 0x47

/**
 * Splits an incoming stream of binary data into MPEG-2 Transport
 * Stream packets.
 */
TransportPacketStream = function() {
  var
    buffer = Buffer.alloc(MP2T_PACKET_LENGTH),
    bytesInBuffer = 0

  TransportPacketStream.prototype.init.call(this)

   // Deliver new bytes to the stream.

  /**
   * Split a stream of data into M2TS packets
  **/
  this.push = function(bytes) {
    var
      startIndex = 0,
      endIndex = MP2T_PACKET_LENGTH,
      everything

    // If there are bytes remaining from the last segment, prepend them to the
    // bytes that were pushed in
    if (bytesInBuffer) {
      everything = Buffer.alloc(bytes.byteLength + bytesInBuffer)
      everything.set(buffer.subarray(0, bytesInBuffer))
      everything.set(bytes, bytesInBuffer)
      bytesInBuffer = 0
    } else {
      everything = bytes
    }

    // While we have enough data for a packet
    while (endIndex < everything.byteLength) {
      // Look for a pair of start and end sync bytes in the data..
      if (everything[startIndex] === SYNC_BYTE && everything[endIndex] === SYNC_BYTE) {
        // We found a packet so emit it and jump one whole packet forward in
        // the stream
        this.trigger('data', everything.subarray(startIndex, endIndex))
        startIndex += MP2T_PACKET_LENGTH
        endIndex += MP2T_PACKET_LENGTH
        continue
      }
      // If we get here, we have somehow become de-synchronized and we need to step
      // forward one byte at a time until we find a pair of sync bytes that denote
      // a packet
      startIndex++
      endIndex++
    }

    // If there was some data left over at the end of the segment that couldn't
    // possibly be a whole packet, keep it because it might be the start of a packet
    // that continues in the next segment
    if (startIndex < everything.byteLength) {
      buffer.set(everything.subarray(startIndex), 0)
      bytesInBuffer = everything.byteLength - startIndex
    }
  }

  /**
   * Passes identified M2TS packets to the TransportParseStream to be parsed
  **/
  this.flush = function() {
    // If the buffer contains a whole packet when we are being flushed, emit it
    // and empty the buffer. Otherwise hold onto the data because it may be
    // important for decoding the next segment
    if (bytesInBuffer === MP2T_PACKET_LENGTH && buffer[0] === SYNC_BYTE) {
      this.trigger('data', buffer)
      bytesInBuffer = 0
    }
    this.trigger('done')
  }

  this.endTimeline = function() {
    this.flush()
    this.trigger('endedtimeline')
  }

  this.reset = function() {
    bytesInBuffer = 0
    this.trigger('reset')
  }
}
TransportPacketStream.prototype = new Stream()

/**
 * Accepts an MP2T TransportPacketStream and emits data events with parsed
 * forms of the individual transport stream packets.
 * @param {Boolean} broadStreamDetection Detect more video and audio stream than what can be handled afterwards
 */
TransportParseStream = function(broadStreamDetection = false) {
  let parsePsi, parsePat, parsePmt, self

  TransportParseStream.prototype.init.call(this)
  self = this

  this.packetsWaitingForPmt = []
  this.programMapTable = undefined

  const detectVideoStream = (type, esInfos) => {
    return broadStreamDetection ?
      isVideoStream(type) || esInfos.some(esInfo => esInfo.isVideo) :
      type === StreamTypes.VIDEO_H264
  }

  const detectAudioStream = (type, esInfos) => {
    return broadStreamDetection ?
      isAudioStream(type) || esInfos.some(esInfo => esInfo.isAudio) :
      type === StreamTypes.AUDIO_ADTS
  }

  parsePsi = function(payload, psi) {
    var offset = 0

    // PSI packets may be split into multiple sections and those
    // sections may be split into multiple packets. If a PSI
    // section starts in this packet, the payload_unit_start_indicator
    // will be true and the first byte of the payload will indicate
    // the offset from the current position to the start of the
    // section.
    if (psi.payloadUnitStartIndicator) {
      offset += payload[offset] + 1
    }

    if (psi.type === 'pat') {
      parsePat(payload.subarray(offset), psi)
    } else {
      parsePmt(payload, psi)
    }
  }

  parsePat = function(payload, pat) {
    pat.section_number = payload[7] // eslint-disable-line camelcase
    pat.last_section_number = payload[8] // eslint-disable-line camelcase

    // skip the PSI header and parse the first PMT entry
    self.pmtPid = (payload[10] & 0x1F) << 8 | payload[11]
    pat.pmtPid = self.pmtPid
  }

  /**
   * Parse out the relevant fields of a Program Map Table (PMT).
   * @param payload {Buffer} the PMT-specific portion of an MP2T
   * packet. The first byte in this array should be the table_id
   * field.
   * @param pmt {object} the object that should be decorated with
   * fields parsed from the PMT.
   */
  parsePmt = function(payload, pmt) {
    // PMTs can be sent ahead of the time when they should actually
    // take effect. We don't believe this should ever be the case
    // for HLS but we'll ignore "forward" PMT declarations if we see
    // them. Future PMT declarations have the current_next_indicator
    // set to zero.
    if (!(payload[6] & 0x01)) {
      return
    }

    // overwrite any existing program map table
    self.programMapTable = {
      video: null,
      audio: new Map(),
      privateData: {},
      'timed-metadata': {},
    }

    const psi = new ProgramSpecificInformation(payload)

    psi.elementaryStreams.forEach(({ type, pid, esInfos }) => {
      if (detectVideoStream(type, esInfos)) {
        if (self.programMapTable.video === null) {
          self.programMapTable.video = pid
        }
      } else if (detectAudioStream(type, esInfos)) {
        const languageDescriptor = esInfos.find(esInfo => esInfo.isIsoLang)
        const languages = languageDescriptor ? languageDescriptor.languages : []

        self.programMapTable.audio.set(pid, languages)
      } else if (type === StreamTypes.METADATA) {
        // map pid to stream type for metadata streams
        self.programMapTable['timed-metadata'][pid] = type
      } else if (type === StreamTypes.PRIVATE_DATA) {
        const subtitleDescriptor = esInfos.find(esInfo => esInfo.isSubtitling)
        const teletextDescriptor = esInfos.find(esInfo => esInfo.isTeletext)

        if (subtitleDescriptor) {
            const mainInnerData = subtitleDescriptor.innerData[0]

            if (mainInnerData) {
              self.programMapTable.privateData[pid] = {
                type: 'subtitles',
                subtitleType: SubtitlesTypes.DVB,
                language: mainInnerData.language,
              }
            }
        } else if (teletextDescriptor) {
          // TODO: implement teletext subtitles parsing (some day)
        }
      }
    })

    // record the map on the packet as well
    pmt.programMapTable = self.programMapTable
  }

  /**
   * Deliver a new MP2T packet to the next stream in the pipeline.
   */
  this.push = function(packet) {
    var
      result = {},
      offset = 4

    result.payloadUnitStartIndicator = !!(packet[1] & 0x40)

    // pid is a 13-bit field starting at the last bit of packet[1]
    result.pid = packet[1] & 0x1f
    result.pid <<= 8
    result.pid |= packet[2]

    // if an adaption field is present, its length is specified by the
    // fifth byte of the TS packet header. The adaptation field is
    // used to add stuffing to PES packets that don't fill a complete
    // TS packet, and to specify some forms of timing and control data
    // that we do not currently use.
    if (((packet[3] & 0x30) >>> 4) > 0x01) {
      offset += packet[offset] + 1
    }

    // parse the rest of the packet based on the type
    if (result.pid === 0) {
      result.type = 'pat'
      parsePsi(packet.subarray(offset), result)
      this.trigger('data', result)
    } else if (result.pid === this.pmtPid) {
      result.type = 'pmt'
      parsePsi(packet.subarray(offset), result)
      this.trigger('data', result)

      // if there are any packets waiting for a PMT to be found, process them now
      while (this.packetsWaitingForPmt.length) {
        this.processPes_.apply(this, this.packetsWaitingForPmt.shift())
      }
    } else if (this.programMapTable === undefined) {
      // When we have not seen a PMT yet, defer further processing of
      // PES packets until one has been parsed
      this.packetsWaitingForPmt.push([packet, offset, result])
    } else {
      this.processPes_(packet, offset, result)
    }
  }

  this.processPes_ = function(packet, offset, result) {
    // set the appropriate stream type
    if (result.pid === this.programMapTable.video) {
      result.streamType = StreamTypes.VIDEO_H264
    } else if (this.programMapTable.audio.has(result.pid)) {
      result.streamType = StreamTypes.AUDIO_ADTS
    } else if (this.programMapTable.privateData[result.pid]) {
      result.streamType = StreamTypes.PRIVATE_DATA
    } else {
      // if not video or audio, it is timed-metadata or unknown
      // if unknown, streamType will be undefined
      result.streamType = this.programMapTable['timed-metadata'][result.pid]
    }

    result.type = 'pes'
    result.data = packet.subarray(offset)
    this.trigger('data', result)
  }

  this.reset = function() {
    this.programMapTable = undefined
    TransportParseStream.prototype.reset.call(this)
  }
}
TransportParseStream.prototype = new Stream()
TransportParseStream.STREAM_TYPES = {
  h264: 0x1b,
  adts: 0x0f,
}

/**
 * Reconsistutes program elementary stream (PES) packets from parsed
 * transport stream packets. That is, if you pipe an
 * mp2t.TransportParseStream into a mp2t.ElementaryStream, the output
 * events will be events which capture the bytes for individual PES
 * packets plus relevant metadata that has been extracted from the
 * container.
 */
ElementaryStream = function() {
  const defaultStream = () => {
    return { data: [], size: 0 }
  }

  var
    self = this,
    // PES packet fragments
    video = defaultStream(),
    audio = {},
    subtitles = {},
    timedMetadata = defaultStream(),
    programMapTable,
    parsePes = function(payload, pes) {
      const startPrefix = payload[0] << 16 | payload[1] << 8 | payload[2]

      // default to an empty array
      pes.data = Buffer.alloc(0)
      // In certain live streams, the start of a TS fragment has ts packets
      // that are frame data that is continuing from the previous fragment. This
      // is to check that the pes data is the start of a new pes payload
      if (startPrefix !== 1) {
        return
      }
      // get the packet length, this will be 0 for video
      pes.packetLength = 6 + ((payload[4] << 8) | payload[5])

      // find out if this packets starts a new keyframe
      pes.dataAlignmentIndicator = (payload[6] & 0x04) !== 0
      // PES packets may be annotated with a PTS value, or a PTS value
      // and a DTS value. Determine what combination of values is
      // available to work with.
      const ptsDtsFlags = payload[7]

      // PTS and DTS are normally stored as a 33-bit number.  Javascript
      // performs all bitwise operations on 32-bit integers but javascript
      // supports a much greater range (52-bits) of integer using standard
      // mathematical operations.
      // We construct a 31-bit value using bitwise operators over the 31
      // most significant bits and then multiply by 4 (equal to a left-shift
      // of 2) before we add the final 2 least significant bits of the
      // timestamp (equal to an OR.)
      if (ptsDtsFlags & 0xC0) {
        // the PTS and DTS are not written out directly. For information
        // on how they are encoded, see
        // http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
        pes.pts = (payload[9] & 0x0E) << 27 |
          (payload[10] & 0xFF) << 20 |
          (payload[11] & 0xFE) << 12 |
          (payload[12] & 0xFF) << 5 |
          (payload[13] & 0xFE) >>> 3
        pes.pts *= 4 // Left shift by 2
        pes.pts += (payload[13] & 0x06) >>> 1 // OR by the two LSBs
        pes.dts = pes.pts
        if (ptsDtsFlags & 0x40) {
          pes.dts = (payload[14] & 0x0E) << 27 |
            (payload[15] & 0xFF) << 20 |
            (payload[16] & 0xFE) << 12 |
            (payload[17] & 0xFF) << 5 |
            (payload[18] & 0xFE) >>> 3
          pes.dts *= 4 // Left shift by 2
          pes.dts += (payload[18] & 0x06) >>> 1 // OR by the two LSBs
        }
      }
      // the data section starts immediately after the PES header.
      // pes_header_data_length specifies the number of header bytes
      // that follow the last byte of the field.
      pes.data = payload.subarray(9 + payload[8])
    },
    /**
      * Pass completely parsed PES packets to the next stream in the pipeline
     **/
    flushStream = function(stream, type, forceFlush) {
      var
        packetData = Buffer.alloc(stream.size),
        event = {
          type: type,
        },
        i = 0,
        offset = 0,
        packetFlushable = false,
        fragment

      // do nothing if there is not enough buffered data for a complete
      // PES header
      if (!stream.data.length || stream.size < 9) {
        return
      }
      event.trackId = stream.data[0].pid

      // reassemble the packet
      for (i = 0; i < stream.data.length; i++) {
        fragment = stream.data[i]

        packetData.set(fragment.data, offset)
        offset += fragment.data.byteLength
      }

      // parse assembled packet's PES header
      parsePes(packetData, event)

      // non-video PES packets MUST have a non-zero PES_packet_length
      // check that there is enough stream data to fill the packet
      packetFlushable = type === StreamEventTypes.VIDEO || event.packetLength <= stream.size

      // flush pending packets if the conditions are right
      if (forceFlush || packetFlushable) {
        stream.size = 0
        stream.data.length = 0
      }

      // only emit packets that are complete. this is to avoid assembling
      // incomplete PES packets due to poor segmentation
      if (packetFlushable) {
        self.trigger('data', event)
      }
    }

  ElementaryStream.prototype.init.call(this)

  /**
   * Identifies M2TS packet types and parses PES packets using metadata
   * parsed from the PMT
   **/
  this.push = function(data) {
    ({
      pat: function() {
        // we have to wait for the PMT to arrive as well before we
        // have any meaningful metadata
      },
      pes: function() {
        var stream, streamType

        switch (data.streamType) {
        case StreamTypes.VIDEO_H264:
          stream = video
          streamType = StreamEventTypes.VIDEO
          break
        case StreamTypes.AUDIO_ADTS:
          stream = audio[data.pid] || (audio[data.pid] = defaultStream())
          streamType = StreamEventTypes.AUDIO
          break
        case StreamTypes.METADATA:
          stream = timedMetadata
          streamType = StreamEventTypes.TIMED_METADATA
          break
        // case StreamTypes.PRIVATE_DATA:
        //   stream = subtitles[data.pid] || (subtitles[data.pid] = defaultStream())
        //   streamType = StreamEventTypes.SUBTITLES
        //   break
        default:
          // ignore unknown stream types
          return
        }

        // if a new packet is starting, we can flush the completed
        // packet
        if (data.payloadUnitStartIndicator) {
          flushStream(stream, streamType, true)
        }

        // buffer this fragment until we are sure we've received the
        // complete payload
        stream.data.push(data)
        stream.size += data.data.byteLength
      },
      pmt: function() {
        var
          event = {
            type: StreamEventTypes.METADATA,
            tracks: [],
          }

        programMapTable = data.programMapTable

        // translate audio and video streams to tracks
        if (programMapTable.video !== null) {
          event.tracks.push({
            timelineStartInfo: {
              baseMediaDecodeTime: 0,
            },
            pid: +programMapTable.video,
            codec: 'avc',
            type: 'video',
          })
        }
        if (programMapTable.audio.size) {
          programMapTable.audio.forEach((languages, pid) => {
            event.tracks.push({
              timelineStartInfo: {
                baseMediaDecodeTime: 0,
              },
              pid: +pid,
              languages,
              codec: 'adts',
              type: 'audio',
            })
          })
        }
        if (programMapTable.privateData) {
          Object.entries(programMapTable.privateData).forEach(([pid, { type, language }]) => {
            event.tracks.push({ type, pid, code: language })
          })
        }

        self.trigger('data', event)
      },
    })[data.type]()
  }

  this.reset = function() {
    video.size = 0
    video.data.length = 0
    audio = {}
    this.trigger('reset')
  }

  /**
   * Flush any remaining input. Video PES packets may be of variable
   * length. Normally, the start of a new video packet can trigger the
   * finalization of the previous packet. That is not possible if no
   * more video is forthcoming, however. In that case, some other
   * mechanism (like the end of the file) has to be employed. When it is
   * clear that no additional data is forthcoming, calling this method
   * will flush the buffered packets.
   */
  this.flushStreams_ = function() {
    // !!THIS ORDER IS IMPORTANT!!
    // video first then audio
    flushStream(video, StreamEventTypes.VIDEO)
    Object.values(audio).forEach(stream => flushStream(stream, StreamEventTypes.AUDIO))
    Object.values(subtitles).forEach(stream => flushStream(stream, StreamEventTypes.SUBTITLES))
    flushStream(timedMetadata, StreamEventTypes.TIMED_METADATA)
  }

  this.flush = function() {
    this.trigger('done')
  }
}

ElementaryStream.prototype = new Stream()

const m2ts = {
  PAT_PID: 0x0000,
  MP2T_PACKET_LENGTH: MP2T_PACKET_LENGTH,
  TransportPacketStream: TransportPacketStream,
  TransportParseStream: TransportParseStream,
  ElementaryStream: ElementaryStream,
  TimestampRolloverStream: TimestampRolloverStream,
  CaptionStream: CaptionStream.CaptionStream,
  Cea608Stream: CaptionStream.Cea608Stream,
  Cea708Stream: CaptionStream.Cea708Stream,
  MetadataStream: require('./metadata-stream'),
}

for (let type in StreamTypes) {
  if (StreamTypes.hasOwnProperty(type)) {
    m2ts[type] = StreamTypes[type]
  }
}

module.exports = m2ts
