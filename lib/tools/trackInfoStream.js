const { Transform } = require('stream')
const m2ts = require('../m2ts/m2ts')
const streamEventTypes = require('../m2ts/stream-event-types')

class TrackInfoStream extends Transform {
  constructor(broadStreamDetection = false) {
    super({ readableObjectMode: true })
    const packetStream = new m2ts.TransportPacketStream(broadStreamDetection)
    const parseStream = new m2ts.TransportParseStream()
    const elementaryStream = new m2ts.ElementaryStream()

    elementaryStream.on('data', this.onMetadata.bind(this))
    packetStream
      .pipe(parseStream)
      .pipe(elementaryStream)

    this.input = packetStream
  }

  onMetadata({ type, tracks }) {
    if (type === streamEventTypes.METADATA) {
      const audioTracks = []
      const subtitles = []
      let videoTrack

      // scan the tracks listed in the metadata
      tracks.forEach(track => {
        if (track.type === 'audio') {
          audioTracks.push(track)
        } else if (!videoTrack && track.type === 'video') {
          videoTrack = track
        } else if (track.type === 'subtitles') {
          subtitles.push(track)
        }
      })

      // emit pmt info
      this.push({
        audio: audioTracks,
        video: videoTrack,
        subtitles,
      })
    }
  }

  _transform(chunk, encoding, callback) {
    try {
      this.input.push(chunk)
      this.input.flush()
      callback(null)
    } catch (e) {
      callback(e)
    }
  }
}

module.exports = TrackInfoStream
