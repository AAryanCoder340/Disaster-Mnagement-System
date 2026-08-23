const { Buffer } = require('buffer');

const LABEL_TO_DISASTER = [
  { label: 'flood', aliases: ['flood', 'flood water', 'flooding', 'water', 'rain flood', 'inundation'], types: ['flood'] },
  { label: 'fire', aliases: ['fire', 'flame', 'flames', 'burning', 'wildfire', 'bushfire', 'smoke'], types: ['fire', 'wildfire'] },
  { label: 'structural_damage', aliases: ['damage', 'structural damage', 'collapsed', 'collapse', 'rubble', 'debris', 'destroyed'], types: ['landslide', 'earthquake', 'storm'] },
  { label: 'storm', aliases: ['storm', 'cyclone', 'hurricane', 'typhoon', 'tornado', 'wind damage', 'fallen tree', 'uprooted'], types: ['storm', 'cyclone'] },
  { label: 'landslide', aliases: ['landslide', 'mudslide', 'mudflow', 'debris flow'], types: ['landslide'] },
  { label: 'earthquake', aliases: ['earthquake', 'quake', 'cracked building', 'cracked road'], types: ['earthquake'] },
  { label: 'tsunami', aliases: ['tsunami', 'wave'], types: ['tsunami', 'storm'] },
  { label: 'cyclone', aliases: ['cyclone'], types: ['cyclone', 'storm'] }
];

const SUPPORTED_DISASTER_TYPES = new Set(
  LABEL_TO_DISASTER.flatMap((r) => r.types)
);

function normalizeDisasterType(type) {
  const t = String(type || '').toLowerCase().trim();
  if (SUPPORTED_DISASTER_TYPES.has(t)) return t;
  const alias = LABEL_TO_DISASTER.find((r) => r.aliases.includes(t) || r.label === t);
  return alias ? alias.types[0] : t;
}

function typeMatchesLabel(type, rule) {
  const norm = normalizeDisasterType(type);
  return rule.types.includes(norm);
}

function detectLabelRuleForType(type) {
  const norm = normalizeDisasterType(type);
  return LABEL_TO_DISASTER.find((r) => r.types.includes(norm)) || null;
}

function imageHeuristicSignals(buffer, contentType) {
  const isImage = typeof contentType === 'string' && contentType.startsWith('image/');
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (!isImage || size < 200) {
    return { isImage: false, avgLuma: 0.5, warmRatio: 0.2, blueRatio: 0.3, textureJitter: 0.0 };
  }
  let warm = 0;
  let blue = 0;
  let total = 0;
  let lumaSum = 0;
  let lumaLast = 0;
  let jitterSum = 0;
  let jitterCount = 0;
  const sampleStep = Math.max(1, Math.floor(size / 20000));
  for (let i = 0; i < size; i += sampleStep) {
    const b = buffer[i];
    const luma = b / 255;
    if (b > 200 && b !== 255) warm++;
    if (b < 90 && b > 20) blue++;
    lumaSum += luma;
    if (total > 0) {
      jitterSum += Math.abs(luma - lumaLast);
      jitterCount++;
    }
    lumaLast = luma;
    total++;
  }
  return {
    isImage: true,
    avgLuma: total ? lumaSum / total : 0.5,
    warmRatio: total ? warm / total : 0.0,
    blueRatio: total ? blue / total : 0.0,
    textureJitter: jitterCount ? jitterSum / jitterCount : 0.0
  };
}

