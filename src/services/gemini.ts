import { GoogleGenAI, Type } from "@google/genai";
import { Note } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.1-flash-lite-preview";

// Phase 1: 로직 단위 추출
export const extractLogicUnits = async (filePath: string, fileContent: string) => {
  const prompt = `다음 소스 코드 파일에서 '원자적 로직 단위'(함수, 클래스, 주요 블록 등)를 추출하세요.

[핵심 규칙: 단일 책임 원칙(SRP) 기반의 원자적 분리]
1. 단순히 함수나 클래스 단위로 1:1 추출하지 마세요.
2. 하나의 거대한 함수(예: completeOrder) 내부에 여러 개의 독립적인 비즈니스 로직(예: 1. 결제 승인, 2. 재고 차감, 3. 영수증 발송)이 혼재되어 있다면, 이를 반드시 개별적인 원자적 로직 단위로 쪼개어 여러 개로 추출하세요.
3. 각 추출된 단위는 오직 '단 하나의 핵심 기능'만 수행해야 합니다.
4. 식별자(title)는 원본 영문 식별자를 기본으로 하되, 하나의 함수를 여러 개로 쪼갠 경우 해당 역할을 명확히 알 수 있도록 접미사를 달아주세요. (예: completeOrder_approvePayment, completeOrder_deductInventory)

File Path: ${filePath}

Code:
\`\`\`
${fileContent}
\`\`\`
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "로직 단위의 이름 (함수명, 클래스명 등)" },
            priority: { type: Type.STRING, description: "우선순위: A, B, C, 또는 Done" }
          },
          required: ["title", "priority"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return [];
  }
};

// Phase 2: AI 심층 분석
export const analyzeLogicUnit = async (title: string, codeSnippet: string) => {
  const prompt = `다음 소스 코드에서 '${title}' 로직 단위를 심층 분석하세요.
(주의: '${title}'이 특정 함수의 일부분(예: 함수명_세부기능)을 가리킨다면, 전체 함수가 아닌 해당 '세부 기능'에 대해서만 집중적으로 분석하세요.)
반드시 한국어로 작성해야 합니다.

가독성을 극대화하기 위해 다음 규칙을 엄격히 준수하세요:
1. 모든 항목은 마크다운(Markdown) 형식을 사용하세요.
2. 'flow'와 'components'는 반드시 마크다운 리스트(- 또는 1.) 형식을 사용하세요. 가독성을 위해 리스트 항목(1. 2. 3. 등) 사이에는 **반드시 빈 줄(Empty Line)을 하나씩 삽입**하세요. (Loose List 형태)
3. 'summary'와 'io'도 정보가 많을 경우 줄바꿈을 적극적으로 사용하세요.
4. 전문 용어는 가급적 그대로 사용하되, 설명은 친절하게 작성하세요.

다음 5가지 항목을 추출하세요:
1. title (기술적 제목): '핵심 기능 + 기술' (구현 중심) 형식으로 작성하되, 단일 책임 원칙에 따라 '가장 핵심적인 단 하나의 기능'만 명시하세요. 'A 및 B', 'A와 B'처럼 여러 기능을 나열하지 마세요. (예: 'ensurePathNode: 계층 경로 동기화', 'updateStock: 트랜잭션 기반 재고 처리')
2. summary (기술적 역할): 이 코드 조각의 기술적인 핵심 기능을 한 문장으로 정의하세요.
3. components (기술적 구성 요소): 실제 코드에 존재하는 물리적 부품들(라이브러리, 주요 변수/상태, 핵심 함수 등)을 리스트 형태로 나열하세요.
4. flow (데이터/실행 흐름): 코드의 실제 실행 순서와 데이터가 변하는 과정을 번호를 매겨 상세히 기록하세요. 각 단계 사이에는 반드시 빈 줄을 삽입하세요.
5. io (기술적 입출력): 입력(Parameters)과 출력(Returns)을 명시하세요. 항목별로 줄바꿈을 사용하세요.

Code:
\`\`\`
${codeSnippet}
\`\`\`
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "기술적 제목 ('핵심 기능 + 기술' 형식)" },
          summary: { type: Type.STRING, description: "기술적 역할 요약" },
          components: { type: Type.STRING, description: "기술적 구성 요소" },
          flow: { type: Type.STRING, description: "데이터/실행 흐름" },
          io: { type: Type.STRING, description: "기술적 입출력" }
        },
        required: ["title", "summary", "components", "flow", "io"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return { title: title, summary: "", components: "", flow: "", io: "" };
  }
};

// Phase 3: 설계도 매핑 및 생성
export const mapToLogicNote = async (snapshotTitle: string, snapshotSummary: string, existingLogics: Note[]) => {
  const logicsContext = existingLogics.map(l => `ID: ${l.id}, Title: ${l.title}, Summary: ${l.summary}`).join('\n');
  
  const prompt = `새로운 Snapshot 노트가 추출되었습니다.
Snapshot Title: ${snapshotTitle}
Snapshot Summary: ${snapshotSummary}

기존 Logic 노트 목록:
${logicsContext || "없음"}

이 Snapshot이 기존 Logic 노트 중 하나에 속하는지 판단하세요.
속한다면 해당 Logic 노트의 ID를 'existingLogicId'에 반환하세요.
적절한 부모가 없다면 새로운 Logic 노트를 제안하기 위해 'newLogicTitle'과 'newLogicSummary'를 한국어로 작성하여 반환하세요.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          existingLogicId: { type: Type.STRING, description: "기존 Logic 노트의 ID (없으면 빈 문자열)" },
          newLogicTitle: { type: Type.STRING, description: "새로운 Logic 노트 제목 (기존 ID가 없을 때만)" },
          newLogicSummary: { type: Type.STRING, description: "새로운 Logic 노트 요약 (기존 ID가 없을 때만)" }
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return {};
  }
};

