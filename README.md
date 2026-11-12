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
| `/voice-chat off` | Stop listening and release the mic. |
| `/voice-chat` | Toggle. |

When you stop talking for about a second and a half, what you said is sent as your prompt. A shorter pause to think doesn't cut you off: keep going and it's all sent together.

You can type at any time. A typed prompt stops the mic until its reply is done.

## Notes

- Anything the mic picks up while it's listening is sent, a TV or another person included. Turn it off when you aren't using it.
- It uses the Windows default recording device. If the mic is unplugged or another app takes it, the status band says so; run `/voice-chat on` again once it's back.
- A prompt of only "thank you", "bye" or "um" is ignored, because Whisper invents those from background noise.
- Whisper runs on your CPU, so while something heavy is running (a video render, a game) replies take longer to be heard.
- The listener runs as a small local server on `127.0.0.1:47821`. It exits by itself about 20 seconds after Claude Code stops checking on it.
- If something goes wrong, the status band says what (a missing package, no Python), and `scripts/listener.log` in the plugin folder has the details.
- Run the plugin's tests with `claude plugin test <plugin folder>`.