function generateSimulatedDetections(buffer, contentType, userSelectedType) {
  const signals = imageHeuristicSignals(buffer, contentType);

  const detections = [];

  const addScore = (label, base, bonus = 0) => {
    const score = Math.max(0.05, Math.min(0.98, base + bonus));
    detections.push({ label, confidence: score });
  };

  if (signals.isImage) {
    addScore('flood', 0.18, signals.blueRatio * 0.7 + (signals.avgLuma > 0.45 ? 0.12 : 0));
    addScore('fire', 0.15, signals.warmRatio * 1.2 + (signals.avgLuma < 0.35 ? 0.15 : 0));
    addScore('structural_damage', 0.14, signals.textureJitter * 2.2 + (signals.avgLuma < 0.4 ? 0.1 : 0));
    addScore('storm', 0.13, signals.textureJitter * 1.1 + (signals.blueRatio * 0.3));
    addScore('landslide', 0.11, signals.textureJitter * 1.5);
    addScore('earthquake', 0.10, signals.textureJitter * 1.3);
    addScore('cyclone', 0.08, signals.blueRatio * 0.4);
    addScore('tsunami', 0.06, signals.blueRatio * 0.5);
  } else {
    addScore('flood', 0.12);
    addScore('fire', 0.10);
    addScore('structural_damage', 0.08);
    addScore('storm', 0.08);
    addScore('landslide', 0.05);
    addScore('earthquake', 0.05);
    addScore('cyclone', 0.04);
    addScore('tsunami', 0.03);
  }

  const typeRule = detectLabelRuleForType(userSelectedType);
  if (typeRule) {
    const matching = detections.find((d) => d.label === typeRule.label);
    if (matching) {
      matching.confidence = Math.min(0.98, matching.confidence + 0.22);
    }
  }

  detections.sort((a, b) => b.confidence - a.confidence);
  const total = detections.reduce((s, d) => s + d.confidence, 0) || 1;
  const normalized = detections.map((d) => ({
    label: d.label,
    confidence: +(d.confidence / total * (0.9 + Math.random() * 0.05)).toFixed(3)
  }));

  normalized.sort((a, b) => b.confidence - a.confidence);
  return normalized;
}

function compareAIToUser(detections, userSelectedType) {
  if (!detections || !detections.length) {
    return { match: 'inconclusive', rule: null, top: null };
  }
  const [top] = detections;
  const norm = normalizeDisasterType(userSelectedType);
  const ruleForType = detectLabelRuleForType(norm);

  if (!ruleForType) {
    return {
      match: 'inconclusive',
      rule: null,
      top
    };
  }

  const userMatchesTop = typeMatchesLabel(norm, LABEL_TO_DISASTER.find((r) => r.label === top.label));

  let matchState;
  if (top.confidence >= 0.55 && userMatchesTop) {
    matchState = 'consistent';
  } else if (top.confidence >= 0.55 && !userMatchesTop) {
    matchState = 'conflicting';
  } else if (top.confidence >= 0.25) {
    matchState = userMatchesTop ? 'weak_consistent' : 'weak_conflicting';
  } else {
    matchState = 'inconclusive';
  }

  return { match: matchState, rule: ruleForType, top };
}

function decideVerificationState(comparison, allDetections) {
  const topConf = comparison.top ? comparison.top.confidence : 0;
  switch (comparison.match) {
    case 'consistent': {
      const verificationBonus = Math.max(5, Math.min(20, Math.round(topConf * 20)));
      return {
        state: 'consistent',
        verificationBonus,
        flagHuman: 0
      };
    }
    case 'conflicting': {
      return {
        state: 'needs_human',
        verificationBonus: 0,
        flagHuman: 1
      };
    }
    case 'weak_consistent': {
      return {
        state: 'consistent',
        verificationBonus: Math.max(2, Math.min(8, Math.round(topConf * 12))),
        flagHuman: 0
      };
    }
    case 'weak_conflicting': {
      return {
        state: 'needs_human',
        verificationBonus: 0,
        flagHuman: 1
      };
    }
    case 'inconclusive':
    default:
      return {
        state: 'inconclusive',
        verificationBonus: 0,
        flagHuman: 0
      };
  }
}

