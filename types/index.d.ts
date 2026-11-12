export type VoiceMode = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'voice-chat': {
      mode: Shaped<VoiceMode>
      level: Shaped<number>
      lastHeard: Shaped<string>
      problem: Shaped<string>
    }
  }
}
