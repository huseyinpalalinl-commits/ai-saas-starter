import { prisma } from "../prisma";
import { UserService } from "./user";
import config from "../config";

// Pollinations.ai: free, keyless image generation.
// Gemini API: free-tier text generation for chat templates.

const ASPECT_DIMENSIONS = {
  "1:1": [1024, 1024],
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "21:9": [1344, 576],
};

function isLlmEndpoint(endpoint) {
  return endpoint === "any-llm-models" || (endpoint || "").includes("completions");
}

function buildPollinationsUrl(prompt, aspectRatio, inputImage) {
  const [width, height] = ASPECT_DIMENSIONS[aspectRatio] || ASPECT_DIMENSIONS["1:1"];
  const seed = Math.floor(Math.random() * 1e9);
  let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
  // Image-to-image only works with a publicly reachable URL (not base64 data URIs)
  if (inputImage && /^https?:\/\//.test(inputImage)) {
    url += `&image=${encodeURIComponent(inputImage)}&model=kontext`;
  }
  return url;
}

async function generateChatCompletion(prompt, model) {
  const apiKey = config.ai.geminiApiKey;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  let contents = [{ role: "user", parts: [{ text: prompt }] }];
  let systemPromptText = "You are a helpful AI assistant.";
  try {
    const parsed = JSON.parse(prompt);
    if (Array.isArray(parsed.chatHistory)) {
      contents = parsed.chatHistory.map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: String(m.content ?? "") }],
      }));
    }
    if (parsed.systemPrompt) {
      systemPromptText = parsed.systemPrompt;
    }
  } catch (e) {
    // Raw string prompt; use as-is
  }

  const geminiModel = model && model.startsWith("gemini") ? model : "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPromptText }] },
        generationConfig: { temperature: 0.7 },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText.slice(0, 300)}`);
  }

  const json = await response.json();
  const text = (json.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }
  return text;
}

async function generateImage(prompt, aspectRatio, inputImage) {
  const imageUrl = buildPollinationsUrl(prompt, aspectRatio, inputImage);

  // Fetch once server-side to make sure the image actually generates.
  // Pollinations caches results by URL, so the stored URL stays valid.
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.startsWith("image/")) {
    throw new Error(`Image generation failed: ${response.status}`);
  }
  return imageUrl;
}

export const AIService = {
  /**
   * Generate content (image via Pollinations, text via Gemini), deduct credits,
   * and persist the result. Credits are refunded automatically on failure.
   */
  async generate(userId, { prompt, inputImage, aspectRatio, modelEndpoint = "predictions", appId = null, creditCost = null, model = null, customParams = {} }) {
    const cost = creditCost !== null ? Number(creditCost) : config.ai.generationCost;

    // 1. Deduct credits up front
    await UserService.deductCredits(userId, cost);

    try {
      const isLlm = isLlmEndpoint(modelEndpoint);
      const resultImage = isLlm
        ? await generateChatCompletion(prompt, model)
        : await generateImage(prompt, aspectRatio, inputImage);

      // 2. Persist the completed creation
      const creation = await prisma.creation.create({
        data: {
          userId,
          prompt,
          inputImage,
          requestId: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          status: "completed",
          resultImage,
          creditCost: cost,
          aspectRatio,
          appId,
        },
      });

      return { id: creation.id, resultImage: creation.resultImage, status: creation.status };
    } catch (error) {
      // 3. Refund credits on any failure
      await UserService.addCredits(userId, cost);
      throw error;
    }
  },

  /**
   * Generation is now synchronous, so there is nothing to poll.
   * Kept for backward compatibility with callers that sync stale records.
   */
  async syncStatus(creationId) {
    const creation = await prisma.creation.findUnique({
      where: { id: creationId },
      include: { app: true },
    });
    if (!creation || creation.status !== "processing") return creation;

    // Legacy "processing" records (from the old async flow) can never
    // complete anymore: mark them failed and refund.
    await UserService.addCredits(creation.userId, creation.creditCost);
    return await prisma.creation.update({
      where: { id: creationId },
      data: { status: "failed", error: "Generation timed out" },
      include: { app: true },
    });
  },
};
