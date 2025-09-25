import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

const endpoint = process.env.ENDPOINT_URL;
const deploymentName = process.env.DEPLOYMENT_NAME;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';

let client;
if (endpoint && apiKey) {
  client = new OpenAIClient(endpoint, new AzureKeyCredential(apiKey), { apiVersion });
}

const systemPrompt = `角色\n你是一位專業的路線排程專家，可以洞察醫療端以及民眾段的需求以及人性，並熟知交通不同時段狀況以及當地文化習慣，總是用盡全力與相關背景知識與工具來逐步推理出令人滿意的訪視路線。\n\n格式\n1. 以臺灣繁體中文來呈現“訪視時間表”、“訪視路線排程結果”以及“排程考量與貼心提醒”。\n2. 訪視時間表必須包含這些項目：順序、地點類別、名稱/病人姓名、地址、時間。\n3. 時間格式為24小時制，HH：MM 。\n4. ”訪視路線排程結果“則是會在訪視時間表下方呈現一個連結按鈕（排程路線地圖），點按之後可以連結到Google地圖應用程式或是網頁，呈現訪視路線地圖。\n5. “排程考量與貼心提醒”：簡易說明這份訪視路線排程要注意的地方。\n\n指令\n1. 必須遵守角色設定，還有以臺灣繁體中文來呈現方式時間表以及路線排程結果。\n2. 先置放完優先事項的時間點或是特殊訪視時段要求以及限制之後才能開始排程。\n3. 排程前必須先調用Google Map的Function去得到任兩點的交通距離以及時間。\n4. 依據特殊個案的優先指定時段還有得到的任兩點交通距離時間再來遵守「拓撲排序」邏輯來編排訪視路線。\n5. 訪視後的路線必須完成特殊個案的優先指定時段以及最佳經濟效率的路線排班。\n6. 排完路線後，需要呈現完整詳細的訪視時間表以及在Google 地圖上畫出訪視路線地圖。\n7. 訪視時間表必須包含這些項目：順序、地點類別、名稱/病人姓名、地址、時間。\n8. 順序：保留項目名稱為阿拉伯數字，出發點為0。\n9. 地點類別：保留項目名稱，項目包含：出發點、病人、用餐、終點。\n10. 名稱/病人姓名：保留項目名稱，項目包含：起點名稱、病人姓名（+特殊時段需求/極簡背景備註）、終點名稱。\n11. 地址：保留項目名稱，寫出對應的地址資訊，用餐地址空白即可。\n12. 時間：保留項目名稱，項目包含起點出發時間（出發點）、抵達時間（病人）、訪視停留時間（病人）、離開時間（病人）、用餐時間（移動緩衝時間）、抵達時間（終點）。時間格式為24小時制，HH：MM 。\n13. ”訪視路線排程結果“則是會在訪視時間表下方呈現一個連結按鈕（排程路線地圖），點按之後可以連結到Google地圖應用程式或是網頁，呈現訪視路線地圖。\n14. “排程考量與貼心提醒”：在”訪視路線排程結果“之後，簡易說明這份訪視路線排程要注意的地方，禁止說到拓撲兩個字，只需要說明是否有符合特殊時段需求以及最佳路線排程即可。\n15. 病人訪視一定要嚴格遵守「拓撲排序」邏輯。`;

function buildUserPrompt(caseDetails) {
  return `請依照以下個案資料完成訪視排程，務必回覆符合下列 JSON 結構，並且使用臺灣繁體中文：\n{\n  "date": "YYYY-MM-DD",\n  "stops": [\n    {\n      "order": 0,\n      "type": "出發點",\n      "name": "出發點名稱",\n      "note": "可省略",\n      "address": "出發點地址",\n      "time": {\n        "depart": "HH:MM"\n      }\n    },\n    {\n      "order": 1,\n      "type": "病人",\n      "name": "病人姓名（可附註）",\n      "note": "特殊時段需求（可省略）",\n      "address": "病人地址",\n      "time": {\n        "arrive": "HH:MM",\n        "visit_minutes": 30,\n        "leave": "HH:MM"\n      }\n    }\n  ],\n  "route_map_url": "https://...",\n  "reminders": ["提醒內容1", "提醒內容2"]\n}\n請依個案需求調整各訪視停留時間與路線安排，並且不要在 JSON 外加入任何說明文字。\n\n個案資料：\n${caseDetails}`;
}

function extractJsonBlock(text) {
  if (!text) return null;
  const startIndex = text.indexOf('{');
  if (startIndex === -1) return null;

  let depth = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

app.post('/api/schedule', async (req, res) => {
  if (!client) {
    return res.status(500).json({ error: 'Azure OpenAI 尚未正確設定，請確認環境變數。' });
  }

  if (!deploymentName) {
    return res.status(500).json({ error: '缺少部署名稱設定，請檢查 DEPLOYMENT_NAME 環境變數。' });
  }

  const { caseDetails } = req.body;
  if (!caseDetails) {
    return res.status(400).json({ error: '請提供足夠的訪視與個案資訊。' });
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(caseDetails) }
    ];

    const response = await client.getChatCompletions(deploymentName, messages, {
      maxTokens: 2000,
      temperature: 0.3,
      stop: null
    });

    const firstChoice = response.choices?.[0];
    const rawResponse = firstChoice?.message?.content ?? '';
    let parsedSchedule = null;

    const jsonBlock = extractJsonBlock(rawResponse);
    if (jsonBlock) {
      try {
        parsedSchedule = JSON.parse(jsonBlock);
      } catch (parseError) {
        console.warn('JSON parse failed:', parseError.message);
      }
    }

    return res.json({
      schedule: parsedSchedule,
      rawResponse
    });
  } catch (error) {
    console.error('Azure OpenAI error:', error);
    return res.status(500).json({
      error: '取得 AI 排程結果時發生錯誤，請稍後再試。',
      details: error.message
    });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
