# Voice Chat for Claude Code

Talk to Claude Code hands-free. Say your prompt, and Claude reads its reply out loud.

- 🎙️ **Speech in:** local [Whisper](https://github.com/SYSTRAN/faster-whisper) (`base.en`) runs on your own machine. Your audio never leaves your PC.
- 🔊 **Speech out:** replies are read aloud in a natural voice ([Piper](https://github.com/OHF-Voice/piper1-gpl) with the Jenny (Dioco) voice, also running locally). Code blocks are skipped, and long answers are cut short with "the rest is on screen".
- ✋ **Cut in any time:** talk over a reply and it stops, and what you said becomes your next prompt. Saying just "stop" stops it. Typing anything stops it too. It tells your voice from its own echo, so it never interrupts itself.
- 📊 **Status band** above the prompt shows the current state, a mic level meter, and the last thing it heard.

## Requirements

- Windows
- Python 3.9+ on your `PATH` as `python`
- The Python packages:

```bash
pip install faster-whisper sounddevice numpy piper-tts
```

The first time you turn it on, Whisper downloads the `base.en` model (about 150 MB) and the Jenny voice downloads in the background (about 63 MB). The Windows voice reads replies until Jenny is ready.

- Plugin hooks modules turned on. They are an early-access Claude Code feature, and without this the plugin installs but does nothing. Run this once, then restart Claude Code:

```bash
setx CLAUDE_CODE_ENABLE_FUNCTION_HOOKS 1
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install voice-chat --marketplace sulycodez/claude-voice-chat
```

Answer `y` to add the marketplace, then pick a scope (user scope is the first option).

From a shell:

```bash
claude plugin install voice-chat --marketplace sulycodez/claude-voice-chat
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `sulycodez/claude-voice-chat`, then **Add plugin**.

## Use

| Command | What it does |
| --- | --- |
| `/voice-chat on` | Start the mic listener. When the band shows **Listening**, just talk. |
| `/voice-chat stop` | Cut the reply being read out short and listen. |
| `/voice-chat off` | Stop listening and release the mic. |
| `/voice-chat` | Toggle. |

When you stop talking for about a second and a half, what you said is sent as your prompt. A shorter pause to think doesn't cut you off: keep going and it's all sent together.

You can type at any time. A typed prompt stops any reply being read out, and the mic waits until its own reply is done.

To cut in by voice, just talk over the reply, as early as you like: it starts listening for you about a second and a half in, keeps what you said from before that, and sends it all as your next prompt. It tells you apart from its own voice by checking whether the mic is following what it plays, so it never cuts itself off. On a laptop or headset mic that cancels echo (most do), a normal voice is enough. With loud speakers and a plain mic you need to be clearly louder than the speakers, or type or use `/voice-chat stop` instead.

## Notes

- Anything the mic picks up while it's listening is sent, a TV or another person included. Turn it off when you aren't using it.
- It uses the Windows default recording device. If the mic is unplugged or another app takes it, the status band says so; run `/voice-chat on` again once it's back.
- A prompt of only "thank you", "bye" or "um" is ignored, because Whisper invents those from background noise.
- Whisper runs on your CPU, so while something heavy is running (a video render, a game) replies take longer to be heard.
- The listener runs as a small local server on `127.0.0.1:47821`. It exits by itself about 20 seconds after Claude Code stops checking on it.
- If something goes wrong, the status band says what (a missing package, no Python), and `scripts/listener.log` in the plugin folder has the details.
- Run the plugin's tests with `claude plugin test <plugin folder>`.

## Credits

- Speech in: [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
- Speech out: [Piper](https://github.com/OHF-Voice/piper1-gpl), installed separately, with the voice **Jenny (Dioco)** from the [Jenny TTS dataset](https://github.com/dioco-group/jenny-tts-dataset).
