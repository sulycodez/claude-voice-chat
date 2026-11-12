# Voice Chat for Claude Code

Talk to Claude Code hands-free. Say your prompt, and Claude reads its reply out loud.

- 🎙️ **Speech in:** local [Whisper](https://github.com/SYSTRAN/faster-whisper) (`base.en`) runs on your own machine. Your audio never leaves your PC.
- 🔊 **Speech out:** replies are read aloud by the Windows voice. Code blocks are skipped, and long answers are cut short with "the rest is on screen".
- 🔁 **Turn-taking:** listening pauses while Claude thinks and speaks, then resumes, so it never hears itself.
- 📊 **Status band** above the prompt shows the current state, a mic level meter, and the last thing it heard.

## Requirements

- Windows (spoken replies use Windows' built-in System.Speech)
- Python 3.9+ on your `PATH` as `python`
- The Python packages:

```bash
pip install faster-whisper sounddevice numpy
```

The first time you turn it on, Whisper downloads the `base.en` model (about 150 MB).

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
| `/voice-chat off` | Stop listening and release the mic. |
| `/voice-chat` | Toggle. |

Pause for about a second when you finish a sentence, and what you said is sent as your prompt.

## Notes

- Anything the mic picks up while it's listening is sent, a TV or another person included. Turn it off when you aren't using it.
- It uses the Windows default recording device.
- The listener runs as a small local server on `127.0.0.1:47821`. It exits by itself about 20 seconds after Claude Code stops checking on it.
- If something goes wrong, check `scripts/listener.log` in the plugin folder.
