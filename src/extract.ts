import { readFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

export interface InvoiceLineItem {
  productName: string | null;
  setName: string | null;
  cardNumber: string | null;
  condition: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
}

export interface InvoiceData {
  seller: string | null;
  purchaseDate: string | null;
  orderId: string | null;
  subtotal: number | null;
  shipping: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
  lineItems: InvoiceLineItem[];
  uncertainFields: string[];
}

const geminiApiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is missing from .env");
}

const gemini = new GoogleGenAI({ apiKey: geminiApiKey });

const invoiceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    seller: { type: ["string", "null"] },
    purchaseDate: { type: ["string", "null"] },
    orderId: { type: ["string", "null"] },
    subtotal: { type: ["number", "null"] },
    shipping: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          productName: { type: ["string", "null"] },
          setName: { type: ["string", "null"] },
          cardNumber: { type: ["string", "null"] },
          condition: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          totalPrice: { type: ["number", "null"] },
        },
        required: [
          "productName",
          "setName",
          "cardNumber",
          "condition",
          "quantity",
          "unitPrice",
          "totalPrice",
        ],
      },
    },
    uncertainFields: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "seller",
    "purchaseDate",
    "orderId",
    "subtotal",
    "shipping",
    "tax",
    "total",
    "currency",
    "lineItems",
    "uncertainFields",
  ],
} as const;

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

export async function extractInvoice(filePath: string): Promise<InvoiceData> {
  const image = await readFile(filePath);
  const response = await gemini.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Extract the purchase information from this TCGPlayer invoice image.",
              "Return only information that is actually visible in the invoice.",
              "Do not guess missing values. Use null for missing values.",
              "Keep prices as numbers without currency symbols.",
              "Use the invoice's currency code when visible; otherwise use null.",
              "Use an ISO date (YYYY-MM-DD) when the purchase date is clear.",
              "For each purchased card, preserve the exact product name shown.",
              "If a field is difficult to read or ambiguous, add its field name to uncertainFields.",
            ].join("\n"),
          },
          {
            inlineData: {
              mimeType: mimeTypeFor(filePath),
              data: image.toString("base64"),
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: invoiceSchema,
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned no structured invoice data.");
  }

  return JSON.parse(response.text) as InvoiceData;
}
