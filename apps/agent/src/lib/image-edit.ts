import { generateImage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// Synthesizes a customer's "supporting photo" for a damage claim by editing the real
// product photo rather than inventing an unrelated image — used at seed time so demo
// escalation threads that hinge on photo evidence actually carry one, not just a line of
// dialogue claiming one was sent. generateImage with an `images` input turns the call
// into a real edit, not a fresh generation.
//
// Requires OPENAI_API_KEY. Callers should treat a missing key or a failed call as "skip
// the photo" — this is seed-time flavor for the demo, not a path anything else depends on.
export async function editProductPhotoForDamage(imageBuffer: Buffer, damageDescription: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const openai = createOpenAI({ apiKey });
  const prompt =
    `${damageDescription}. This is meant to look like a customer's own phone photo showing ` +
    `the reported damage on arrival, not a studio product shot — keep the item, framing, and ` +
    `background close to the original, but render it a little less polished and add the ` +
    `described damage clearly and visibly.`;

  const res = await generateImage({
    model: openai.imageModel("gpt-image-1"),
    prompt: { text: prompt, images: [imageBuffer] },
    // Default is 2 retries (3 attempts total) — fine for a real transient blip, wasted
    // time when the failure is permanent (e.g. no API credits), since the SDK doesn't
    // distinguish the two. One retry still covers a genuine blip without seeding taking
    // noticeably longer when it's not going to succeed regardless.
    maxRetries: 1,
  });
  if (!res.image?.base64) throw new Error("No image data returned from the image-edit call");
  return res.image.base64;
}
