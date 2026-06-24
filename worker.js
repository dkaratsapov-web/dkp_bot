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
  if (fullText && env.YANDEX_FOLDER_ID) {
    const gpt = await yandexGptExtract(env, fullText);
    // Марку и серию/номер СТС GPT не доверяем (нормализует/путает) — берём из документа.
    const skip = { car_brand: 1, sts_series: 1, sts_number: 1 };
    if (gpt) for (const k in gpt) { if (skip[k]) continue; if (gpt[k] && !fields[k]) fields[k] = gpt[k]; }
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
  // «Кем выдан»: модель паспорта это поле не возвращает — достаём из текста
  // (page-OCR). Сначала «выдан … <дата>», иначе по ключевым словам органа.
  if (!f.pasp_issued_by && fullText) {
    const t = fullText.replace(/\s+/g, " ");
    let by = "";
    const m1 = t.match(/выдан[аоы]?\.?\s+(.{6,90}?)\s*\d{2}[.\-]\d{2}[.\-]\d{4}/i);
    if (m1) by = m1[1];
    if (!by) {
      const m2 = t.match(/(?:ГУ\s?|У|О|ОУ|ТП\s?)?(?:МВД|УФМС|ФМС|ОВД|МИЛИЦИИ|ПОЛИЦИИ)[^|]{0,80}?(?:ОБЛ\w*|КРА\w*|РАЙОН\w*|ГОРОД\w*|Г\.?\s?[А-ЯЁ][а-яё]+|РЕСПУБЛИК\w*|АО\b)/i);
      if (m2) by = m2[0];
    }
    if (by) f.pasp_issued_by = by.replace(/^[\s.,№-]+|[\s.,]+$/g, "");
  }
  return f;
}
// Граница значения — перед следующей подписью (общая для СТС/ПТС).
const STOP_LABEL = "(?=\\s*(?:категори|кузов|шасси|рама|двигател|мощност|об[ъь][её]м|цвет|масса|эколог|год|vin|идентификац|регистрац|разрешен|изготов|марк|модел|сери|номер|особ|паспорт|наимен|тип|разреш)|$)";

