import type { VercelRequest, VercelResponse } from '@vercel/node';

// 型定義
type RiskLevel = 'High' | 'Medium' | 'Low';
type Category = 'Character' | 'Franchise' | 'Style' | 'Brand';

interface LLMDetection {
  name: string;
  matchedText: string;
  category: Category;
  riskLevel: RiskLevel;
  rightsHolder: string;
  description: string;
  alternatives: string[];
}

interface LLMDetectionResponse {
  detections: LLMDetection[];
  safePrompt?: string;
}

interface CopyrightItem {
  id: string;
  name: string;
  variants: string[];
  relatedTerms: string[];
  category: Category;
  riskLevel: RiskLevel;
  rightsHolder: string;
  description: string;
  alternatives: string[];
}

interface DetectionResult {
  itemId: string;
  matchedText: string;
  matchType: 'Exact' | 'Variant' | 'Related';
  item: CopyrightItem;
  score: number;
}

interface AssessmentResult {
  totalScore: number;
  riskLevel: RiskLevel;
  detections: DetectionResult[];
  processedAt: string;
}

const SCORES = {
  matchType: { Exact: 50, Variant: 35, Related: 20 },
  riskMultiplier: { High: 2.0, Medium: 1.0, Low: 0.5 }
};

const SYSTEM_PROMPT = `あなたは著作権リスク判定の専門家です。ユーザーが入力した画像生成プロンプトを分析し、既存のキャラクター名、実在の有名人、特定の商標、著作権保護されたスタイルが含まれているか判定してください。

以下のJSON形式で返答してください：
{
  "detections": [
    {
      "name": "検出された項目名（例: 月ねこ）",
      "matchedText": "プロンプト内でマッチしたテキスト",
      "category": "Character | Franchise | Style | Brand",
      "riskLevel": "High | Medium | Low",
      "rightsHolder": "権利者名（例: 架空のキャラクター）",
      "description": "リスクの説明",
      "alternatives": ["安全な代替表現1", "安全な代替表現2"]
    }
  ],
  "safePrompt": "元のプロンプト全体を自然な日本語で再構成した安全なバージョン。検出されたリスクのある要素を、文脈を保ちながら自然な日本語で置き換えた完全なプロンプト。検出がない場合は元のプロンプトと同じ。"
}

重要：
- "safePrompt"は、元のプロンプト全体を自然で読みやすい日本語で再構成してください
- 単語単位の置換ではなく、文全体の意味と文脈を保ちながら、リスクのある要素を安全な表現に置き換えてください
- 日本語として自然で、画像生成プロンプトとして機能する完全な文章にしてください
- 検出されない場合は、元のプロンプトをそのまま返してください

検出されない場合は空配列を返してください。必ず有効なJSONのみを返答してください。`;

// Google Gemini API呼び出し
async function callGeminiAPI(prompt: string, apiKey: string): Promise<LLMDetectionResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${SYSTEM_PROMPT}\n\nユーザーの入力: ${prompt}`
          }]
        }]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
    throw new Error('Invalid response format from Gemini API');
  }
  
  const text = data.candidates[0].content.parts[0].text;
  
  // JSONを抽出（マークダウンコードブロックからも抽出可能）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse JSON from Gemini response');
  }

  return JSON.parse(jsonMatch[0]) as LLMDetectionResponse;
}

// OpenAI API呼び出し
async function callOpenAIAPI(prompt: string, apiKey: string): Promise<LLMDetectionResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `ユーザーの入力: ${prompt}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Invalid response format from OpenAI API');
  }
  
  const content = data.choices[0].message.content;
  return JSON.parse(content) as LLMDetectionResponse;
}

// LLMレスポンスをDetectionResultに変換
function convertToDetectionResult(llmResponse: LLMDetectionResponse): DetectionResult[] {
  if (!llmResponse.detections || !Array.isArray(llmResponse.detections)) {
    return [];
  }
  
  return llmResponse.detections.map((detection, index) => {
    const itemId = `llm_${Date.now()}_${index}`;
    
    const baseScore = SCORES.matchType.Exact;
    const multiplier = SCORES.riskMultiplier[detection.riskLevel] || 1;
    const score = baseScore * multiplier;

    return {
      itemId,
      matchedText: detection.matchedText,
      matchType: 'Exact' as const,
      item: {
        id: itemId,
        name: detection.name,
        variants: [],
        relatedTerms: [],
        category: detection.category,
        riskLevel: detection.riskLevel,
        rightsHolder: detection.rightsHolder,
        description: detection.description,
        alternatives: detection.alternatives
      },
      score
    };
  });
}

// 安全なプロンプト生成
function generateSafePrompt(originalPrompt: string, detections: DetectionResult[], llmSafePrompt?: string): string {
  if (llmSafePrompt && llmSafePrompt.trim() !== '') {
    return llmSafePrompt;
  }
  
  let safePrompt = originalPrompt;
  detections.forEach(d => {
    if (d.item.alternatives.length > 0) {
      const regex = new RegExp(d.matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      safePrompt = safePrompt.replace(regex, () => `【${d.item.alternatives[0]}】`);
    }
  });
  return safePrompt;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS対応
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // プロバイダー選択（環境変数で設定）
  const provider = process.env.LLM_PROVIDER || 'gemini';
  
  let apiKey: string | undefined;
  if (provider === 'gemini') {
    apiKey = process.env.GEMINI_API_KEY;
  } else if (provider === 'openai') {
    apiKey = process.env.OPENAI_API_KEY;
  }

  if (!apiKey) {
    return res.status(500).json({ error: `API key not configured for provider: ${provider}` });
  }

  try {
    // LLM API呼び出し
    let llmResponse: LLMDetectionResponse;
    if (provider === 'gemini') {
      llmResponse = await callGeminiAPI(prompt, apiKey);
    } else {
      llmResponse = await callOpenAIAPI(prompt, apiKey);
    }

    // DetectionResultに変換
    const detections = convertToDetectionResult(llmResponse);

    // スコア計算
    let rawScore = 0;
    detections.forEach(d => { rawScore += d.score; });
    const totalScore = Math.min(100, Math.round(rawScore));
    
    // リスクレベル判定
    let riskLevel: RiskLevel = 'Low';
    const hasHighRisk = detections.some(d => d.item.riskLevel === 'High');
    if (hasHighRisk || totalScore >= 70) riskLevel = 'High';
    else if (totalScore >= 40) riskLevel = 'Medium';

    const result: AssessmentResult = {
      totalScore,
      riskLevel,
      detections,
      processedAt: new Date().toISOString()
    };

    const safePrompt = generateSafePrompt(prompt, detections, llmResponse.safePrompt);

    return res.status(200).json({ result, safePrompt });
  } catch (error) {
    console.error('API error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
}
