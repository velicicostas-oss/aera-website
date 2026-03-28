/**
 * AERA — Agent 6: Ask Article Q&A
 * Vercel Serverless Function
 *
 * POST /api/ask
 * Body: { question, article_id, title, content, moldova_context, lang }
 *
 * Logic:
 *  1. Hash client IP + article_id for privacy
 *  2. Call Supabase RPC ask_article_question() — checks 3-attempt limit + logs attempt
 *  3. If allowed, call OpenAI gpt-4o-mini with article context
 *  4. Return { answer, remaining }
 *
 * Rate limit: 3 questions per IP per article (stored in ask_attempts table)
 * Required env var: OPENAI_API_KEY (set in Vercel → Settings → Environment Variables)
 */

const crypto = require('crypto');

// Supabase public credentials (already exposed in frontend HTML — not secrets)
const SUPABASE_URL = 'https://araqepkymkxktvhseeas.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WX5Bkpcd92hY-aYmkwAJqA_-ugBJu6N';

function hashIp(ip, articleId) {
  return crypto
    .createHash('sha256')
    .update(`aera:${ip}:${articleId}`)
    .digest('hex')
    .slice(0, 32);
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Validate OpenAI key
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'not_configured' });

  // Parse body
  const { question, article_id, title, content, moldova_context, lang } = req.body || {};

  if (!question || question.trim().length < 3) {
    return res.status(400).json({ error: 'too_short' });
  }
  if (!article_id) {
    return res.status(400).json({ error: 'missing_article' });
  }

  // Get and hash client IP
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const ipHash = hashIp(ip, String(article_id));

  // ── Rate limit check via Supabase RPC ──────────────────────────────────────
  let rpcResult;
  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ask_article_question`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_ip_hash: ipHash,
        p_article_id: parseInt(article_id, 10),
        p_question: question.trim().slice(0, 500),
        p_lang: (lang || 'ru').slice(0, 5),
      }),
    });
    rpcResult = await rpcRes.json();
  } catch (e) {
    console.error('[Agent6] Supabase RPC error:', e.message);
    return res.status(500).json({ error: 'db_error' });
  }

  if (!rpcResult?.allowed) {
    return res.status(429).json({ error: 'limit_reached', remaining: 0 });
  }

  // ── Build OpenAI prompt ────────────────────────────────────────────────────
  const systemPrompt = `You are AERA, a newsroom AI assistant. Help readers understand THIS specific news article only.

STRICT RULES:
1. Answer ONLY from information explicitly stated in the article text and Moldova context provided
2. Do NOT use any external knowledge — do NOT invent or assume facts not in the article
3. If the question is NOT related to this article, reply in the user's language: "I can only answer questions about this specific article."
4. If the question is offensive, spam, or completely nonsensical, reply: "Please ask a relevant question about this article."
5. Keep answers to 1–3 sentences maximum — concise and factual
6. Reply in the SAME language as the user's question (Romanian / Russian / English)
7. Tone: neutral, journalistic, no speculation`;

  const userPrompt = `ARTICLE: "${(title || '').slice(0, 200)}"

CONTENT: ${(content || '').slice(0, 2500)}

MOLDOVA CONTEXT: ${(moldova_context || 'Not available').slice(0, 600)}

USER QUESTION: ${question.trim()}`;

  // ── Call OpenAI ────────────────────────────────────────────────────────────
  let answer = '';
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 220,
        temperature: 0.2,
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.json().catch(() => ({}));
      console.error('[Agent6] OpenAI error:', err?.error?.message);
      return res.status(500).json({ error: 'ai_error' });
    }

    const aiData = await aiRes.json();
    answer = aiData.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('[Agent6] OpenAI fetch error:', e.message);
    return res.status(500).json({ error: 'ai_error' });
  }

  if (!answer) return res.status(500).json({ error: 'empty_answer' });

  return res.status(200).json({
    answer,
    remaining: rpcResult.remaining ?? 0,
  });
};
