# 0005 — Telegram voice notes: whisper.cpp + Piper in the container
**Context.** Matthew wants voice notes both ways on Telegram, without paid speech APIs.
**Decision.** The Docker image gains whisper.cpp (CPU, `base.en`) and Piper TTS (one British male voice) plus ffmpeg. Incoming voice notes (OGG/Opus) → ffmpeg → whisper → brain; replies are sent as text plus a voice note (Piper WAV → OGG/Opus). Built in a separate Docker stage; models fetched at build time.
**Consequences.** Image grows ~300 MB; mem_limit stays 1 GB (whisper base uses ~200 MB briefly). Transcription ~2–4 s per 10 s note on a laptop CPU.
