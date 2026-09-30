import { readFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

export interface InvoiceLineItem {
  productName: string | null;
  setName: string | null;
  cardNumber: string | null;
  condition: string | null;
  rarity: string | null;
  language: string | null;
  variant: string | null;
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
const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

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
          rarity: { type: ["string", "null"] },
          language: { type: ["string", "null"] },
          variant: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          totalPrice: { type: ["number", "null"] },
        },
        required: [
          "productName",
          "setName",
          "cardNumber",
          "condition",
          "rarity",
          "language",
          "variant",
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
              "Treat the invoice as a structured table and preserve the relationship between columns on each row.",
              "The table columns are Items, Details, Price, and Quantity.",
              "Items contains the purchased product name; directly underneath that name is the set name for the same row.",
              "Details contains the rarity on one line and the condition/printing information on the next line for that same row.",
              "Price contains the unit price for that row only. Quantity contains the quantity for that row only.",
              "Do not shift values between neighboring rows or columns. Each lineItem must correspond to exactly one visible table row.",
              "Return only information that is actually visible in the invoice.",
              "Do not guess missing values. Use null for missing values.",
              "Keep prices as numbers without currency symbols.",
              "Use the invoice's currency code when visible; otherwise use null.",
              "Use an ISO date (YYYY-MM-DD) when the purchase date is clear.",
              "For each row, preserve the exact product name shown in the Items column. The product name may itself contain identifiers such as Full Art, Secret, EX, illustration-related wording, Poké Ball pattern, or a card number.",
              "Extract setName from the text directly beneath the product name, not from a different row.",
              "If a card number such as 025/165 is visibly included in the item text, extract it as cardNumber; otherwise use null.",
              "Extract rarity from the rarity line in Details, separately from condition.",
              "If Details says something like 'Near Mint Holofoil', set condition to 'Near Mint' and variant to exactly 'Holofoil'. If it says 'Near Mint Reverse Holofoil', set condition to 'Near Mint' and variant to exactly 'Reverse Holofoil'.",
              "Do not output the generic variant label 'Foil' when the invoice identifies Holofoil or Reverse Holofoil. Use exactly 'Holofoil' or 'Reverse Holofoil' so the value falls within the inventory import's supported range.",
              "Do not treat the condition word itself as a variant. Preserve explicit printing treatments such as Holofoil, Reverse Holofoil, 1st Edition, Unlimited, Promo, Full Art, Poké Ball pattern, or Master Ball pattern when supported by the row.",
              "Extract quantity only from the Quantity column and unitPrice only from the Price column.",
              "Calculate totalPrice as unitPrice multiplied by quantity only when both values are clearly present and the arithmetic agrees with the invoice; otherwise use the visible row total if one exists or null.",
              "If a field is difficult to read or ambiguous, add its field name and row number to uncertainFields."
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
