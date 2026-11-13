export type VoiceMode = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error'
export type VoiceSpeed = 'auto' | 'quick' | 'balanced' | 'thorough'

declare module 'claude-code' {
  interface PluginState {
    'voice-chat': {
      mode: Shaped<VoiceMode>
      level: Shaped<number>
      lastHeard: Shaped<string>
      problem: Shaped<string>
      speed: Shaped<VoiceSpeed>
      effortNow: Shaped<string>
    }
  }
}
