"use strict";

const BRAND = {
  name: "Experience Calgary",
  replyTo: "curator@experiencecalgary.ca",
  phone: "403-615-8521",
  logoUrl:
    "https://experiencecalgary.ca/wp-content/uploads/2026/05/Circle-No-Shine-Large-1000.png",

  instagramUrl: "https://www.instagram.com/experience_calgary/",
  facebookUrl:
    "https://www.facebook.com/people/Experience-Calgary/61588930057539/",

  instagramImage:
    "https://experiencecalgary.ca/wp-content/uploads/2026/06/Follow-Instagram.webp",
  facebookImage:
    "https://experiencecalgary.ca/wp-content/uploads/2026/06/Facebook-Follow.webp",
};

function esc(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanUrl(value = "") {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  if (/javascript:/i.test(url)) return "";
  return url;
}

function hasHtml(value = "") {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ""));
}

function normalizeLineBreaks(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function paragraphStyle() {
  return "margin:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.75;color:#d8d8d8 !important;text-align:center;";
}

function formatPlainTextBody(value = "") {
  const blocks = normalizeLineBreaks(value)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const safeBlock = esc(block).replace(/\n/g, "<br>");
      return `<p style="${paragraphStyle()}">${safeBlock}</p>`;
    })
    .join("");
}

function normalizeEmojiImages(html = "") {
  return String(html || "")
    .replace(
      /<img[^>]*class=["'][^"']*emoji[^"']*["'][^>]*alt=["']([^"']*)["'][^>]*>/gi,
      "$1"
    )
    .replace(
      /<img[^>]*alt=["']([^"']*)["'][^>]*class=["'][^"']*emoji[^"']*["'][^>]*>/gi,
      "$1"
    )
    .replace(
      /<img[^>]*draggable=["']false["'][^>]*alt=["']([^"']*)["'][^>]*>/gi,
      "$1"
    )
    .replace(
      /<img[^>]*alt=["']([^"']*)["'][^>]*draggable=["']false["'][^>]*>/gi,
      "$1"
    );
}

function removeUnsafeHtml(html = "") {
  return String(html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, "")
    .replace(/<form[\s\S]*?>[\s\S]*?<\/form>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/\son\w+=\S+/gi, "")
    .replace(/javascript:/gi, "");
}

function styleHtmlBody(value = "") {
  let html = removeUnsafeHtml(normalizeEmojiImages(value));

  html = html
    .replace(/<div><br><\/div>/gi, "<br><br>")
    .replace(/<div>/gi, "<p>")
    .replace(/<\/div>/gi, "</p>");

  html = html.replace(/<p[^>]*>\s*<\/p>/gi, "");

  html = html.replace(/<p\b[^>]*>/gi, `<p style="${paragraphStyle()}">`);

  html = html.replace(
    /<br\s*\/?>\s*<br\s*\/?>/gi,
    `</p><p style="${paragraphStyle()}">`
  );

  if (!/<p\b/i.test(html) && !/<(ul|ol|h2|h3|blockquote|img)\b/i.test(html)) {
    html = `<p style="${paragraphStyle()}">${html}</p>`;
  }

  html = html.replace(
    /<h2\b[^>]*>/gi,
    '<h2 style="margin:30px 0 14px 0;font-family:Georgia,serif;font-size:28px;line-height:1.2;font-weight:400;color:#ffffff !important;text-align:center;">'
  );

  html = html.replace(
    /<h3\b[^>]*>/gi,
    '<h3 style="margin:26px 0 12px 0;font-family:Georgia,serif;font-size:22px;line-height:1.25;font-weight:400;color:#d8b568 !important;text-align:center;">'
  );

  html = html.replace(
    /<ul\b[^>]*>/gi,
    '<ul style="margin:20px auto 22px auto;padding-left:22px;max-width:500px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;color:#d8d8d8 !important;text-align:left;">'
  );

  html = html.replace(
    /<ol\b[^>]*>/gi,
    '<ol style="margin:20px auto 22px auto;padding-left:22px;max-width:500px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;color:#d8d8d8 !important;text-align:left;">'
  );

  html = html.replace(
    /<li\b[^>]*>/gi,
    '<li style="margin:0 0 10px 0;color:#d8d8d8 !important;">'
  );

  html = html.replace(
    /<blockquote\b[^>]*>/gi,
    '<blockquote style="margin:26px auto;padding:18px 22px;max-width:500px;border-left:3px solid #c9983c;background:#080808 !important;font-family:Georgia,serif;font-size:18px;line-height:1.6;color:#ffffff !important;text-align:left;">'
  );

  html = html.replace(
    /<hr\b[^>]*>/gi,
    '<div style="height:1px;background:#2a1e0c;margin:30px auto;width:80%;"></div>'
  );

  html = html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    const href = hrefMatch ? cleanUrl(hrefMatch[1]) : "";
    if (!href) return "<span>";
    return `<a href="${esc(href)}" target="_blank" style="color:#d8b568 !important;text-decoration:underline;">`;
  });

  html = html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    const altMatch = attrs.match(/alt=["']([^"']*)["']/i);

    const src = srcMatch ? cleanUrl(srcMatch[1]) : "";
    const alt = altMatch ? esc(altMatch[1]) : "";

    if (!src) return "";

    return `<img src="${esc(src)}" alt="${alt}" width="520" style="display:block;width:100%;max-width:520px;height:auto;margin:24px auto;border:0;border-radius:16px;">`;
  });

  html = html.replace(
    /<\/?(?!p|br|strong|b|em|i|u|h2|h3|ul|ol|li|blockquote|a|img|span|div)\w+[^>]*>/gi,
    ""
  );

  return html;
}

