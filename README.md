# ДКП-бот — оформление договора купли-продажи ТС

Telegram-бот с мини-приложением: пользователь загружает фото паспорта, СТС и ПТС,
данные распознаются автоматически, он проверяет/правит поля — и получает готовый
договор (**DOCX + PDF**) прямо в чат. Доступ — по платной подписке (CloudPayments).

> Это самостоятельный репозиторий (выделен из проекта сайта). Содержимое лежит
> в корне репозитория.

```
.
├── worker.js          # Cloudflare Worker: вебхук бота + API (распознавание, отправка, подписка)
├── wrangler.toml      # конфиг воркера (Root directory = корень репозитория)
├── web/               # мини-апп (статическая страница → Cloudflare Pages, проект dkp-mini)
│   ├── index.html
│   └── dkp-template.docx
├── template/          # исходник шаблона договора, пример, генератор
├── brand/             # аватар и картинка-превью бота
└── .github/workflows/deploy.yml   # автодеплой Worker + Pages
```

DOCX/PDF формируются **в браузере** (docxtemplater + pdfmake), воркеру не нужна сборка.

## Возможности
- **Распознавание** документов (Yandex Vision OCR + YandexGPT для разбора текста):
  паспорт, СТС (лицевая/оборот), ПТС. Поля складываются, заполненное не перетирается.
- **Стороны:** физлицо (пол определяется из паспорта), юрлицо, ИП.
- **Предпросмотр** договора (адаптивный HTML) → отправка DOCX+PDF в чат.
- **Платная подписка** (CloudPayments): доступ к формированию договора на 30 дней,
  выдаётся строго по webhook об оплате. Хранение — Cloudflare KV.

## Развёртывание

### Секреты воркера (Cloudflare → Worker → Variables and Secrets → Secret)
| Имя | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота (@BotFather) |
| `YANDEX_API_KEY` | статический/Api-ключ сервисного аккаунта YC (OCR + GPT); нужны роли `ai.vision.user`, `ai.languageModels.user`, scope `yc.ai.vision.execute` + `yc.ai.languageModels.execute` |
| `CP_API_SECRET` | «Пароль для API» CloudPayments (проверка подписи webhook) |

### Переменные ([vars] в wrangler.toml)
| Имя | Назначение |
|---|---|
| `MINI_APP_URL` | адрес мини-аппа (Pages), напр. `https://dkp-mini.pages.dev` |
| `YANDEX_FOLDER_ID` | ID каталога Яндекс Облака |
| `CP_PUBLIC_ID` | Public ID CloudPayments (`pk_…`); пусто = платный режим выкл. |
| `SUB_PRICE` | цена подписки, ₽ |
| `SUB_DAYS` | срок подписки, дней (30) |

### KV (хранение подписок)
Создайте KV-namespace (Cloudflare → Workers & Pages → KV) и раскомментируйте в
`wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "SUBS"
id = "ВАШ_KV_NAMESPACE_ID"
```
Платный режим включается, когда заданы `CP_PUBLIC_ID` **и** KV `SUBS`.

### Деплой (GitHub Actions)
1. GitHub → Settings → Secrets and variables → Actions:
   - Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit + Pages: Edit), `CLOUDFLARE_ACCOUNT_ID`
   - Variables: `ENABLE_DKP_DEPLOY = true`
2. Пуш в `main` → workflow задеплоит Worker и Mini App (Pages-проект `dkp-mini`).

Альтернатива — **Cloudflare Workers Builds**: подключить репозиторий, **Root directory = `.`** (корень).

### Привязка вебхука Telegram
После установки `TELEGRAM_BOT_TOKEN` откройте один раз в браузере:
```
https://<адрес-воркера>.workers.dev/setup
```

### CloudPayments
В ЛК CloudPayments → Уведомления → **Pay** укажите URL:
```
https://<адрес-воркера>.workers.dev/api/cp/webhook
```
Чеки (54-ФЗ) настраиваются в ЛК CloudPayments (CloudKassir).

## Брендинг
`brand/avatar.png` — аватар бота, `brand/welcome.png` — картинка-превью (Set Welcome Picture).

## Проверка
1. В боте `/start` → «Оформить ДКП».
2. Загрузить фото (или вручную) → проверить поля → «Сформировать договор» → предпросмотр.
3. «Отправить в чат» → при активной подписке придут DOCX и PDF; иначе — оплата.
