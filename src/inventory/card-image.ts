import { readFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { CardInput } from "../catalog/types.js";

export interface ParsedCardImage extends CardInput {
  quantity: number | null;
  confidenceNotes: string[];
}

const cardImageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: ["string", "null"] },
    setName: { type: ["string", "null"] },
    cardNumber: { type: ["string", "null"] },
    language: { type: ["string", "null"] },
    variant: { type: ["string", "null"] },
    quantity: { type: ["number", "null"] },
    confidenceNotes: { type: "array", items: { type: "string" } },
  },
  required: ["name", "setName", "cardNumber", "language", "variant", "quantity", "confidenceNotes"],
} as const;

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".jpg":
    case ".jpeg":
    default: return "image/jpeg";
  }
}

/**
 * Extracts card identity from a single card image.
 *
 * This intentionally does not infer condition, SKU, price, or ownership data.
 * Those fields belong to the ingestion/review layer.
 */
export async function extractCardImage(filePath: string): Promise<ParsedCardImage> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing from .env");

  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
  const image = await readFile(filePath);
  const gemini = new GoogleGenAI({ apiKey });

  const response = await gemini.models.generateContent({
    model,
    contents: [{
      role: "user",
      parts: [
        {
          text: [
            "Identify the Pokemon TCG card shown in this image.",
            "Return only facts that are visibly supported by the card.",
            "Do not guess the set, card number, language, or variant.",
            "Use the exact printed card name where readable.",
            "For setName, use the recognizable set name if it is explicitly identifiable from the card or set symbol; otherwise null.",
            "For cardNumber, preserve the printed number such as 6/165 when readable; otherwise null.",
            "For variant, report only an explicitly visible treatment such as Holo, Reverse Holo, Cracked Ice Holo, Poké Ball pattern, Master Ball pattern, Promo, or Normal when justified by the card.",
            "Do not infer condition from the photograph.",
            "Do not infer quantity unless multiple copies are clearly visible.",
            "Put any uncertainty or ambiguity in confidenceNotes."
          ].join("\n"),
        },
        {
          inlineData: {
            mimeType: mimeTypeFor(filePath),
            data: image.toString("base64"),
          },
        },
      ],
    }],
    config: {
      responseMimeType: "application/json",
      responseSchema: cardImageSchema,
    },
  });

  if (!response.text) throw new Error("Gemini returned no structured card image data.");
  return JSON.parse(response.text) as ParsedCardImage;
}
