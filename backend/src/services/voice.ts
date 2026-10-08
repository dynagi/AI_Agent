import { env } from '../config/env.js';

/**
 * VoiceService abstraction — providers are swappable without touching callers.
 * Gemini is the default; ElevenLabs stays available behind the same
 * interface, and Vapi can be added the same way later.
 */
export interface VoiceProvider {
  contentType: string;
  textToSpeech(text: string, voiceId?: string): Promise<Buffer>;
}

/** Wraps Gemini's raw 16-bit PCM (24kHz mono, no container) in a minimal WAV header. */
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

class GeminiProvider implements VoiceProvider {
  contentType = 'audio/wav';
  private apiKey = env.geminiApiKey;

  async textToSpeech(text: string, voiceId?: string): Promise<Buffer> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    const voiceName = voiceId ?? env.geminiVoiceName;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiTtsModel}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini TTS failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as any;
    const base64Pcm = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Pcm) {
      throw new Error(`Unexpected Gemini TTS response shape: ${JSON.stringify(data)}`);
    }

    return pcmToWav(Buffer.from(base64Pcm, 'base64'));
  }
}

class ElevenLabsProvider implements VoiceProvider {
  contentType = 'audio/mpeg';
  private apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  private defaultVoiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';

  async textToSpeech(text: string, voiceId?: string): Promise<Buffer> {
    if (!this.apiKey) {
      throw new Error('ELEVENLABS_API_KEY is not configured.');
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId ?? this.defaultVoiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

function buildVoiceService(): VoiceProvider {
  return env.voiceProvider === 'elevenlabs' ? new ElevenLabsProvider() : new GeminiProvider();
}

export const voiceService: VoiceProvider = buildVoiceService();
