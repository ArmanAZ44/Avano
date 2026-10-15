# امنیت | Security

## 🇮🇷 فارسی

### کلید API

آوانو کلید Gemini شما را **فقط در `chrome.storage.local`** روی همان دستگاه ذخیره می‌کند.
کلید هیچ‌گاه به سروری جز `generativelanguage.googleapis.com` فرستاده نمی‌شود و در هیچ
جای دیگری لاگ نمی‌شود.

اگر شبکه‌ی شما اجازه‌ی اتصال مستقیم نمی‌دهد و «آدرس رله» را در تنظیمات پر کرده باشید،
**کلید از همان رله عبور می‌کند** — پس فقط رله‌ی خودتان را وارد کنید.

### چه چیزی از دستگاه شما خارج می‌شود

| داده | مقصد | چرا |
|------|------|-----|
| صدای تب در حال پخش | `generativelanguage.googleapis.com` (گوگل) | برای ترجمه و ساخت صدای دوبله |
| کلید API | همان مقصد | برای احراز هویت درخواست |

هیچ داده‌ی دیگری ارسال نمی‌شود: بدون آنالیتیکس، بدون تلمتری، بدون سرور خودمان.
همین موضوع در `manifest-v2.json` هم به‌صورت `data_collection_permissions` اعلام شده
است — چون AMO این اعلام را اجباری می‌کند.

### گزارش آسیب‌پذیری

لطفاً آسیب‌پذیری‌ها را در Issue عمومی باز نکنید. از
[Security advisories](https://github.com/ArmanAZ44/Avano/security/advisories/new)
استفاده کنید یا در تلگرام [@ArmanAZPC](https://t.me/ArmanAZPC) پیام خصوصی بدهید.

هدف پاسخ اولیه: ۷۲ ساعت.

### در محدوده‌ی بررسی

- اجرای کد دلخواه از طریق محتوای صفحه (content script)
- دور زدن `web_accessible_resources` یا دسترسی‌های manifest
- نشت کلید API به صفحه‌ی میزبان یا به شبکه

### خارج از محدوده

- سوءاستفاده از کلید API خودتان یا محدودیت‌های سهمیه‌ی Google
- کیفیت یا دقت ترجمه‌ی مدل
- رفتار افزونه‌های دیگر

---

## 🇬🇧 English

### API key

Avano stores your Gemini key **only in `chrome.storage.local`** on your own machine.
It is never sent anywhere except `generativelanguage.googleapis.com`, and it is never logged.

If you configured a custom **relay URL** in settings, your key passes through that relay —
so only point it at a relay you trust.

### What leaves your device

| Data | Destination | Why |
|------|-------------|-----|
| Audio of the tab being played | `generativelanguage.googleapis.com` (Google) | To translate it and synthesise the dubbed voice |
| The API key | Same destination | To authenticate the request |

Nothing else is transmitted: no analytics, no telemetry, no server of ours.
This is also declared in `manifest-v2.json` as `data_collection_permissions`,
because AMO requires the declaration.

### Reporting a vulnerability

Please do not open a public issue for security problems. Use
[Security advisories](https://github.com/ArmanAZ44/Avano/security/advisories/new)
or message [@ArmanAZPC](https://t.me/ArmanAZPC) privately on Telegram.

Target first response: 72 hours.

### In scope

- Arbitrary code execution via page content (content script)
- Bypassing `web_accessible_resources` or manifest permissions
- Leaking the API key to the host page or the network

### Out of scope

- Abuse of your own API key, or Google quota limits
- Translation quality or model accuracy
- Behaviour of third-party extensions