// Re-format existing note for better readability
export const reformatNote = async (note: Partial<Note>) => {
  const prompt = `다음 노트를 가독성 있게 재구성하세요.
반드시 한국어로 작성해야 합니다.

가독성을 극대화하기 위해 다음 규칙을 엄격히 준수하세요:
1. 모든 항목은 마크다운(Markdown) 형식을 사용하세요.
2. 'flow'와 'components'는 반드시 마크다운 리스트(- 또는 1.) 형식을 사용하세요. 가독성을 위해 리스트 항목(1. 2. 3. 등) 사이에는 **반드시 빈 줄(Empty Line)을 하나씩 삽입**하세요. (Loose List 형태)
3. 'summary'와 'io'도 정보가 많을 경우 줄바꿈을 적극적으로 사용하세요.

기존 내용:
Summary: ${note.summary}
Components: ${note.components}
Flow: ${note.flow}
IO: ${note.io}
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          components: { type: Type.STRING },
          flow: { type: Type.STRING },
          io: { type: Type.STRING }
        },
        required: ["summary", "components", "flow", "io"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return note;
  }
};

// Translate technical Snapshot data to Business Logic data
export const translateToBusinessLogic = async (technicalData: { title: string, summary: string, components: string, flow: string, io: string }) => {
  const prompt = `다음은 코드의 기술적 분석 내용(Snapshot)입니다. 이를 비전공자 개발자가 이해할 수 있는 '비즈니스 로직(의도)'으로 번역하세요.

대칭성 유지: 반드시 동일하게 '제목-요약-구성요소-흐름-입출력' 5단계 구조를 유지해야 합니다.

가독성을 극대화하기 위해 다음 규칙을 엄격히 준수하세요:
1. 모든 항목은 마크다운(Markdown) 형식을 사용하세요.
2. 'flow'와 'components'는 반드시 마크다운 리스트(- 또는 1.) 형식을 사용하세요. 가독성을 위해 리스트 항목(1. 2. 3. 등) 사이에는 **반드시 빈 줄(Empty Line)을 하나씩 삽입**하세요. (Loose List 형태)
3. 'summary'와 'io'도 정보가 많을 경우 줄바꿈을 적극적으로 사용하세요.

번역 규칙:
0. 제목(title): '서비스 명칭 + 핵심 가치' (사용자 경험/체험 중심) 형식으로 작성하되, 단일 책임 원칙에 따라 '가장 핵심적인 단 하나의 가치'만 명시하세요. 'A 및 B', 'A와 B'처럼 여러 기능을 나열하지 마세요. 수식어를 빼고 무엇을 하는 기능인지만 명확히 합니다. (예: '중복 방지 폴더 생성', '실시간 재고 반영', '사용자 인증 시스템')
1. 기술적 구성 요소(변수명, 라이브러리, 특정 함수명 등) -> 비즈니스 구성 요소(비즈니스 개념, 기획 요소, 사용자 경험 요소)로 번역하세요.
2. 실행 흐름(코드 실행 순서, 루프, 조건문 등) -> 논리적 흐름(사람의 의사결정 순서, 서비스 시나리오, 비즈니스 프로세스)으로 번역하세요.
3. 기술적 입출력 -> 비즈니스적 입출력(사용자가 제공하는 정보, 시스템이 사용자에게 돌려주는 결과물)으로 번역하세요.

기술적 데이터:
원본 식별자 및 기술적 제목: ${technicalData.title}
요약: ${technicalData.summary}
구성요소: ${technicalData.components}
흐름: ${technicalData.flow}
입출력: ${technicalData.io}
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "비즈니스 친화적인 직관적인 한국어 제목 ('서비스 명칭 + 핵심 가치' 형식)" },
          summary: { type: Type.STRING, description: "비즈니스 요약" },
          components: { type: Type.STRING, description: "비즈니스 구성 요소" },
          flow: { type: Type.STRING, description: "논리적 흐름" },
          io: { type: Type.STRING, description: "비즈니스 입출력" }
        },
        required: ["title", "summary", "components", "flow", "io"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to translate to business logic", e);
    return technicalData;
  }
};

