/**
 * ДКП-бот — отдельный Telegram-бот для оформления договора купли-продажи ТС.
 * Открывает Mini App, где пользователь загружает паспорт/СТС, проверяет
 * распознанные поля и получает готовый ДОГОВОР (DOCX + PDF) в чат.
 *
 * Секреты (Cloudflare → Worker → Variables and Secrets → Secret):
 *   TELEGRAM_BOT_TOKEN — токен бота (@BotFather)
 *   ANTHROPIC_API_KEY  — ключ Claude Vision (для авто-распознавания; опц.)
 * Публичные переменные ([vars] в wrangler.toml):
 *   MINI_APP_URL — адрес мини-аппа (страница на Cloudflare Pages)
 */

const enc = new TextEncoder();

/* ---------- Telegram API ---------- */
function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Отправка файла из base64 как документа в чат.
async function sendDocument(env, chatId, filename, base64, caption) {
  const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  fd.append("document", new Blob([bin]), filename);
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd,
  });
}

/* ---------- Auth: проверка Telegram initData ---------- */
async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
}
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash");
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  if (toHex(await hmac(secret, enc.encode(dcs))) !== hash) return { ok: false };
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return { ok: false };
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch { /* ignore */ }
  if (!user?.id) return { ok: false };
  return { ok: true, user };
}

/* ---------- CORS ---------- */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", ...cors },
  });

/* ---------- Claude Vision: распознавание паспорта / СТС ---------- */
const PROMPTS = {
  passport:
    "На изображении — разворот паспорта гражданина РФ. Извлеки данные и верни СТРОГО JSON " +
    "без пояснений с ключами: fio (ФИО полностью), birth (дата рождения ДД.ММ.ГГГГ), " +
    "birthplace (место рождения), pasp_series (серия, 4 цифры), pasp_number (номер, 6 цифр), " +
    "pasp_issued_by (кем выдан), pasp_issued_date (дата выдачи ДД.ММ.ГГГГ), pasp_code " +
    "(код подразделения), address (адрес регистрации, если виден, иначе пустая строка). " +
    "Если поле не читается — пустая строка.",
  org_card:
    "На изображении — карточка организации (реквизиты юрлица или ИП). Извлеки данные и верни " +
    "СТРОГО JSON без пояснений с ключами: org_name (полное или краткое наименование, напр. " +
    "ООО «...» или ИП Фамилия И.О.), ogrn (ОГРН или ОГРНИП), inn (ИНН), kpp (КПП; для ИП — " +
    "пустая строка), signer_role (должность подписанта в родительном падеже, напр. «директора»; " +
    "для ИП — пустая строка), signer_fio (ФИО руководителя или ИП), basis (на основании чего " +
    "действует: «Устава» для ООО или «свидетельства о государственной регистрации» для ИП), " +
    "address (юридический/почтовый адрес). Если поле не читается — пустая строка.",
  sts:
    "На изображении — свидетельство о регистрации ТС (СТС) РФ. Извлеки данные и верни СТРОГО " +
    "JSON без пояснений с ключами: car_brand (марка, модель), car_vin (VIN), car_type (тип ТС), " +
    "car_category (категория), car_year (год выпуска), car_engine (модель и № двигателя), " +
    "car_chassis (шасси/рама №), car_body (кузов №), car_color (цвет), car_power (мощность л.с.), " +
    "car_volume (рабочий объём, куб.см), car_plate (госномер), pts_series (серия ПТС), " +
    "pts_number (номер ПТС), sts_series (серия СТС), sts_number (номер СТС). " +
    "Если поле не читается — пустая строка.",
};

async function recognize(env, imageDataUrl, kind) {
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(imageDataUrl || "");
  if (!m) return { error: "bad_image" };
  const [, mediaType, data] = m;
  if (env.YANDEX_API_KEY) return recognizeYandex(env, mediaType, data, kind);
  if (env.ANTHROPIC_API_KEY) return recognizeAnthropic(env, mediaType, data, kind);
  return { error: "no_api_key" };
}

/* ---------- Yandex Vision OCR (модели под паспорт РФ и СТС) ---------- */
const YA_MODEL = {
  passport: "passport", sts: "vehicle-registration-front",
  sts_back: "vehicle-registration-back", pts: "page", org_card: "page", reg: "page",
};

// Один вызов OCR Яндекса с заданной моделью → { entities, fullText } или { error }.
async function yandexOcr(env, mediaType, data, model) {
  const headers = {
    "content-type": "application/json",
    Authorization: "Api-Key " + env.YANDEX_API_KEY,
  };
  if (env.YANDEX_FOLDER_ID) headers["x-folder-id"] = env.YANDEX_FOLDER_ID;
  const r = await fetch("https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText", {
    method: "POST",
    headers,
    body: JSON.stringify({ mimeType: mediaType, languageCodes: ["ru", "en"], model, content: data }),
  });
  if (!r.ok) return { error: "vision_failed", status: r.status, detail: (await r.text().catch(() => "")).slice(0, 300) };
  const raw = await r.text();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { try { parsed = JSON.parse(raw.split("\n").filter(Boolean)[0]); } catch { return { error: "parse_failed" }; } }
  const ann = parsed.result?.textAnnotation || {};
  return { entities: ann.entities || [], fullText: ann.fullText || "" };
}

// YandexGPT: извлекает поля ДКП из распознанного текста документа в JSON.
const GPT_PROMPT =
  "Ты извлекаешь данные из распознанного (OCR) текста российских документов: паспорт РФ, " +
  "ПТС, СТС, карточка организации. Верни СТРОГО JSON без пояснений, только с полями, которые " +
  "реально присутствуют в тексте (остальные не включай). Возможные ключи и правила:\n" +
  "fio (ФИО полностью, с заглавных), birth (дата рождения ДД.ММ.ГГГГ), birthplace (место рождения), " +
  "pasp_series (4 цифры), pasp_number (6 цифр), pasp_issued_by (кем выдан), pasp_issued_date (ДД.ММ.ГГГГ), " +
  "pasp_code (код подразделения NNN-NNN), address (адрес регистрации/собственника).\n" +
  "car_brand (поле «Марка, модель» ТОЧНО как в документе, одной строкой; НЕ сокращай, НЕ переводи и " +
  "НЕ нормализуй — напр. «BMW 320I XDRIVE», а НЕ «BMW 3er»), car_vin (VIN, 17 симв.), car_type (тип ТС, напр. «Легковой седан»), " +
  "car_category (только буква категории до «/», напр. из «В/M1» → «B»), car_year (год выпуска/" +
  "изготовления ТС, 4 цифры; НЕ путать с датой выдачи документа), " +
  "car_engine (модель и № двигателя), car_chassis (шасси/рама №, может быть «ОТСУТСТВУЕТ»), " +
  "car_body (кузов №), car_color (цвет), car_power (мощность В ЛОШАДИНЫХ СИЛАХ — если указано «л.с./кВт» " +
  "или «кВт/л.с.», бери ЛОШАДИНЫЕ силы = БОЛЬШЕЕ из двух чисел), car_volume (рабочий объём, куб.см), " +
  "car_plate (госномер), pts_series (серия ПТС, напр. «50 РУ»), pts_number (номер ПТС, 6 цифр), " +
  "pts_issued (организация, выдавшая ПТС + дата выдачи), sts_series (серия СТС), sts_number (номер СТС).\n" +
  "org_name, ogrn, inn, kpp, signer_role, signer_fio, basis — для юрлиц/ИП.\n" +
  "Латиницу/цифры в номерах сохраняй как в тексте. Значения «ОТСУТСТВУЕТ»/«НЕ УСТАНОВЛЕНО» оставляй как есть.";