function buildBodyHtml(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (hasHtml(raw)) {
    return styleHtmlBody(raw);
  }

  return formatPlainTextBody(raw);
}

function buildButtonHtml(buttonText, buttonUrl) {
  if (!buttonText || !buttonUrl) return "";

  return `
    <tr>
      <td align="center" style="padding-top:36px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" class="ec-button-table">
          <tr>
            <td align="center" bgcolor="#c9983c" class="ec-button-td" style="border-radius:999px;background:#c9983c !important;background-image:linear-gradient(90deg,#8b5a20 0%,#c9983c 25%,#fff0b8 50%,#c9983c 75%,#8b5a20 100%) !important;mso-padding-alt:14px 50px;">
              <a href="${esc(buttonUrl)}" target="_blank" class="ec-button-link" style="display:inline-block;padding:14px 50px;border-radius:999px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.2;font-weight:700;color:#050505 !important;text-decoration:none !important;letter-spacing:.03em;background:#c9983c !important;background-image:linear-gradient(90deg,#8b5a20 0%,#c9983c 25%,#fff0b8 50%,#c9983c 75%,#8b5a20 100%) !important;">
                ${buttonText}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function buildSocialHtml() {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" class="ec-social-desktop" style="margin:0 auto 26px auto;">
      <tr>
        <td align="center" width="250" style="width:250px;padding:0 8px;">
          <a href="${BRAND.instagramUrl}" target="_blank" style="display:block;text-decoration:none;line-height:0;">
            <img src="${BRAND.instagramImage}" alt="Follow Experience Calgary on Instagram" width="250" style="display:block;width:250px;max-width:250px;height:auto;border:0;border-radius:999px;">
          </a>
        </td>
        <td align="center" width="250" style="width:250px;padding:0 8px;">
          <a href="${BRAND.facebookUrl}" target="_blank" style="display:block;text-decoration:none;line-height:0;">
            <img src="${BRAND.facebookImage}" alt="Follow Experience Calgary on Facebook" width="250" style="display:block;width:250px;max-width:250px;height:auto;border:0;border-radius:999px;">
          </a>
        </td>
      </tr>
    </table>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" class="ec-social-mobile" style="display:none;mso-hide:all;margin:0 auto 24px auto;">
      <tr>
        <td align="center" style="padding:0 0 12px 0;">
          <a href="${BRAND.instagramUrl}" target="_blank" style="display:block;text-decoration:none;line-height:0;">
            <img src="${BRAND.instagramImage}" alt="Follow Experience Calgary on Instagram" width="250" style="display:block;width:250px;max-width:250px;height:auto;border:0;border-radius:999px;">
          </a>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0;">
          <a href="${BRAND.facebookUrl}" target="_blank" style="display:block;text-decoration:none;line-height:0;">
            <img src="${BRAND.facebookImage}" alt="Follow Experience Calgary on Facebook" width="250" style="display:block;width:250px;max-width:250px;height:auto;border:0;border-radius:999px;">
          </a>
        </td>
      </tr>
    </table>`;
}

