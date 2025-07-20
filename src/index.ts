/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage, ChatRequest } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  /**
   * Main request handler for the Worker
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env, ctx);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    // Parse JSON request body
    const { messages = [], model = MODEL_ID, apiKey = "" } = (await request.json()) as ChatRequest;

    // Add system prompt if not present
    if (!messages.some((msg) => msg.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    if (model.startsWith("gemini")) {
      return handleGeminiChatRequest(messages, model, apiKey, ctx);
    } else {
      return handleCloudflareAIRequest(messages, model, env);
    }
  } catch (error) {
    console.error("Error processing chat request:", error);
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return new Response(
      JSON.stringify({ error: "Failed to process request", details: errorMessage }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

/**
 * Handles requests for Cloudflare Workers AI models
 */
async function handleCloudflareAIRequest(
  messages: ChatMessage[],
  model: string,
  env: Env,
): Promise<Response> {
  const response = await env.AI.run(
    model as any, // Use type assertion to bypass the strict type check
    {
      messages,
      max_tokens: 4096,
      stream: true,
    },
    {
      // The returnRawResponse option is not used here because we want the SDK to handle the SSE stream.
      // When stream: true, the SDK automatically returns a Response object with the correct SSE headers.
    },
  );

  // The SDK response is already a streaming Response object, so we can return it directly.
  return response;
}


/**
 * Handles requests for Google Gemini models
 */
async function handleGeminiChatRequest(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key is required for Gemini models" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  // Transform messages to Gemini format
  const contents = messages
    .filter(msg => msg.role !== 'system') // Gemini API uses 'system_instruction' instead
    .map(msg => ({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      parts: [{ text: msg.content }],
    }));
  
  const systemPrompt = messages.find(msg => msg.role === 'system');

  const geminiRequest = {
    contents,
    system_instruction: systemPrompt ? { parts: [{ text: systemPrompt.content }] } : undefined,
  };

  const geminiResponse = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiRequest),
  });

  if (!geminiResponse.ok || !geminiResponse.body) {
    const errorBody = await geminiResponse.text();
    console.error("Gemini API error:", errorBody);
    return new Response(JSON.stringify({ error: "Failed to fetch from Gemini API", details: errorBody }), {
      status: geminiResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Transform Gemini's streaming response to our app's SSE format
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = geminiResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Process the stream from Gemini (which is now SSE)
  const processStream = async () => {
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep the last partial line in the buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.substring(6);
          try {
            const geminiChunk = JSON.parse(jsonStr);
            const text = geminiChunk?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              // Re-format into the SSE format our frontend expects
              const sseFormattedChunk = `data: ${JSON.stringify({ response: text })}\n\n`;
              await writer.write(encoder.encode(sseFormattedChunk));
            }
          } catch (e) {
            console.error("Error parsing Gemini SSE data chunk:", e, "Chunk:", jsonStr);
          }
        }
      }
    }
    writer.close();
  };

  ctx.waitUntil(processStream());

  const response: Response = new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
  return response;
}