async function yandexGptExtract(env, fullText) {
  try {
    const r = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Api-Key " + env.YANDEX_API_KEY },
      body: JSON.stringify({
        modelUri: `gpt://${env.YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { temperature: 0, maxTokens: 1000 },
        messages: [
          { role: "system", text: GPT_PROMPT },
          { role: "user", text: fullText.slice(0, 6000) },
        ],
      }),
    });
    if (!r.ok) return null;
    const out = await r.json();
    const text = out.result?.alternatives?.[0]?.message?.text || "";
    const j = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const obj = JSON.parse(j);
    // оставляем только непустые строковые значения
    const clean = {};
    for (const k in obj) { const v = obj[k]; if (typeof v === "string" && v.trim()) clean[k] = v.trim(); }
    return clean;
  } catch { return null; }
}

// Узкий экстрактор адреса прописки из текста страницы регистрации паспорта.
async function yandexGptAddress(env, fullText) {
  try {
    const r = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Api-Key " + env.YANDEX_API_KEY },
      body: JSON.stringify({
        modelUri: `gpt://${env.YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { temperature: 0, maxTokens: 200 },
        messages: [
          { role: "system", text:
            "На входе — распознанный текст страницы регистрации (прописки) паспорта РФ. " +
            "Собери адрес регистрации ОДНОЙ строкой в порядке: индекс (если есть), область/край/респ., " +
            "район (если есть), город/населённый пункт, улица, дом, корпус, квартира. " +
            "НЕ включай слова «зарегистрирован», «место жительства», даты, наименования органов " +
            "(УФМС/ФМС/МВД/отдел по вопросам миграции), коды подразделений, подписи. " +
            "Сокращения приведи к виду: «обл.», «г.», «ул.», «д.», «кв.». " +
            "Верни СТРОГО JSON {\"address\":\"...\"}. Если адреса нет — {\"address\":\"\"}." },
          { role: "user", text: (fullText || "").slice(0, 4000) },
        ],
      }),
    });
    if (!r.ok) return "";
    const out = await r.json();
    const text = out.result?.alternatives?.[0]?.message?.text || "";
    const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return typeof obj.address === "string" ? obj.address.trim() : "";
  } catch { return ""; }
}