// Дозаполняет недостающие поля ТС из сплошного текста СТС/ПТС (page-OCR).
function fillFromText(f, t) {
  const T = (t || "").replace(/\s+/g, " ");
  if (!T) return f;
  const grab = (re) => { const m = T.match(re); return m ? (m[1] || "").trim() : ""; };
  if (!f.car_vin) { const v = T.match(/\b[A-HJ-NPR-Z0-9]{17}\b/); if (v) f.car_vin = v[0]; }
  if (!f.car_brand) { const br = grab(new RegExp("(?:марка|модель)\\s*(?:,?\\s*модель)?\\s*(?:тс)?\\s*[:№()]*\\s*([^,\\n]{2,40}?)" + STOP_LABEL, "i")); if (br) f.car_brand = br.replace(/\s+/g, " ").trim(); }
  if (!f.car_year) { const y = T.match(/год\s*(?:выпуска|изготовлени[яе])\s*(?:тс)?\D{0,6}((?:19|20)\d{2})/i); if (y) f.car_year = y[1]; }
  if (!f.car_type) f.car_type = grab(new RegExp("тип\\s*тс[\\s:№]*([А-Яа-яЁё][А-Яа-яЁё \\-]{2,40}?)" + STOP_LABEL, "i"));
  if (!f.car_category) f.car_category = grab(/категори[ия]\s*(?:тс\s*)?[:№(]*\s*([ABCDEMАВСЕДМ]{1,2}\d?)\b/i);
  if (!f.car_color) f.car_color = grab(new RegExp("цвет[\\s:а-яё]*([А-Яа-яЁё][А-Яа-яЁё \\-]{2,30}?)" + STOP_LABEL, "i"));
  // Мощность: л.с. = большее из двух чисел («184 (135)» или «128/174»).
  if (!f.car_power) { const mp = T.match(/мощност[^0-9]{0,30}(\d{2,4})(?:[^0-9]{1,5}(\d{2,4}))?/i); if (mp) f.car_power = String(Math.max(+mp[1], mp[2] ? +mp[2] : 0)); }
  if (!f.car_volume) f.car_volume = grab(/(?:рабочий\s*)?об[ъь][её]м[^0-9]{0,16}(\d{3,5})/i);
  if (!f.car_engine) { const e = grab(/(?:модел[ьи][^.]{0,4})?двигател[ья][\s№:no.,]{0,10}([A-ZА-Я0-9][A-ZА-Я0-9 \-/]{3,24})/i); if (/\d{2,}/.test(e)) f.car_engine = e.trim(); }
  if (!f.car_body) { const b = grab(/кузов.{0,40}?(ОТСУТСТВУЕТ|[A-ZА-Я0-9]{6,22})/i); if (/\d{4,}/.test(b) || /ОТСУТ/i.test(b)) f.car_body = b.toUpperCase(); }
  if (!f.car_chassis) { const ch = grab(/(?:шасси|рама).{0,30}?(ОТСУТСТВУЕТ|[A-ZА-Я0-9]{6,22})/i); if (ch) f.car_chassis = ch.toUpperCase(); }
  if (!f.pts_issued) {
    // п.23 «Наименование организации, выдавшей паспорт» + п.25 «Дата выдачи паспорта».
    const iss = grab(/выдавш[а-яё]+\s+паспорт[\s:№.]*([А-ЯЁA-Z][^0-9]{4,80}?)(?=\s*(?:\d|адрес)|$)/i);
    const pd = (T.match(/дата\s+выдачи\s+паспорта[\s:№.]*(\d{2}\.\d{2}\.\d{4})/i) || [])[1] || "";
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
function subEnabled(env) { return !!(env.SUBS && env.CP_PUBLIC_ID); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

// Виды оплаты: разовый доступ (кредит на 1 договор) + подписки на срок.
// Цены можно переопределить переменными воркера (PRICE_ONE/PRICE_1M/PRICE_3M/PRICE_6M).
function tariffs(env) {
  return [
    { key: "one", title: "Один договор", note: "разовый доступ", price: num(env.PRICE_ONE, 99), credits: 1 },
    { key: "m1", title: "1 месяц", note: "безлимит на 30 дней", price: num(env.PRICE_1M, 500), days: 30 },
    { key: "m3", title: "3 месяца", note: "безлимит на 90 дней", price: num(env.PRICE_3M, 1200), days: 90 },
    { key: "m6", title: "Полгода", note: "безлимит на 180 дней", price: num(env.PRICE_6M, 2000), days: 180 },
  ];
}
// Тариф по ключу из платежа (Data.plan); запасной матч — по сумме.
function findTariff(env, key, amount) {
  const list = tariffs(env);
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
  await env.SUBS.put("credits:" + userId, String(next));
  return next;
}
// Списать один кредит. true — если был и списан.
async function useCredit(env, userId) {
  const cur = await credits(env, userId);
  if (cur <= 0) return false;
  await env.SUBS.put("credits:" + userId, String(cur - 1));
  return true;
}

// Выдать/продлить подписку на N дней (продление — от текущего конца, если ещё активна).
async function grantSub(env, userId, days) {
  const ms = (Number(days) || 30) * 86400000;
  const cur = await subUntil(env, userId);
  const until = (cur > Date.now() ? cur : Date.now()) + ms;
  await env.SUBS.put("sub:" + userId, String(until),
    { expirationTtl: Math.ceil((until - Date.now()) / 1000) + 86400 });
  return until;
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

/* ---------- Webhook (сообщения боту) ---------- */
async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/dkp") {
    const url = env.MINI_APP_URL;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🚗 *Оформление договора купли-продажи ТС*\n\n" +
        "Нажмите кнопку ниже, загрузите фото паспорта и СТС, проверьте данные — " +
        "и бот пришлёт готовый договор (DOCX + PDF).",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "📝 Оформить ДКП", web_app: { url } }]],
      },
    });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Напишите /start, чтобы оформить договор.",
  });
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
        subEnabled: subEnabled(env), cpPublicId: env.CP_PUBLIC_ID || "",
        tariffs: tariffs(env),
      });
    }

    // Статус доступа текущего пользователя (подписка + остаток кредитов)
    if (url.pathname === "/api/sub-status" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const auth = await verifyInitData(b.initData, env.TELEGRAM_BOT_TOKEN);
      if (!auth.ok) return json({ error: "unauthorized" }, 401);
      if (!subEnabled(env)) return json({ enabled: false, active: true });
      const until = await subUntil(env, auth.user.id);
      const cr = await credits(env, auth.user.id);
      // active — есть ли доступ (подписка ИЛИ хотя бы один кредит).
      return json({ enabled: true, active: until > Date.now() || cr > 0, sub: until > Date.now(), until, credits: cr });
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
        const t = findTariff(env, data.plan, amount);
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
      let usedCredit = false;
      if (subEnabled(env)) {
        if (await subActive(env, auth.user.id)) { /* активная подписка — ок */ }
        else if (await useCredit(env, auth.user.id)) { usedCredit = true; }
        else return json({ error: "sub_required" }, 402);
      }
      const base = b.filename || "ДКП";
      try {
        const r1 = b.docx_base64
          ? await sendDocument(env, auth.user.id, `${base}.docx`, b.docx_base64, "📄 Договор (Word)") : null;
        const r2 = b.pdf_base64
          ? await sendDocument(env, auth.user.id, `${base}.pdf`, b.pdf_base64, "📄 Договор (PDF)") : null;
        if ((r1 && !r1.ok) || (r2 && !r2.ok)) throw new Error("telegram_send");
      } catch (e) {
        if (usedCredit) await addCredits(env, auth.user.id, 1); // вернуть списанный кредит
        return json({ error: "send_failed" }, 502);
      }
      return json({ ok: true });
    }

    // health
    if (url.pathname === "/") return new Response("dkp-bot ok");
    return new Response("not found", { status: 404 });
  },
};
