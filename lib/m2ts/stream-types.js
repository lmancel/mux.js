/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
'use strict'

/**
 * Information retrieved from:
 *  - https://ecee.colorado.edu/~ecen5653/ecen5653/papers/iso13818-1.pdf
 *  - https://docs.microsoft.com/en-us/previous-versions/windows/desktop/mstv/mpeg2streamtype
 *  - https://gstreamer.freedesktop.org/documentation/mpegts/gstmpegtssection.html?gi-language=c#GstMpegtsStreamType
 *  - https://gstreamer.freedesktop.org/documentation/mpegts/gst-atsc-section.html?gi-language=c#GstMpegtsATSCStreamType
 */
const StreamTypes = {
  VIDEO_MPEG1: 0x01,
  VIDEO_MPEG2: 0x02,
  AUDIO_MPEG1: 0x03,
  AUDIO_MPEG2: 0x04,
  PRIVATE_DATA: 0x06,
  AUDIO_ADTS: 0x0F,
  AUDIO_LATM: 0x11,
  METADATA: 0x15,
  VIDEO_H264: 0x1B,
  AUDIO_AAC: 0x1C,
  VIDEO_RVC: 30,
  VIDEO_H264_SVC: 31,
  VIDEO_H264_MVC: 32,
  VIDEO_JP2K: 33,
  VIDEO_MPEG2_STEREO: 34,
  VIDEO_H264_STEREO: 35,
  VIDEO_HEVC: 36,
  VIDEO_ISO_14496: 0x28,
  VIDEO_ISO_15444: 0x32,
  VIDEO_ATSC_DCII: 128,
  AUDIO_ATSC_AC3: 129,
  SUBTITLING_ATSC: 130,
  AUDIO_ATSC_EAC3: 135,
  AUDIO_ATSC_DTS_HD: 136,
}

const isAudioStream = function(streamType) {
  return [
    StreamTypes.AUDIO_MPEG1,
    StreamTypes.AUDIO_MPEG2,
    StreamTypes.AUDIO_ADTS,
    StreamTypes.AUDIO_LATM,
    StreamTypes.AUDIO_AAC,
    StreamTypes.AUDIO_ATSC_AC3,
    StreamTypes.AUDIO_ATSC_EAC3,
    StreamTypes.AUDIO_ATSC_DTS_HD,
  ].includes(streamType)
}

const isVideoStream = function(streamType) {
  return [
    StreamTypes.VIDEO_MPEG1,
    StreamTypes.VIDEO_MPEG2,
    StreamTypes.VIDEO_H264,
    StreamTypes.VIDEO_RVC,
    StreamTypes.VIDEO_H264_SVC,
    StreamTypes.VIDEO_H264_MVC,
    StreamTypes.VIDEO_JP2K,
    StreamTypes.VIDEO_MPEG2_STEREO,
    StreamTypes.VIDEO_H264_STEREO,
    StreamTypes.VIDEO_HEVC,
    StreamTypes.VIDEO_ISO_14496,
    StreamTypes.VIDEO_ISO_15444,
    StreamTypes.VIDEO_ATSC_DCII,
  ].includes(streamType)
}

module.exports = {
  StreamTypes,
  isAudioStream,
  isVideoStream,
}
