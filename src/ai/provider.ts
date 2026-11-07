import { geminiJson } from "./gemini.js";
import { chatJson, type ModelReply } from "./ollama.js";

/** "gemini:<model>" calls Google Gemini; anything else is an Ollama model name. */
export function callModel(model: string, system: string, user: string): Promise<ModelReply> {
  return model.startsWith("gemini:") ? geminiJson(model.slice("gemini:".length), system, user) : chatJson(model, system, user);
}
