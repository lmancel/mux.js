declare module '@taktik/mux.js' {
  import { Stream } from 'stream'

  interface ITransmuxerOptions {
    baseMediaDecodeTime?: number
    keepOriginalTimestamps?: boolean
    remux?: boolean
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

  interface ITools {
    inspect: (data: Buffer) => any
  }

  export interface ITrackMetadata {
    id: number
    type: string
    codec?: string
    timescale?: number
  }

  interface IOutputTrack<T extends 'audio' | 'video'> {
    initSegment: Buffer
    metadata: ITrackMetadata[]
    data: Buffer
    type: T
  }

  export interface ITransmuxerOutput {
    type: 'combined'
    audio: IOutputTrack<'audio'>[]
    video: IOutputTrack<'video'>
  }

  export interface ITrack {
    id?: number
    type?: string
    codec?: string
    timescale?: number
  }

  export type TrackInfo = {
    audio: { codec: string, pid: number, languages: { code: string, type: number }[], type: 'audio' }[]
    video: { type: 'video', pid: number, codec: string } | undefined
    subtitles: { type: 'subtitles', pid: number, code: string }[]
  }

  export const mp4: { Transmuxer: typeof Transmuxer, tools: ITools, probe: { tracks: (initSegment: Buffer) => ITrack[] } }
}
