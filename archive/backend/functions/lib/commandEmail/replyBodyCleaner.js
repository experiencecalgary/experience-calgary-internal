"use strict";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isForwarded(text, html) {
  return /(^|\n)\s*(?:-{2,}\s*)?(?:begin\s+)?forwarded message\s*(?:-{2,})?/i.test(text) ||
    /(?:moz-forward-container)/i.test(html) ||
    /class=["'][^"']*(?:forward|moz-forward-container)/i.test(html);
}

function cleanReplyText(value) {
  const original = clean(value);
  if (!original || isForwarded(original, "")) return original;

  const separators = [
    // Gmail can wrap the author/address across several lines before "wrote:".
    /^\s*On[ \t]+[\s\S]{3,1200}?\bwrote:\s*$/im,
    // Outlook/Office plain-text header blocks.
    /^\s*From:\s*.+\r?\n\s*(?:Sent|Date):\s*.+\r?\n\s*To:\s*.+(?:\r?\n\s*(?:Cc|Subject):\s*.+){0,2}/im,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^\s*_{5,}\s*$/m,
  ];

  let cutAt = original.length;
  for (const pattern of separators) {
    const match = pattern.exec(original);
    if (match && match.index > 0) cutAt = Math.min(cutAt, match.index);
  }

  const lines = original.slice(0, cutAt).split(/\r?\n/);
  while (lines.length && (/^\s*>/.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) {
    lines.pop();
  }
  const candidate = lines.join("\n").trim();
  return candidate || original;
}

function cleanReplyHtml(value) {
  const original = clean(value);
  if (!original || isForwarded("", original)) return original;

  const candidate = original
    .replace(/<div\b[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i, "")
    .replace(/<blockquote\b[^>]*(?:type=["']cite["'])?[^>]*>[\s\S]*$/i, "")
    .replace(/<div\b[^>]*id=["'](?:divRplyFwdMsg|appendonsend)["'][^>]*>[\s\S]*$/i, "")
    .replace(/<hr\b[^>]*>[\s\S]*?(?:From:|Original Message)[\s\S]*$/i, "")
    .trim();

  return candidate || original;
}

function cleanInboundReply({ bodyText, bodyHtml, isReply }) {
  const rawBodyText = clean(bodyText);
  const rawBodyHtml = clean(bodyHtml) || null;

  if (!isReply || isForwarded(rawBodyText, rawBodyHtml || "")) {
    return {
      bodyText: rawBodyText,
      bodyHtml: rawBodyHtml,
      rawBodyText,
      rawBodyHtml,
      replyHistoryRemoved: false,
    };
  }

  const cleanedText = cleanReplyText(rawBodyText);
  const cleanedHtml = cleanReplyHtml(rawBodyHtml || "");
  const textChanged = cleanedText !== rawBodyText;
  const htmlChanged = (cleanedHtml || null) !== rawBodyHtml;
  const usefulText = cleanedText || rawBodyText;

  // If the plain-text parser confidently removed history but the provider's HTML
  // did not expose a known quote container, prefer clean text over dirty HTML.
  const displayHtml = textChanged && !htmlChanged ? null : (cleanedHtml || null);

  return {
    bodyText: usefulText,
    bodyHtml: displayHtml,
    rawBodyText,
    rawBodyHtml,
    replyHistoryRemoved: textChanged || htmlChanged,
  };
}

module.exports = {
  cleanInboundReply,
  cleanReplyText,
  cleanReplyHtml,
  isForwarded,
};