async function callExternalVisionIfConfigured(buffer, contentType) {
  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== '' && !process.env.OPENAI_API_KEY.startsWith('your-'));
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== '' && !process.env.ANTHROPIC_API_KEY.startsWith('your-'));
  const hasGemini = !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== '' && !process.env.GOOGLE_API_KEY.startsWith('your-'));

  if (!hasOpenAI && !hasAnthropic && !hasGemini) return null;

  const base64 = buffer.toString('base64');
  const mime = contentType || 'image/jpeg';

  const visionPrompt = `You are an AI assistant for CoastWatch disaster verification. Analyze this image and list the most likely disaster-related classes you observe. Return ONLY a compact JSON object like: {"detections":[{"label":"flood","confidence":0.87},{"label":"fire","confidence":0.11}]}. Supported labels: flood, fire, structural_damage, storm, landslide, earthquake, tsunami, cyclone. Confidence values must sum to roughly 1.0. If nothing disaster-related is visible, return detections ordered by best guess with lower confidence.`;

  try {
    if (hasOpenAI) {
      const fetch = global.fetch || require('node-fetch');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
          max_tokens: 300,
          temperature: 0.1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: visionPrompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'low' } }
              ]
            }
          ]
        })
      });
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const json = parseJsonFromText(content);
      const detections = (json?.detections || []).filter((d) => typeof d.confidence === 'number');
      if (detections.length) {
        return {
          detections,
          model: { name: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini', provider: 'openai' }
        };
      }
    }

    if (hasGemini) {
      const fetch = global.fetch || require('node-fetch');
      const model = process.env.GOOGLE_VISION_MODEL || 'gemini-1.5-flash';
      const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: { maxOutputTokens: 300, temperature: 0.1 },
          contents: [
            {
              role: 'user',
              parts: [
                { text: visionPrompt },
                { inline_data: { mime_type: mime, data: base64 } }
              ]
            }
          ]
        })
      });
      const data = await res.json();
      const content = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
      const json = parseJsonFromText(content);
      const detections = (json?.detections || []).filter((d) => typeof d.confidence === 'number');
      if (detections.length) {
        return { detections, model: { name: model, provider: 'google' } };
      }
    }

    if (hasAnthropic) {
      const fetch = global.fetch || require('node-fetch');
      const model = process.env.ANTHROPIC_VISION_MODEL || 'claude-3-5-sonnet-20240620';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          temperature: 0.1,
          system: visionPrompt,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
                { type: 'text', text: 'Return the JSON detections object.' }
              ]
            }
          ]
        })
      });
      const data = await res.json();
      const content = (data?.content || []).map((c) => c.text).join('\n') || '';
      const json = parseJsonFromText(content);
      const detections = (json?.detections || []).filter((d) => typeof d.confidence === 'number');
      if (detections.length) {
        return { detections, model: { name: model, provider: 'anthropic' } };
      }
    }
  } catch (err) {
    console.warn('[ai_verification] external vision failed, falling back to simulated inference:', err.message);
    return null;
  }
  return null;
}

function parseJsonFromText(text) {
  if (!text) return {};
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return {};
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch (_) {
    return {};
  }
}

async function runEvidenceVerification({ evidenceBuffer, contentType, userSelectedType }) {
  let detections;
  let modelInfo = { name: 'cw-vision-heuristic-v1', provider: 'coastwatch_heuristic' };

  const external = await callExternalVisionIfConfigured(evidenceBuffer, contentType);
  if (external && external.detections?.length) {
    detections = external.detections;
    modelInfo = external.model;
  } else {
    detections = generateSimulatedDetections(evidenceBuffer, contentType, userSelectedType);
  }

  detections.sort((a, b) => b.confidence - a.confidence);
  const top = detections[0] || { label: null, confidence: 0 };

  const comparison = compareAIToUser(detections, userSelectedType);
  const decision = decideVerificationState(comparison, detections);

  const bonusCap = Math.round(Math.min(25, top.confidence * 25));
  const bonus = decision.state === 'consistent' ? Math.min(bonusCap, decision.verificationBonus) : 0;

  return {
    detections,
    topLabel: top.label,
    topConfidence: +(top.confidence || 0).toFixed(3),
    matchState: comparison.match,
    verificationState: decision.state,
    verificationBonus: bonus,
    flagHumanReview: decision.flagHuman,
    model: modelInfo
  };
}

module.exports = {
  SUPPORTED_DISASTER_TYPES,
  normalizeDisasterType,
  generateSimulatedDetections,
  compareAIToUser,
  decideVerificationState,
  runEvidenceVerification
};