export const checkImplementationConflict = async (
  implementedLogic: { title: string, summary: string, flow: string },
  plannedLogic: { title: string, summary: string, flow: string }
) => {
  const prompt = `기획된 비즈니스 로직(Planned Logic)과 실제 구현된 비즈니스 로직(Implemented Logic) 간의 충돌(Conflict) 여부를 판단하세요.

[기획된 비즈니스 로직 (Logic B)]
제목: ${plannedLogic.title}
요약: ${plannedLogic.summary}
흐름: ${plannedLogic.flow || '없음'}

[실제 구현된 비즈니스 로직 (Logic A)]
제목: ${implementedLogic.title}
요약: ${implementedLogic.summary}
흐름: ${implementedLogic.flow || '없음'}

판단 규칙:
1. 실제 구현된 로직이 기획된 로직의 핵심 의도와 정면으로 모순되거나, 필수적인 비즈니스 흐름이 누락/변질되었다면 'hasConflict'를 true로 반환하세요.
2. 단순히 기술적 상세함의 차이나, 기획을 해치지 않는 선에서의 추가 구현이라면 false를 반환하세요.
3. 사용자는 비전공자입니다. 차이점을 설명할 때 반드시 일상적인 언어로 풀어서 설명하고, 관련된 전문 용어는 괄호 안에 병기하세요. 또한 이 차이가 앱에 어떤 영향을 미치는지(Impact)도 간단히 설명하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "hasConflict": true 또는 false,
  "summary": "충돌에 대한 비전공자 친화적인 전체 요약 (hasConflict가 true일 때만 포함)",
  "differences": [
    {
      "aspect": "차이가 발생한 부분 (예: 데이터 저장 위치)",
      "design": "기획된 내용 (예: 사용자의 기기에만 임시로 저장하기로 기획됨 (Local Storage))",
      "code": "실제 구현된 내용 (예: 클라우드 서버에 영구적으로 저장하도록 구현됨 (Firestore))",
      "impact": "이 차이가 앱과 사용자에게 미치는 영향"
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          hasConflict: { type: Type.BOOLEAN },
          summary: { type: Type.STRING },
          differences: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                aspect: { type: Type.STRING },
                design: { type: Type.STRING },
                code: { type: Type.STRING },
                impact: { type: Type.STRING }
              },
              required: ["aspect", "design", "code", "impact"]
            }
          }
        },
        required: ["hasConflict"]
      }
    }
  });

  try {
    const result = JSON.parse(response.text || "{}");
    return {
      isConflict: result.hasConflict || false,
      conflictDetails: result.hasConflict ? {
        summary: result.summary || "",
        differences: result.differences || []
      } : undefined
    };
  } catch (e) {
    console.error("Failed to check conflict", e);
    return { isConflict: false };
  }
};

export const mapLogicToModule = async (
  logicData: { title: string, summary: string },
  existingModules: { id: string, title: string, summary: string }[]
) => {
  const prompt = `다음 비즈니스 로직(Logic)이 속할 가장 적절한 상위 그룹(Module)을 찾으세요.

[비즈니스 로직 (Logic)]
제목: ${logicData.title}
요약: ${logicData.summary}

[기존 모듈 후보군 (Module)]
${existingModules.length > 0 ? JSON.stringify(existingModules, null, 2) : "기존 모듈 없음"}

판단 규칙:
1. 이 로직을 포함하기에 가장 적절한 기존 Module이 있다면 해당 ID를 'mappedModuleId'로 반환하세요.
2. 적절한 Module이 없다면 'mappedModuleId'를 null로 반환하고, 이 로직을 포함할 수 있는 새로운 상위 Module의 제목과 요약을 'suggestedTitle', 'suggestedSummary'로 제안하세요.

[새로운 모듈 제안 시 엄격한 제약 조건]
- suggestedTitle: 반드시 20자 이내의 명사형으로만 작성하세요. (예: "노트 데이터 동기화 시스템") "제안합니다", "모듈입니다" 등의 서술어, 부연 설명, 특수문자는 절대 포함하지 마세요.
- suggestedSummary: 1~2문장으로 간결하게 핵심 역할만 작성하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "mappedModuleId": "일치하는 ID 또는 null",
  "suggestedTitle": "새로운 모듈 제목 (mappedModuleId가 null일 때)",
  "suggestedSummary": "새로운 모듈 요약 (mappedModuleId가 null일 때)"
}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          mappedModuleId: { type: Type.STRING, nullable: true },
          suggestedTitle: { type: Type.STRING, nullable: true },
          suggestedSummary: { type: Type.STRING, nullable: true }
        },
        required: []
      }
    }
  });

  try {
    const result = JSON.parse(response.text || "{}");
    if (result.mappedModuleId && !existingModules.find(m => m.id === result.mappedModuleId)) {
      result.mappedModuleId = null;
    }
    return {
      mappedModuleId: result.mappedModuleId || null,
      suggestedTitle: result.suggestedTitle || null,
      suggestedSummary: result.suggestedSummary || null
    };
  } catch (e) {
    console.error("Failed to map module", e);
    return { mappedModuleId: null, suggestedTitle: null, suggestedSummary: null };
  }
};

