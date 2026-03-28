// /api/tts.js — ElevenLabs TTS proxy (hides API key server-side)
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const API_KEY  = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam — free tier, multilingual

  if (!API_KEY) {
    return res.status(500).json({ error: 'ElevenLabs API key not configured' });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: text.slice(0, 5000),
          model_id: 'eleven_multilingual_v2', // RU + RO + EN
          voice_settings: {
            stability: 0.50,
            similarity_boost: 0.75,
            style: 0.10,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[TTS] ElevenLabs error:', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('[TTS] Server error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
