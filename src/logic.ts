import { DetectionResult, AssessmentResult } from './types';

// API レスポンスの型
interface AnalyzeResponse {
  result: AssessmentResult;
  safePrompt: string;
}

// サーバーサイドAPIを呼び出す関数
const callAnalyzeAPI = async (prompt: string): Promise<AnalyzeResponse> => {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `API error: ${response.status}`);
  }

  return response.json();
};

// メインの分析関数（非同期）
export const analyzePrompt = async (prompt: string): Promise<{ result: AssessmentResult; safePrompt: string }> => {
  // サーバーサイドAPIを呼び出し
  const { result, safePrompt } = await callAnalyzeAPI(prompt);
  return { result, safePrompt };
};

// 安全なプロンプト生成（クライアントサイドのフォールバック用）
export const generateSafePrompt = (originalPrompt: string, detections: DetectionResult[], llmSafePrompt?: string): string => {
  // LLMが生成した安全なプロンプトがある場合はそれを使用
  if (llmSafePrompt && llmSafePrompt.trim() !== '') {
    return llmSafePrompt;
  }
  
  // フォールバック: LLMが安全なプロンプトを生成しなかった場合の従来のロジック
  let safePrompt = originalPrompt;
  detections.forEach(d => {
    if (d.item.alternatives.length > 0) {
      // より柔軟な置換（大文字小文字を無視）
      const regex = new RegExp(d.matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      safePrompt = safePrompt.replace(regex, () => {
        // 元の大文字小文字を保持
        return `【${d.item.alternatives[0]}】`;
      });
    }
  });
  return safePrompt;
};