function buildEmailHtml(payload = {}) {
  const subject = esc(payload.subject || "");
  const preheader = esc(payload.preheader || "");
  const heroImageUrl = cleanUrl(payload.heroImageUrl || "");
  const headline = esc(payload.headline || "Experience Calgary");
  const body = buildBodyHtml(payload.body || "");
  const buttonText = esc(payload.buttonText || "");
  const buttonUrl = cleanUrl(payload.buttonUrl || "");

  const heroHtml = heroImageUrl
    ? `
      <tr>
        <td bgcolor="#000000" style="background:#000000 !important;">
          <img src="${esc(heroImageUrl)}" alt="" width="680" style="display:block;width:100%;max-width:680px;height:auto;border:0;margin:0 auto;">
        </td>
      </tr>`
    : "";

  const buttonHtml = buildButtonHtml(buttonText, buttonUrl);
  const socialHtml = buildSocialHtml();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="only light">
  <meta name="supported-color-schemes" content="only light">
  <title>${subject}</title>

  <style>
    :root {
      color-scheme: only light;
      supported-color-schemes: only light;
    }

    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
      background: #050505 !important;
      color: #ffffff !important;
    }

    body,
    table,
    td,
    div,
    p,
    a {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }

    table,
    td {
      border-collapse: collapse;
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }

    img {
      border: 0;
      outline: none;
      text-decoration: none;
      -ms-interpolation-mode: bicubic;
    }

    a {
      color: inherit;
    }

    u + .body .ec-bg {
      background: #050505 !important;
    }

    .ec-bg {
      background: #050505 !important;
    }

    .ec-card {
      background: #000000 !important;
    }

    .ec-header {
      background: #000000 !important;
    }

    .ec-content {
      background: #000000 !important;
    }

    .ec-footer {
      background: #030303 !important;
    }

    .ec-white {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }

    .ec-gold {
      color: #d8b568 !important;
      -webkit-text-fill-color: #d8b568 !important;
    }

    .ec-muted {
      color: #9d9d9d !important;
      -webkit-text-fill-color: #9d9d9d !important;
    }

    .ec-text,
    .ec-text p,
    .ec-text div,
    .ec-text span,
    .ec-text li {
      color: #d8d8d8 !important;
      -webkit-text-fill-color: #d8d8d8 !important;
    }

    .ec-button-td,
    .ec-button-link {
      background: #c9983c !important;
      background-image: linear-gradient(90deg,#8b5a20 0%,#c9983c 25%,#fff0b8 50%,#c9983c 75%,#8b5a20 100%) !important;
      color: #050505 !important;
      -webkit-text-fill-color: #050505 !important;
    }

    @media (prefers-color-scheme: dark) {
      html,
      body,
      .ec-bg {
        background: #050505 !important;
        color: #ffffff !important;
      }

      .ec-card,
      .ec-card td,
      .ec-header,
      .ec-content {
        background: #000000 !important;
        color: #ffffff !important;
      }

      .ec-footer,
      .ec-footer td {
        background: #030303 !important;
      }

      .ec-white {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      .ec-gold {
        color: #d8b568 !important;
        -webkit-text-fill-color: #d8b568 !important;
      }

      .ec-muted {
        color: #9d9d9d !important;
        -webkit-text-fill-color: #9d9d9d !important;
      }

      .ec-text,
      .ec-text p,
      .ec-text div,
      .ec-text span,
      .ec-text li {
        color: #d8d8d8 !important;
        -webkit-text-fill-color: #d8d8d8 !important;
      }

      .ec-button-td,
      .ec-button-link {
        background: #c9983c !important;
        background-image: linear-gradient(90deg,#8b5a20 0%,#c9983c 25%,#fff0b8 50%,#c9983c 75%,#8b5a20 100%) !important;
        color: #050505 !important;
        -webkit-text-fill-color: #050505 !important;
      }
    }

    [data-ogsc] body,
    [data-ogsc] .ec-bg {
      background: #050505 !important;
    }

    [data-ogsc] .ec-card,
    [data-ogsc] .ec-card td,
    [data-ogsc] .ec-header,
    [data-ogsc] .ec-content {
      background: #000000 !important;
      color: #ffffff !important;
    }

    [data-ogsc] .ec-footer,
    [data-ogsc] .ec-footer td {
      background: #030303 !important;
    }

    [data-ogsc] .ec-text,
    [data-ogsc] .ec-text p,
    [data-ogsc] .ec-text div,
    [data-ogsc] .ec-text span,
    [data-ogsc] .ec-text li {
      color: #d8d8d8 !important;
    }

    [data-ogsc] .ec-button-td,
    [data-ogsc] .ec-button-link {
      background: #c9983c !important;
      background-image: linear-gradient(90deg,#8b5a20 0%,#c9983c 25%,#fff0b8 50%,#c9983c 75%,#8b5a20 100%) !important;
      color: #050505 !important;
    }

    @media only screen and (max-width: 520px) {
      .ec-outer {
        padding: 24px 10px !important;
      }

      .ec-card {
        width: 100% !important;
        max-width: 100% !important;
        border-radius: 22px !important;
      }

      .ec-header {
        padding: 32px 20px 28px !important;
      }

      .ec-logo {
        width: 60px !important;
        height: 60px !important;
      }

      .ec-brand {
        font-size: 29px !important;
      }

      .ec-content {
        padding: 34px 24px 36px !important;
      }

      .ec-badge {
        display: none !important;
      }

      .ec-headline {
        font-size: 34px !important;
        line-height: 1.08 !important;
        margin-bottom: 24px !important;
      }

      .ec-text,
      .ec-text p,
      .ec-text div,
      .ec-text span,
      .ec-text li {
        font-size: 15px !important;
        line-height: 1.75 !important;
      }

      .ec-button-link {
        padding: 13px 34px !important;
        font-size: 14px !important;
      }

      .ec-social-desktop {
        display: none !important;
        mso-hide: all !important;
        max-height: 0 !important;
        overflow: hidden !important;
      }

      .ec-social-mobile {
        display: table !important;
        mso-hide: none !important;
      }
    }
  </style>
</head>

<body class="body" bgcolor="#050505" style="margin:0;padding:0;background:#050505 !important;color:#ffffff !important;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${preheader}
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#050505" class="ec-bg" style="background:#050505 !important;margin:0;padding:36px 14px;">
    <tr>
      <td align="center" bgcolor="#050505" class="ec-bg ec-outer" style="background:#050505 !important;padding:0;">

        <table role="presentation" width="680" cellspacing="0" cellpadding="0" border="0" bgcolor="#000000" class="ec-card" style="width:100%;max-width:680px;background:#000000 !important;border:1px solid #3a2a10;border-radius:22px;overflow:hidden;">
          
          <tr>
            <td align="center" bgcolor="#000000" class="ec-header" style="background:#000000 !important;padding:34px 24px 34px;border-bottom:1px solid #2a1e0c;">
              <img class="ec-logo" src="${BRAND.logoUrl}" alt="${BRAND.name}" width="64" height="64" style="display:block;width:64px;height:64px;margin:0 auto 16px;border:0;">
              <div class="ec-gold ec-brand" style="font-family:Georgia,serif;font-size:32px;line-height:1.1;color:#d8b568 !important;-webkit-text-fill-color:#d8b568 !important;">
                ${BRAND.name}
              </div>
            </td>
          </tr>

          ${heroHtml}

          <tr>
            <td align="center" bgcolor="#000000" class="ec-content" style="background:#000000 !important;padding:56px 44px 62px;">
              <div class="ec-gold ec-badge" style="display:inline-block;margin-bottom:26px;padding:7px 15px;border:1px solid #5b451c;border-radius:999px;color:#d8b568 !important;-webkit-text-fill-color:#d8b568 !important;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;">
                Access The Exceptional
              </div>

              <h1 class="ec-white ec-headline" style="margin:0 0 26px;font-family:Georgia,serif;font-size:42px;line-height:1.1;font-weight:400;color:#ffffff !important;-webkit-text-fill-color:#ffffff !important;text-align:center;">
                ${headline}
              </h1>

              <div class="ec-text" style="max-width:540px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.75;color:#d8d8d8 !important;-webkit-text-fill-color:#d8d8d8 !important;text-align:center;">
                ${body}
              </div>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="ec-button">
                ${buttonHtml}
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" bgcolor="#030303" class="ec-footer" style="background:#030303 !important;padding:36px 24px;border-top:1px solid #2a1e0c;">
              <div style="width:64px;height:1px;background:#b98a32;margin:0 auto 22px;"></div>

              ${socialHtml}

              <div class="ec-gold" style="font-family:Georgia,serif;color:#d8b568 !important;-webkit-text-fill-color:#d8b568 !important;font-size:20px;margin-bottom:7px;">
                ${BRAND.name}
              </div>

              <div class="ec-muted" style="font-family:Arial,Helvetica,sans-serif;color:#9d9d9d !important;-webkit-text-fill-color:#9d9d9d !important;font-size:12px;line-height:1.6;">
                Curation Team<br>
                Phone: ${BRAND.phone}<br>
                Email: <a href="mailto:${BRAND.replyTo}" class="ec-muted" style="color:#9d9d9d !important;-webkit-text-fill-color:#9d9d9d !important;text-decoration:none;">${BRAND.replyTo}</a>
              </div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  BRAND,
  buildEmailHtml,
};