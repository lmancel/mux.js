declare module '@taktik/mux.js' {
  import { Stream, Transform } from 'stream'
  interface ITools {
    inspect(data: Buffer): any
    findBox(data: Buffer, boxes: string[]): Buffer[]
  }

  interface ITrackMetadata {
    id: number
    type: string
    codec?: string
    timescale?: number
  }

  interface IOutputTrack<T extends 'audio' | 'video'> {
    initSegment?: Buffer
    data: Buffer
    type: T
    codec: string
    pid: number
  }

  interface ITransmuxerOutput {
    type: 'combined'
    audio: IOutputTrack<'audio'>[]
    video: IOutputTrack<'video'>
  }

  interface ITrack {
    id?: number
    type?: string
    codec?: string
    timescale?: number
  }

  type TrackInfo = {
    audio: { codec: string, pid: number, languages: { code: string }[], type: 'audio' }[]
    video: { type: 'video', pid: number, codec: string } | undefined
    subtitles: { type: 'subtitles', pid: number, code: string }[]
  }
  interface IAudioTrackLanguage {
    code: string
    type: number
  }

  interface IAudioTrack {
    id: number
    type: 'audio'
    codec: string
    languages: IAudioTrackLanguage[]
  }
  interface ITransmuxerOptions {
    baseMediaDecodeTime?: number
    keepOriginalTimestamps?: boolean
    remux?: boolean
  }

  class Transmuxer extends Stream {
    constructor (options?: ITransmuxerOptions)
    baseMediaDecodeTime: number
    headOfPipeline?: Stream
    audioTracks: IAudioTrack[]
    setupAacPipeline: () => void
    setupTsPipeline: () => void
    setBaseMediaDecodeTime: (baseMediaDecodeTime: number) => void
    setAudioAppendStart: (timestamp: number) => void
    setRemux: (val: any) => void
    alignGopsWith: (gopsToAlignWith: any) => void
    push: (data: any) => void
    flush: () => void
    endTimeline: () => void
    reset: () => void
    resetCaptions: () => void
    setAudioTrackFromPid: (pid: number) => void
    canFlush(): boolean
  }
  export class TrackInfoStream extends Transform {
    constructor(broadStreamDetection: boolean = false)
  }

  export const mp4: { Transmuxer: typeof Transmuxer, tools: ITools, probe: { tracks: (initSegment: Buffer) => ITrack[] } }
}