// Узкий экстрактор органа, выдавшего паспорт (дословно, без выдумок).
async function yandexGptIssuer(env, fullText) {
  try {
    const r = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Api-Key " + env.YANDEX_API_KEY },
      body: JSON.stringify({
        modelUri: `gpt://${env.YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { temperature: 0, maxTokens: 200 },
        messages: [
          { role: "system", text:
            "На входе — распознанный текст страницы паспорта РФ. Извлеки орган, выдавший паспорт " +
            "(заголовок сверху и/или строка у надписи «Паспорт выдан»), например: " +
            "«ГУ МВД РОССИИ ПО Г. МОСКВЕ», «ОТДЕЛОМ УФМС РОССИИ ПО ТВЕРСКОЙ ОБЛ. В ВЫШНЕВОЛОЦКОМ Р-НЕ». " +
            "Верни ДОСЛОВНО как в тексте, ЗАГЛАВНЫМИ буквами. НИЧЕГО не добавляй и не выдумывай: " +
            "если района/города нет в тексте — не дописывай их. Верни СТРОГО JSON {\"issuer\":\"...\"}. " +
            "Если органа в тексте нет — {\"issuer\":\"\"}." },
          { role: "user", text: (fullText || "").slice(0, 4000) },
        ],
      }),
    });
    if (!r.ok) return "";
    const out = await r.json();
    const text = out.result?.alternatives?.[0]?.message?.text || "";
    const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return typeof obj.issuer === "string" ? obj.issuer.trim() : "";
  } catch { return ""; }
}

async function recognizeYandex(env, mediaType, data, kind) {
  const res = await yandexOcr(env, mediaType, data, YA_MODEL[kind] || "page");
  if (res.error) return res;
  let { entities, fullText } = res;
  // Модели passport/sts не отдают сплошной текст — добираем page-OCR
  // для «кем выдан» (паспорт) и недостающих полей СТС (тип/категория/двигатель/кузов).
  if (kind === "passport" || kind === "sts" || kind === "sts_back") {
    const page = await yandexOcr(env, mediaType, data, "page");
    if (!page.error && page.fullText) fullText = page.fullText;
  }
  const fields = kind === "passport" ? mapPassport(entities, fullText)
    : (kind === "sts" || kind === "sts_back") ? mapSts(entities, fullText)
    : kind === "pts" ? mapPts(fullText)
    : kind === "reg" ? mapReg(fullText)
    : mapOrg(fullText);
  // YandexGPT добирает поля из распознанного текста (устойчиво к разным формам ПТС/СТС).
  if (kind === "reg" && env.YANDEX_FOLDER_ID && fullText) {
    // Страница прописки: адрес собираем узким промптом (чище, чем регэксп mapReg).
    const a = await yandexGptAddress(env, fullText);
    if (a) fields.address = a;
  } else if (fullText && env.YANDEX_FOLDER_ID) {
    const gpt = await yandexGptExtract(env, fullText);
    // Марку и серию/номер СТС GPT не доверяем (нормализует/путает) — берём из документа.
    const skip = { car_brand: 1, sts_series: 1, sts_number: 1, pasp_issued_by: 1 };
    if (gpt) for (const k in gpt) { if (skip[k]) continue; if (gpt[k] && !fields[k]) fields[k] = gpt[k]; }
  }
  // Паспорт: «кем выдан» — узкий GPT-экстрактор (дословно как в документе); регэксп mapPassport остаётся запасным.
  if (kind === "passport" && env.YANDEX_FOLDER_ID && fullText) {
    const iss = await yandexGptIssuer(env, fullText);
    if (iss) fields.pasp_issued_by = iss;
  }
  // Марка/модель: спецмодель СТС нормализует (напр. «3er») — предпочитаем литеральный текст документа.
  if (kind === "sts" || kind === "sts_back" || kind === "pts") {
    const lit = brandFromText(fullText);
    if (lit) fields.car_brand = lit;
    if (fields.car_brand) fields.car_brand = fields.car_brand.toUpperCase();
  }
  let _gender;
  if (kind === "passport") {
    const g = (entities.find((e) => (e.name || "").toLowerCase() === "gender")?.text || "").trim().toLowerCase();
    if (/^[мm]/.test(g)) _gender = "m"; else if (/^[жf]/.test(g)) _gender = "f";
  }
  return { fields, _gender };
}

// Карта сущностей по точному имени (lowercase) — Яндекс отдаёт name/surname/...
function entMap(entities) {
  const m = {};
  for (const e of entities) {
    const k = (e.name || "").toLowerCase();
    if (k && !(k in m)) m[k] = (e.text || "").trim();
  }
  return m;
}
const pick = (m, ...names) => { for (const n of names) if (m[n]) return m[n]; return ""; };
// «МОКИЕНКО иван» → «Мокиенко Иван»
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-])([^\s\-])/g, (_, p, c) => p + c.toUpperCase());

function mapPassport(entities, fullText) {
  const m = entMap(entities);
  const last = pick(m, "surname", "last_name");
  const first = pick(m, "name", "first_name", "given_name");
  const middle = pick(m, "patronymic", "middle_name");
  const fio = titleCase([last, first, middle].filter(Boolean).join(" "));
  let series = "", number = "";
  const sn = (pick(m, "series_and_number", "number") || ((m.series || "") + (m.number || ""))).replace(/\D/g, "");
  if (sn.length >= 10) { series = sn.slice(0, 4); number = sn.slice(4, 10); }
  const f = {
    fio,
    birth: pick(m, "birth_date", "birthdate", "date_of_birth"),
    birthplace: titleCase(pick(m, "birth_place", "place_of_birth")),
    pasp_series: series,
    pasp_number: number,
    pasp_issued_by: pick(m, "issued_by", "issuing_authority", "authority"),
    pasp_issued_date: pick(m, "issue_date", "date_of_issue"),
    pasp_code: pick(m, "subdivision", "subdivision_code", "department_code", "division_code", "code"),
  };
  // Запасные разборы из общего текста.
  if (!f.pasp_series) {
    const mm = fullText.replace(/\s/g, "").match(/(\d{4})(\d{6})/);
    if (mm) { f.pasp_series = mm[1]; f.pasp_number = mm[2]; }
  }
  if (!f.pasp_code) {
    const c = fullText.match(/\b(\d{3})\s*-\s*(\d{3})\b/);
    if (c) f.pasp_code = c[1] + "-" + c[2];
  }
  // «Кем выдан»: достаём орган КАК НАПЕЧАТАНО (обычно заглавными), ограничивая
  // до меток «Паспорт выдан / Дата выдачи / Код». GPT для этого поля не используем.
  if (!f.pasp_issued_by && fullText) {
    const t = fullText.replace(/\s+/g, " ");
    let by = "";
    const m2 = t.match(/((?:ГУ|ГУВД|УВД|ОВД|ОУ|ТП|МП|ОТДЕЛ\w*|ОТДЕЛЕНИ\w*|УПРАВЛЕНИ\w*)?\.?\s?(?:МВД|УФМС|ФМС|МИЛИЦИИ|ПОЛИЦИИ)\s+РОССИ[ЙИ][^0-9]{0,100}?(?:Г\.?\s?[А-ЯЁ][А-ЯЁа-яё.\- ]*?|ОБЛ\w*|КРА\w*|РЕСПУБЛИК\w*)(?:\s+ПО\s+РАЙОНУ\s+[А-ЯЁ][А-ЯЁа-яё.\- ]*?)?)(?=\s*(?:паспорт|дата|код|\d{2}[.\-]\d{2}[.\-]\d{4})|$)/i);
    if (m2) by = m2[1];
    if (!by) {
      const m1 = t.match(/паспорт\s+выдан[\s:.]+([А-ЯЁ][^0-9]{6,90}?)\s*(?:дата|код|\d{2}[.\-]\d{2}[.\-]\d{4})/i);
      if (m1) by = m1[1];
    }
    if (by) f.pasp_issued_by = by.replace(/^[\s.,№-]+|[\s.,]+$/g, "").replace(/\s+/g, " ");
  }
  return f;
}
// Граница значения — перед следующей подписью (общая для СТС/ПТС).
const STOP_LABEL = "(?=\\s*(?:категори|кузов|шасси|рама|двигател|мощност|об[ъь][её]м|цвет|масса|эколог|год|vin|идентификац|регистрац|разрешен|изготов|марк|модел|сери|номер|особ|паспорт|наимен|тип|разреш)|$)";

// Марка/модель из сплошного текста СТС/ПТС — литеральная, как напечатано в документе.
function brandFromText(t) {
  const T = (t || "").replace(/\s+/g, " ");
  const m = T.match(new RegExp("(?:марка|модель)\\s*(?:,?\\s*модель)?\\s*(?:тс)?\\s*[:№()]*\\s*([^,\\n]{2,40}?)" + STOP_LABEL, "i"));
  const v = m ? (m[1] || "").replace(/\s+/g, " ").trim() : "";
  return /[A-Za-zА-Яа-яЁё]/.test(v) ? v : "";
}

// Дозаполняет недостающие поля ТС из сплошного текста СТС/ПТС (page-OCR).
function fillFromText(f, t) {
  const T = (t || "").replace(/\s+/g, " ");
  if (!T) return f;
  const grab = (re) => { const m = T.match(re); return m ? (m[1] || "").trim() : ""; };
  if (!f.car_vin) { const v = T.match(/\b[A-HJ-NPR-Z0-9]{17}\b/); if (v) f.car_vin = v[0]; }
  if (!f.car_brand) { const br = brandFromText(t); if (br) f.car_brand = br; }
  if (!f.car_year) { const y = T.match(/год\s*(?:выпуска|изготовлени[яе])\s*(?:тс)?\D{0,6}((?:19|20)\d{2})/i); if (y) f.car_year = y[1]; }
  if (!f.car_type) f.car_type = grab(new RegExp("тип\\s*тс[\\s:№]*([А-Яа-яЁё][А-Яа-яЁё \\-]{2,40}?)" + STOP_LABEL, "i"));
  if (!f.car_category) f.car_category = grab(/категори[ия]\s*(?:тс\s*)?[:№(]*\s*([ABCDEMАВСЕДМ]{1,2}\d?)\b/i);
  if (!f.car_color) f.car_color = grab(new RegExp("цвет[\\s:а-яё]*([А-Яа-яЁё][А-Яа-яЁё \\-]{2,30}?)" + STOP_LABEL, "i"));
  // Мощность: л.с. = большее из двух чисел («184 (135)» или «128/174»).
  if (!f.car_power) { const mp = T.match(/мощност[^0-9]{0,30}(\d{2,4})(?:[^0-9]{1,5}(\d{2,4}))?/i); if (mp) f.car_power = String(Math.max(+mp[1], mp[2] ? +mp[2] : 0)); }
  if (!f.car_volume) f.car_volume = grab(/(?:рабочий\s*)?об[ъь][её]м[^0-9]{0,16}(\d{3,5})/i);
  if (!f.car_engine) { const e = grab(/(?:модел[ьи][^.]{0,4})?двигател[ья][\s№:no.,]{0,10}([A-ZА-Я0-9][A-ZА-Я0-9 \-/]{3,24})/i); if (/\d{2,}/.test(e)) f.car_engine = e.trim(); }
  if (!f.car_body) { const b = grab(/кузов.{0,40}?(ОТСУТСТВУЕТ|[A-ZА-Я0-9]{6,22})/i); if (/\d{4,}/.test(b) || /ОТСУТ/i.test(b)) f.car_body = b.toUpperCase(); }
  if (!f.car_chassis) { const ch = grab(/(?:шасси|рама)[^A-ZА-Я0-9]{0,30}(ОТСУТСТВ\w*|НЕ\s*УСТАНОВЛ\w*|[A-ZА-Я0-9]{5,22})/i); if (ch) f.car_chassis = ch.toUpperCase(); }
  if (!f.car_plate) {
    // Госномер: по метке «рег. знак / гос. номер» или по формату РФ (буквы АВЕКМНОРСТУХ + цифры).
    let pl = grab(/(?:регистрационн\w*\s*знак|гос\.?\s*(?:рег\w*\s*)?номер)[\s:№]*([A-ZА-Я]\s?\d{3}\s?[A-ZА-Я]{2}\s?\d{2,3})/i)
      || (T.match(/\b([АВЕКМНОРСТУХABEKMHOPCTYX]\s?\d{3}\s?[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\s?\d{2,3})\b/) || [])[1] || "";
    if (pl) f.car_plate = pl.replace(/\s+/g, "").toUpperCase();
  }
  if (!f.pts_issued) {
    // п.23 «Наименование организации, выдавшей паспорт» + п.25 «Дата выдачи паспорта».
    const iss = grab(/выдавш[а-яё]+\s+паспорт[\s:№.]*([А-ЯЁA-Z][^0-9]{4,80}?)(?=\s*(?:\d|адрес)|$)/i)
      || grab(/наименовани\w*\s+организац\w*[^А-ЯA-Z0-9]{0,20}([А-ЯЁA-Z][^0-9]{4,80}?)(?=\s*(?:\d|адрес)|$)/i);
    const pd = (T.match(/дата\s+выдачи\s+паспорта[\s:№.]*(\d{2}\.\d{2}\.\d{4})/i)
      || T.match(/выдачи\s+паспорта[\s\S]{0,40}?(\d{2}\.\d{2}\.\d{4})/i) || [])[1] || "";
    const v = [iss.replace(/[,\s]+$/, ""), pd].filter(Boolean).join(", ");
    if (v) f.pts_issued = v;
  }
  if (!f.sts_series || !f.sts_number) {
    // СТС: «99 серия 87 № 802478» или «99 87 802478» → серия «99 87», номер «802478».
    const s = T.match(/(\d{2})\s*сери[яи]\s*(\d{2})\s*№?\s*(\d{6})/i) || T.match(/свидетельств\w*[^0-9]{0,40}(\d{2})\s*(\d{2})\s*№?\s*(\d{6})/i);
    if (s) { f.sts_series = `${s[1]} ${s[2]}`; f.sts_number = s[3]; }
  }
  if (!f.pts_series || !f.pts_number) {
    const p = T.match(/паспорт\s*тс\s*(?:№\s*)?(?:сери[яи]\s*)?(\d{2}\s?[А-ЯЁA-Z]{2})\s*№?\s*(\d{6})/i) || T.match(/\b(\d{2}\s?[А-ЯЁA-Z]{2})\s?№?\s?(\d{6})\b/);
    if (p) { f.pts_series = p[1].replace(/\s+/g, " ").trim(); f.pts_number = p[2]; }
  }
  return f;
}

// ПТС (паспорт ТС) — спец-модели у Яндекса нет, разбираем из общего текста.
function mapPts(t) {
  return fillFromText({}, t);
}
// Прописка (отдельное фото страницы регистрации) → адрес. OCR общий, чистим текст.
function mapReg(t) {
  let s = (t || "").replace(/\s+/g, " ").trim();
  s = s.replace(/место\s+жительства|зарегистрирован[аоы]?\s*(по\s+месту\s+жительства)?|отметк\w*\s+о\s+регистрации|снят[аоы]?\s+с\s+регистрационного\s+учёта|код подразделения|УФМС|ГУ\s?МВД|ОУФМС|России?|\b\d{2}[.\-]\d{2}[.\-]\d{4}\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  const i = s.search(/[А-ЯЁ]?\s*обл|г\.|город|край|респ|ул\.|улиц|пер\.|просп|д\.|кв\./i);
  if (i > 0) s = s.slice(i);
  return { address: s.slice(0, 200) };
}
// Универсальный разбор СТС (лицевая stsfront_* и оборот stsback_*) по подстрокам.
function mapSts(entities, fullText) {
  const m = entMap(entities);
  const keys = Object.keys(m);
  const find = (...subs) => { for (const k of keys) if (subs.some((s) => k.includes(s)) && m[k]) return m[k]; return ""; };
  const brand = find("car_brand", "_brand", "make");
  const model = find("car_model", "_model");
  const f = {
    car_brand: [brand, model].filter(Boolean).join(" "),
    car_vin: find("vin").toUpperCase(),
    car_type: find("car_type", "vehicle_type"),
    car_category: find("category"),
    car_year: find("year"),
    car_engine: find("engine"),
    car_chassis: find("chassis").toUpperCase(),
    car_body: find("body").toUpperCase(),
    car_color: find("color", "colour"),
    car_plate: find("car_number", "license_plate", "registration_number", "gos_number").toUpperCase(),
    sts_series: "", sts_number: "", pts_series: "", pts_number: "",
  };
  const sn = find("sts_number").replace(/\D/g, "");
  if (sn.length >= 10) { f.sts_series = sn.slice(0, 4); f.sts_number = sn.slice(4); }
  else if (sn) f.sts_number = sn;
  const pn = find("pts_number").replace(/\D/g, "");
  if (pn.length >= 4) { f.pts_series = pn.slice(0, 4); f.pts_number = pn.slice(4); }
  // Недостающие поля — из сплошного текста СТС (page-OCR).
  return fillFromText(f, fullText);
}
function mapOrg(t) {
  const f = {};
  const ogrn = t.match(/\b\d{15}\b|\b\d{13}\b/);
  const inn = t.match(/\b\d{12}\b|\b\d{10}\b/);
  const kpp = (t.match(/КПП[^\d]{0,6}(\d{9})/i) || [])[1];
  if (ogrn) f.ogrn = ogrn[0];
  if (inn) f.inn = inn[0];
  if (kpp) f.kpp = kpp;
  const nm = t.split(/\n/).map((l) => l.trim()).find((l) => /(ООО|АО|ПАО|ОАО|ЗАО|ИП)\b/i.test(l));
  if (nm) f.org_name = nm;
  return f;
}

/* ---------- Anthropic Claude Vision (запасной вариант) ---------- */
async function recognizeAnthropic(env, mediaType, data, kind) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: PROMPTS[kind] || PROMPTS.passport },
        ],
      }],
    }),
  });
  if (!r.ok) return { error: "vision_failed", status: r.status };
  const out = await r.json();
  const text = (out.content || []).map((c) => c.text || "").join("");
  try {
    const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return { fields: JSON.parse(jsonText) };
  } catch {
    return { error: "parse_failed", raw: text };
  }
}

/* ---------- Тарифы / доступ (Cloudflare KV + CloudPayments) ---------- */
// Платный режим включён, только когда заданы KV-биндинг SUBS и Public ID CloudPayments.
// Платёжный провайдер: Тинькофф (если заданы ключ+пароль), иначе CloudPayments, иначе выкл.
function payProvider(env) {
  if (env.TINKOFF_TERMINAL_KEY && env.TINKOFF_PASSWORD) return "tinkoff";
  if (env.CP_PUBLIC_ID) return "cloudpayments";
  return "";
}
function subEnabled(env) { return !!(env.SUBS && payProvider(env)); }
// Статичные админы из ADMIN_IDS (через запятую).
function staticAdmins(env) {
  return String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}
// Админ = в ADMIN_IDS (env) ИЛИ добавлен динамически в KV (admin:<id>).
async function isAdmin(env, userId) {
  const id = String(userId);
  if (staticAdmins(env).includes(id)) return true;
  if (env.SUBS && (await env.SUBS.get("admin:" + id))) return true;
  return false;
}
// Список всех админов: статичные (из env) + динамические (KV).
async function listAdmins(env) {
  let dynamic = [];
  if (env.SUBS) dynamic = (await kvListAll(env, "admin:")).map((k) => k.name.slice(6));
  return { static: staticAdmins(env), dynamic };
}
// Последние платежи (из tpay:* метаданных).
async function recentPayments(env, n) {
  if (!env.SUBS) return [];
  const keys = await kvListAll(env, "tpay:");
  return keys.map((k) => ({ ...(k.metadata || {}), id: k.name.slice(5) }))
    .sort((a, b) => Number(b.t || 0) - Number(a.t || 0)).slice(0, n || 20);
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

// Виды оплаты: разовый доступ (кредит на 1 договор) + подписки на срок.
// Цена: переопределение из KV (prices, меняется в админке) → переменная воркера → дефолт.
async function tariffs(env) {
  let ov = {};
  if (env.SUBS) { try { ov = JSON.parse((await env.SUBS.get("prices")) || "{}"); } catch (e) { /* ignore */ } }
  const p = (key, envName, d) => num(ov[key], num(env[envName], d));
  return [
    { key: "one", title: "Один договор", note: "разовый доступ", price: p("one", "PRICE_ONE", 99), credits: 1 },
    { key: "m1", title: "1 месяц", note: "безлимит на 30 дней", price: p("m1", "PRICE_1M", 500), days: 30 },
    { key: "m3", title: "3 месяца", note: "безлимит на 90 дней", price: p("m3", "PRICE_3M", 1200), days: 90 },
    { key: "m6", title: "Полгода", note: "безлимит на 180 дней", price: p("m6", "PRICE_6M", 2000), days: 180 },
  ];
}
// Тариф по ключу из платежа (Data.plan); запасной матч — по сумме.
async function findTariff(env, key, amount) {
  const list = await tariffs(env);
  if (key) { const t = list.find((x) => x.key === key); if (t) return t; }
  return list.find((x) => Math.abs(x.price - Number(amount || 0)) < 0.5) || null;
}

async function subUntil(env, userId) {
  if (!env.SUBS) return 0;
  return Number(await env.SUBS.get("sub:" + userId)) || 0;
}
async function subActive(env, userId) { return (await subUntil(env, userId)) > Date.now(); }

// Кредиты разового доступа (1 кредит = 1 договор).
async function credits(env, userId) {
  if (!env.SUBS) return 0;
  return Number(await env.SUBS.get("credits:" + userId)) || 0;
}
async function addCredits(env, userId, n) {
  const next = (await credits(env, userId)) + (Number(n) || 1);
  await env.SUBS.put("credits:" + userId, String(next), { metadata: { n: next } });
  return next;
}
// Списать один кредит. Возвращает остаток (>=0) или null, если кредитов не было.
async function useCredit(env, userId) {
  const cur = await credits(env, userId);
  if (cur <= 0) return null;
  const left = cur - 1;
  await env.SUBS.put("credits:" + userId, String(left), { metadata: { n: left } });
  return left;
}

// Выдать/продлить подписку на N дней (продление — от текущего конца, если ещё активна).
async function grantSub(env, userId, days) {
  const ms = (Number(days) || 30) * 86400000;
  const cur = await subUntil(env, userId);
  const until = (cur > Date.now() ? cur : Date.now()) + ms;
  await env.SUBS.put("sub:" + userId, String(until),
    { expirationTtl: Math.ceil((until - Date.now()) / 1000) + 86400, metadata: { until } });
  return until;
}

// Все ключи KV по префиксу (с пагинацией).
async function kvListAll(env, prefix) {
  let keys = [], cursor;
  do {
    const r = await env.SUBS.list({ prefix, cursor, limit: 1000 });
    keys = keys.concat(r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return keys;
}
// Статистика для админа (структурные данные): подписки, кредиты, платежи, выручка.
async function computeStatsData(env) {
  if (!env.SUBS) return { error: "no_kv" };
  const now = Date.now();
  const [subKeys, credKeys, payKeys] = await Promise.all([
    kvListAll(env, "sub:"), kvListAll(env, "credits:"), kvListAll(env, "tpay:"),
  ]);
  let activeSubs = 0;
  for (const k of subKeys) {
    const u = (k.metadata && k.metadata.until) || Number(await env.SUBS.get(k.name)) || 0;
    if (u > now) activeSubs++;
  }
  let creditUsers = 0, creditsLeft = 0;
  for (const k of credKeys) {
    const n = k.metadata && k.metadata.n != null ? Number(k.metadata.n) : (Number(await env.SUBS.get(k.name)) || 0);
    if (n > 0) { creditUsers++; creditsLeft += n; }
  }
  let revenue = 0, rev30 = 0, cnt30 = 0; const byPlan = {};
  const monthAgo = now - 30 * 86400000;
  for (const k of payKeys) {
    const m = k.metadata || {};
    const a = Number(m.a || 0); revenue += a;
    byPlan[m.p || "?"] = (byPlan[m.p || "?"] || 0) + 1;
    if (Number(m.t || 0) >= monthAgo) { rev30 += a; cnt30++; }
  }
  return { activeSubs, creditsLeft, creditUsers, payCount: payKeys.length, revenue, rev30, cnt30, byPlan };
}
// Текстовая статистика (для команды /stats в чате).
async function computeStats(env) {
  const s = await computeStatsData(env);
  if (s.error) return "Статистика недоступна (KV не подключён).";
  const title = { one: "Разовый", m1: "1 месяц", m3: "3 месяца", m6: "Полгода" };
  const planLines = Object.keys(s.byPlan).map((p) => `   • ${title[p] || p}: ${s.byPlan[p]}`).join("\n") || "   —";
  const rub = (n) => Number(n).toLocaleString("ru-RU");
  return [
    "📊 *Статистика «Безопасный АвтоДоговор»*",
    "",
    `👥 Активных подписок: *${s.activeSubs}*`,
    `🎫 Разовых договоров в остатке: *${s.creditsLeft}* (у ${s.creditUsers} польз.)`,
    "",
    `💳 Платежей всего: *${s.payCount}*`,
    `💰 Выручка всего: *${rub(s.revenue)} ₽*`,
    `📅 За 30 дней: ${s.cnt30} платежей, *${rub(s.rev30)} ₽*`,
    "",
    "*По тарифам (число платежей):*",
    planLines,
  ].join("\n");
}
// Проверка подписи уведомления CloudPayments: base64(HMAC-SHA256(rawBody, ApiSecret)).
async function cpVerify(env, rawBody, hmacHeader) {
  if (!env.CP_API_SECRET || !hmacHeader) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.CP_API_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  let bin = ""; for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin) === hmacHeader;
}

/* ---------- Tinkoff (Т-Касса) эквайринг ---------- */
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Подпись Тинькофф: корневые скалярные параметры (+ Password, без Token), сорт по ключу, конкатенация значений → SHA-256.
async function tinkoffToken(params, password) {
  const src = { ...params, Password: password };
  delete src.Token;
  const keys = Object.keys(src).filter((k) => {
    const v = src[k];
    return v !== null && v !== undefined && typeof v !== "object";
  }).sort();
  const str = keys.map((k) => (typeof src[k] === "boolean" ? (src[k] ? "true" : "false") : String(src[k]))).join("");
  return sha256hex(str);
}
// Создаём платёж в Тинькофф → ссылка на оплату. OrderId кодирует userId и ключ тарифа.
async function tinkoffInit(env, userId, tariff, origin) {
  const app = env.MINI_APP_URL || origin;
  const body = {
    TerminalKey: env.TINKOFF_TERMINAL_KEY,
    Amount: Math.round(tariff.price * 100),       // в копейках
    OrderId: `dkp_${userId}_${tariff.key}_${Date.now()}`,
    Description: `ДКП-бот — ${tariff.title}`,
    NotificationURL: `${origin}/api/tinkoff/webhook`,
    SuccessURL: `${app}?dkp=paid`,                // возврат в мини-апп (тот же webview)
    FailURL: `${app}?dkp=fail`,
  };
  body.Token = await tinkoffToken(body, env.TINKOFF_PASSWORD);
  const r = await fetch("https://securepay.tinkoff.ru/v2/Init", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!out.Success || !out.PaymentURL)
    return { error: "init_failed", detail: out.Message || out.Details || ("code " + out.ErrorCode) };
  return { paymentUrl: out.PaymentURL };
}

/* ---------- Webhook (сообщения боту) ---------- */
async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/dkp") {
    const url = env.MINI_APP_URL;
    const t = await tariffs(env);
    const tariffsLine = `💳 *Тарифы:* ${t[0].title} — ${t[0].price} ₽, ${t[1].title} — ${t[1].price} ₽, ${t[2].title} — ${t[2].price} ₽, ${t[3].title} — ${t[3].price} ₽.`;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🚗 *Безопасный автодоговор*\n\n" +
        "Загрузите фото паспорта и СТС — бот распознает данные и пришлёт готовый " +
        "пакет документов: договор купли-продажи (DOCX + PDF), акт приёма-передачи и расписку.\n\n" +
        tariffsLine,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Запустить бот", web_app: { url } }],
          [{ text: "🚘 Узнать про подбор автомобиля", url: "https://t.me/AvtoPodbor251" }],
        ],
      },
    });
    return;
  }

  if (text === "/info" || text === "/about") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "Markdown",
      text:
        "ℹ️ *О сервисе*\n\n" +
        "Бот формирует договор купли-продажи транспортного средства (ДКП).\n\n" +
        "*Реквизиты продавца:*\n" +
        "Индивидуальный предприниматель Букин Матвей Игоревич\n" +
        "ИНН: 502481713312\n" +
        "ОГРНИП: 325774600438571",
    });
    return;
  }

  if (text === "/id" || text === "/myid") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Ваш Telegram ID: " + chatId + ((await isAdmin(env, chatId)) ? "\n✅ Вы админ — оформление без оплаты." : ""),
    });
    return;
  }

  if (text === "/stats" || text === "/admin") {
    if (!(await isAdmin(env, chatId))) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Команда доступна только администратору." });
      return;
    }
    await tg(env, "sendMessage", { chat_id: chatId, text: await computeStats(env), parse_mode: "Markdown" });
    return;
  }

  if (text === "/reset") {
    if (env.SUBS) {
      await env.SUBS.delete("credits:" + chatId);
      await env.SUBS.delete("sub:" + chatId);
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔄 Сброшено: договоры и подписка обнулены. Откройте /start, чтобы оформить заново.",
    });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Напишите /start, чтобы оформить договор.",
  });
}

/* ---------- MAX messenger Bot API ---------- */
function maxBase(env) { return (env.MAX_API_BASE || "https://botapi.max.ru").replace(/\/$/, ""); }
async function maxApi(env, method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const u = `${maxBase(env)}${path}${sep}access_token=${encodeURIComponent(env.MAX_TOKEN || "")}`;
  return fetch(u, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function maxSend(env, chatId, text, attachments) {
  if (!chatId) return;
  const body = { text };
  if (attachments) body.attachments = attachments;
  return maxApi(env, "POST", `/messages?chat_id=${chatId}`, body).catch(() => {});
}
// chat_id из разных форматов апдейта MAX (уточним по /max/last).
function maxChatId(u) {
  return u.chat_id || u.message?.recipient?.chat_id || u.message?.chat_id
    || u.callback?.message?.recipient?.chat_id || u.message?.sender?.user_id || u.user?.user_id || null;
}
async function handleMaxUpdate(env, u) {
  if (env.SUBS) await env.SUBS.put("max:last", JSON.stringify(u), { expirationTtl: 86400 }).catch(() => {});
  const type = u.update_type;
  const text = (u.message?.body?.text || u.message?.text || "").trim();
  const chatId = maxChatId(u);
  if (type === "bot_started" || /^\/(start|dkp)\b/i.test(text)) {
    await maxSend(env, chatId,
      "🚗 Оформление договора купли-продажи ТС\n\nОткройте приложение, загрузите фото паспорта и СТС — и бот пришлёт готовый договор (DOCX + PDF).",
      [{ type: "inline_keyboard", payload: { buttons: [[{ type: "link", text: "📝 Оформить ДКП", url: env.MINI_APP_URL }]] } }]);
  }
}

/* ---------- Router ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Разовая привязка вебхука: открыть в браузере после установки токена.
    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN)
        return new Response("Сначала задайте секрет TELEGRAM_BOT_TOKEN в воркере.", { status: 400 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", { url: hook });
      const out = await r.json().catch(() => ({}));
      return json({ setWebhook: hook, telegram: out });
    }

    // MAX: проверка токена/базы (вернёт инфо о боте или ошибку)
    if (url.pathname === "/max/me") {
      const r = await maxApi(env, "GET", "/me");
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    // MAX: регистрация вебхука (открыть один раз после установки MAX_TOKEN)
    if (url.pathname === "/max/setup") {
      if (!env.MAX_TOKEN) return new Response("Сначала задайте секрет MAX_TOKEN.", { status: 400 });
      const hook = `${url.origin}/max/webhook`;
      const r = await maxApi(env, "POST", "/subscriptions", { url: hook, update_types: ["message_created", "bot_started", "message_callback"] });
      return json({ subscribe: hook, status: r.status, response: (await r.text()).slice(0, 800) });
    }
    // MAX: webhook
    if (url.pathname === "/max/webhook" && request.method === "POST") {
      const u = await request.json().catch(() => null);
      if (u) await handleMaxUpdate(env, u);
      return new Response("ok");
    }
    // MAX: последний полученный апдейт (для отладки формата)
    if (url.pathname === "/max/last") {
      const v = env.SUBS ? await env.SUBS.get("max:last") : null;
      return new Response(v || "{}", { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    // Telegram webhook
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (update) await handleUpdate(env, update);
      return new Response("ok");
    }

    // Распознавание паспорта/СТС
    if (url.pathname === "/api/recognize" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      const res = await recognize(env, b.image, b.kind);
      return json(res, res.error ? 422 : 200);
    }

    // Публичный конфиг для мини-аппа (Public ID, тарифы, включён ли платный режим)
    if (url.pathname === "/api/config") {
      return json({
        subEnabled: subEnabled(env), provider: payProvider(env),
        cpPublicId: env.CP_PUBLIC_ID || "", tariffs: await tariffs(env),
      });
    }

    // Статус доступа текущего пользователя (подписка + остаток кредитов)
    if (url.pathname === "/api/sub-status" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      if (!subEnabled(env)) return json({ enabled: false, active: true });
      if (await isAdmin(env, auth.user.id)) return json({ enabled: true, active: true, admin: true });
      const until = await subUntil(env, auth.user.id);
      const cr = await credits(env, auth.user.id);
      // active — есть ли доступ (подписка ИЛИ хотя бы один кредит).
      return json({ enabled: true, active: until > Date.now() || cr > 0, sub: until > Date.now(), until, credits: cr });
    }

    // Статистика для мини-аппа (только админ)
    if (url.pathname === "/api/stats" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      if (!(await isAdmin(env, auth.user.id))) return json({ error: "forbidden" }, 403);
      return json(await computeStatsData(env));
    }

    // Админ-панель: единый эндпоинт (действия по полю action)
    if (url.pathname === "/api/admin" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      if (!(await isAdmin(env, auth.user.id))) return json({ error: "forbidden" }, 403);
      const uid = String(b.userId || "").trim();
      switch (b.action) {
        case "stats": return json(await computeStatsData(env));
        case "payments": return json({ payments: await recentPayments(env, 20) });
        case "admins": return json(await listAdmins(env));
        case "admin_add":
          if (!/^\d+$/.test(uid)) return json({ error: "bad_id" }, 400);
          if (env.SUBS) await env.SUBS.put("admin:" + uid, "1");
          return json(await listAdmins(env));
        case "admin_remove":
          if (env.SUBS) await env.SUBS.delete("admin:" + uid);
          return json(await listAdmins(env));
        case "user": {
          if (!/^\d+$/.test(uid)) return json({ error: "bad_id" }, 400);
          const until = await subUntil(env, uid);
          return json({ userId: uid, until: until > Date.now() ? until : 0, credits: await credits(env, uid), admin: await isAdmin(env, uid) });
        }
        case "grant": {
          if (!/^\d+$/.test(uid)) return json({ error: "bad_id" }, 400);
          const t = await findTariff(env, b.plan);
          if (!t) return json({ error: "bad_plan" }, 400);
          if (t.days) { const u2 = await grantSub(env, uid, t.days); return json({ ok: true, until: u2 }); }
          const n = await addCredits(env, uid, t.credits || 1);
          return json({ ok: true, credits: n });
        }
        case "reset":
          if (env.SUBS) { await env.SUBS.delete("credits:" + uid); await env.SUBS.delete("sub:" + uid); }
          return json({ ok: true });
        case "set_prices": {
          const pr = b.prices || {}; const clean = {};
          for (const key of ["one", "m1", "m3", "m6"]) {
            const v = Number(pr[key]);
            if (Number.isFinite(v) && v > 0) clean[key] = Math.round(v);
          }
          if (env.SUBS) await env.SUBS.put("prices", JSON.stringify(clean));
          return json({ ok: true, tariffs: await tariffs(env) });
        }
        default: return json({ error: "bad_action" }, 400);
      }
    }

    // Создать платёж Тинькофф → вернуть ссылку на оплату
    if (url.pathname === "/api/pay/init" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      if (payProvider(env) !== "tinkoff") return json({ error: "not_tinkoff" }, 400);
      const t = await findTariff(env, b.plan);
      if (!t) return json({ error: "bad_plan" }, 400);
      const res = await tinkoffInit(env, auth.user.id, t, url.origin);
      return json(res, res.error ? 502 : 200);
    }

    // Уведомление Тинькофф об оплате. Доступ выдаётся здесь.
    if (url.pathname === "/api/tinkoff/webhook" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!env.TINKOFF_PASSWORD) return new Response("OK");
      if ((await tinkoffToken(body, env.TINKOFF_PASSWORD)) !== body.Token) return new Response("OK"); // подделка — игнор
      const parts = String(body.OrderId || "").split("_");   // dkp_<userId>_<plan>_<ts>
      const userId = parts[1], planKey = parts[2];
      const amount = Number(body.Amount || 0) / 100;          // из копеек
      if (env.SUBS && userId && body.Success && body.Status === "CONFIRMED") {
        const payKey = "tpay:" + body.PaymentId;
        if (await env.SUBS.get(payKey)) return new Response("OK");   // идемпотентность
        const t = await findTariff(env, planKey, amount);
        if (t) {
          await env.SUBS.put(payKey, "1",
            { expirationTtl: 60 * 60 * 24 * 400, metadata: { a: amount, p: t.key, t: Date.now(), k: t.days ? "sub" : "credit", u: String(userId) } });
          if (t.days) {
            await grantSub(env, userId, t.days);
            await tg(env, "sendMessage", { chat_id: userId, text: `✅ Оплата получена. Подписка «${t.title}» активна — можно оформлять договоры. /start` }).catch(() => {});
          } else {
            const n = await addCredits(env, userId, t.credits || 1);
            await tg(env, "sendMessage", { chat_id: userId, text: `✅ Оплата получена. Доступно договоров: ${n}. /start` }).catch(() => {});
          }
        }
      }
      return new Response("OK");
    }

    // Уведомление CloudPayments об оплате (Pay). Доступ выдаётся ТОЛЬКО здесь.
    if (url.pathname === "/api/cp/webhook" && request.method === "POST") {
      const raw = await request.text();
      const hmac = request.headers.get("Content-HMAC") || request.headers.get("X-Content-HMAC") || "";
      if (!(await cpVerify(env, raw, hmac))) return json({ code: 13 });
      const p = new URLSearchParams(raw);
      const status = p.get("Status");
      const amount = Number(p.get("Amount") || 0);
      const userId = p.get("AccountId");
      const invoiceId = p.get("InvoiceId") || "";
      let data = {};
      try { data = JSON.parse(p.get("Data") || "{}"); } catch { /* ignore */ }
      // Касса у бота отдельная, но платежи всё равно помечаем и проверяем метку
      // (Data.cc="dkp" или InvoiceId "dkp-*") — страховка от чужих уведомлений.
      if (data.cc !== "dkp" && !invoiceId.startsWith("dkp-")) return json({ code: 0 });
      if (env.SUBS && userId && (status === "Completed" || status === "Authorized")) {
        const t = await findTariff(env, data.plan, amount);
        if (t && t.days) {
          await grantSub(env, userId, t.days);
          await tg(env, "sendMessage", {
            chat_id: userId,
            text: `✅ Оплата получена. Подписка «${t.title}» активна — можно оформлять договоры. /start`,
          }).catch(() => {});
        } else if (t) {
          const n = await addCredits(env, userId, t.credits || 1);
          await tg(env, "sendMessage", {
            chat_id: userId,
            text: `✅ Оплата получена. Доступно договоров: ${n}. /start`,
          }).catch(() => {});
        }
      }
      return json({ code: 0 });
    }

    // Отправка готового договора в чат пользователю
    if (url.pathname === "/api/send" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      // Платный режим: нужен активный доступ — подписка ИЛИ разовый кредит (списывается).
      // Админ — без оплаты.
      let usedCredit = false, remainingCredits = null, subUntilMs = 0;
      if (subEnabled(env) && !(await isAdmin(env, auth.user.id))) {
        const until = await subUntil(env, auth.user.id);
        if (until > Date.now()) { subUntilMs = until; }                   // активная подписка — кредит не тратим
        else {
          const left = await useCredit(env, auth.user.id);
          if (left === null) return json({ error: "sub_required" }, 402); // нет ни подписки, ни кредитов
          usedCredit = true; remainingCredits = left;
        }
      }
      const base = b.filename || "ДКП";
      try {
        const r1 = b.docx_base64
          ? await sendDocument(env, auth.user.id, `${base}.docx`, b.docx_base64, "📄 Договор (Word)") : null;
        const r2 = b.pdf_base64
          ? await sendDocument(env, auth.user.id, `${base}.pdf`, b.pdf_base64, "📄 Договор (PDF)") : null;
        if ((r1 && !r1.ok) || (r2 && !r2.ok)) throw new Error("telegram_send");
        // Доп. документы пакета (акт, расписка и т.п.) — PDF из мини-аппа.
        const extras = Array.isArray(b.extras) ? b.extras.slice(0, 5) : [];
        for (const ex of extras) {
          if (!ex || !ex.pdf_base64) continue;
          const fn = String(ex.filename || "Документ.pdf").slice(0, 120);
          const re = await sendDocument(env, auth.user.id, fn, ex.pdf_base64, ex.caption || "");
          if (!re.ok) throw new Error("telegram_send");
        }
      } catch (e) {
        if (usedCredit) await addCredits(env, auth.user.id, 1); // вернуть списанный кредит
        return json({ error: "send_failed" }, 502);
      }
      return json({ ok: true, credits: remainingCredits, sub: subUntilMs || undefined });
    }

    // health
    if (url.pathname === "/") return new Response("dkp-bot ok");
    return new Response("not found", { status: 404 });
  },
};