export const getEmbeddingsBulk = async (texts: string[]): Promise<number[][]> => {
  if (!texts || texts.length === 0) return [];
  try {
    const promises = texts.map(text => 
      ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: text
      })
    );
    const results = await Promise.all(promises);
    return results.map(res => res.embeddings?.[0]?.values || []);
  } catch (e) {
    console.error("Bulk embedding failed", e);
    return texts.map(() => []);
  }
};

export const cosineSimilarity = (a: number[], b: number[]) => {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export const mapLogicsToModulesBulk = async (
  logicsWithCandidates: { 
    index: number, 
    title: string, 
    summary: string, 
    candidateModules: { id: string, title: string, summary: string }[] 
  }[]
) => {
  const prompt = `당신은 여러 개의 비즈니스 로직을 적절한 상위 모듈(Module)로 일괄 그룹화하는 시스템입니다.

[분류할 비즈니스 로직 및 후보 모듈 목록]
${JSON.stringify(logicsWithCandidates, null, 2)}

판단 규칙:
1. 각 로직(index)별로 제공된 'candidateModules' 중 가장 적절한 기존 Module이 있다면 해당 ID를 'mappedModuleId'로 지정하세요.
2. 적절한 Module이 없다면 'mappedModuleId'를 null로 하고, 새로운 상위 Module을 제안하세요 ('suggestedTitle', 'suggestedSummary').
3. 여러 로직이 동일한 새로운 모듈에 속해야 한다면, 동일한 'suggestedTitle'을 사용하여 하나로 묶일 수 있게 하세요.

[새로운 모듈 제안 시 엄격한 제약 조건]
- suggestedTitle: 반드시 20자 이내의 명사형으로만 작성하세요. (예: "노트 데이터 동기화 시스템") 서술어, 부연 설명, 특수문자 절대 금지.
- suggestedSummary: 1~2문장으로 간결하게 핵심 역할만 작성.

반드시 아래 JSON 배열 형식으로만 응답하세요:
[
  {
    "index": 0,
    "mappedModuleId": "일치하는 ID 또는 null",
    "suggestedTitle": "새로운 모듈 제목 (null일 때)",
    "suggestedSummary": "새로운 모듈 요약 (null일 때)"
  }
]`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER },
            mappedModuleId: { type: Type.STRING, nullable: true },
            suggestedTitle: { type: Type.STRING, nullable: true },
            suggestedSummary: { type: Type.STRING, nullable: true }
          },
          required: ["index"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to bulk map modules", e);
    return [];
  }
};

export const generateFixGuide = async (note: Note, fileContent: string) => {
  const prompt = `기존 설계 문서(Logic Note)와 실제 구현된 코드(Github File) 사이에 충돌(Conflict)이 발생했습니다.
개발자는 "설계가 맞습니다"라고 판단했습니다. 즉, 현재 코드가 기존 설계 의도와 다르게 잘못 구현되었거나 누락된 부분이 있습니다.

아래의 [기존 설계 문서]와 [현재 코드]를 비교 분석하여, 코드를 어떻게 수정해야 설계에 부합하게 되는지 **구현 보정 가이드(가이드라인)**를 마크다운 형식으로 작성해 주세요.

[기존 설계 문서]
제목: ${note.title}
요약: ${note.summary}
구성요소: ${note.components}
흐름: ${note.flow}
입출력: ${note.io}

[현재 코드]
\`\`\`
${fileContent}
\`\`\`

가이드라인 작성 규칙:
1. 어떤 부분이 설계와 다르게 구현되었는지 명확히 지적하세요.
2. 코드를 어떻게 수정해야 하는지 구체적인 방향(또는 코드 스니펫)을 제시하세요.
3. 마크다운 형식을 사용하여 가독성 좋게 작성하세요.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });

  return response.text || "가이드를 생성하지 못했습니다.";
};
